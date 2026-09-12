package io.github.mobileaidev.aiappbridge.android

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativeTargetContractTest {
    private val selector get() = JSONObject().put("resourceName", "id/editor")
    private fun bounds(left: Int = 0, top: Int = 0, right: Int = 300, bottom: Int = 500) =
        JSONObject().put("left", left).put("top", top).put("right", right).put("bottom", bottom)
    private fun node(id: String, text: String = "", editable: Boolean = false) = JSONObject()
        .put("resourceName", id).put("className", if (editable) "EditText" else "View")
        .put("text", text).put("editable", editable).put("visible", true).put("enabled", true)
        .put("bounds", bounds()).put("children", JSONArray())
    private fun editor() = node("id/editor", "Before", true).put("bounds", bounds(20, 40, 120, 100))
    private fun tree(vararg children: JSONObject, windowId: String = "window", epoch: String = "epoch"): JSONObject {
        val root = node("id/root").put("children", JSONArray(children))
        annotate(root, epoch, windowId, windowId)
        return JSONObject().put("windows", JSONArray().put(JSONObject().put("focused", true)
            .put("focusable", true).put("touchable", true).put("focusOwnerWindowId", windowId)
            .put("windowId", windowId).put("bounds", bounds()).put("root", root)))
    }
    private fun annotate(node: JSONObject, epoch: String, window: String, parent: String) {
        val ref = NativeTargetContract.reference(epoch, window, node.optString("instance", node.getString("resourceName")), parent, node)
        node.put("targetRef", ref)
        val children = node.getJSONArray("children")
        for (index in 0 until children.length()) annotate(children.getJSONObject(index), epoch, window, ref.getString("guard"))
    }
    private fun ref(node: JSONObject) = node.getJSONObject("targetRef")
    private fun resolve(tree: JSONObject, expected: JSONObject, selector: JSONObject = this.selector, editable: Boolean = true) =
        NativeTargetContract.resolve(tree, selector, expected, editable)
    private fun fails(code: String, block: () -> Unit): NativeTargetFailure {
        try { block(); fail("Expected $code") } catch (failure: NativeTargetFailure) {
            assertEquals(code, failure.code)
            assertFalse(failure.response().getBoolean("dispatched"))
            assertFalse(failure.response().getBoolean("ambiguous"))
            return failure
        }
        error("unreachable")
    }

    @Test fun sameViewLayoutMovementUsesTheCurrentPoint() {
        val old = editor(); tree(old)
        val current = editor().put("bounds", bounds(60, 200, 200, 300))
        val selected = resolve(tree(current), ref(old))
        assertEquals(130, selected.x); assertEquals(250, selected.y)
        assertEquals(ref(old).toString(), ref(current).toString())
    }

    @Test fun identicalLabelOnReplacementViewIsNotTheObservedTarget() {
        val old = editor(); tree(old)
        val current = editor().put("instance", "replacement")
        fails("native_target_replaced") { resolve(tree(current), ref(old)) }
    }

    @Test fun changedRuntimeOrWindowRejectsEvenWithIdenticalControls() {
        val old = editor(); tree(old)
        fails("native_runtime_changed") { resolve(tree(editor(), epoch = "restarted"), ref(old)) }
        fails("native_window_changed") { resolve(tree(editor(), windowId = "new-window"), ref(old)) }
    }

    @Test fun semanticChangeAndReparentingInvalidateAnObservedView() {
        val old = editor(); tree(old)
        fails("native_target_changed") { resolve(tree(editor().put("text", "Different note")), ref(old)) }
        val group = node("id/other-group").put("children", JSONArray().put(editor()))
        fails("native_target_changed") { resolve(tree(group), ref(old)) }
    }

    @Test fun duplicatedLabelsAndReadOnlyEditorsNeverResolve() {
        val old = editor(); tree(old)
        fails("native_selector_ambiguous") { resolve(tree(editor(), editor()), ref(old)) }
        fails("native_target_not_editable") { resolve(tree(editor().put("editable", false)), ref(old)) }
    }

    @Test fun nativeFocusIsRequiredAndAForegroundDialogBlocksTheActivity() {
        val old = editor(); val snapshot = tree(old)
        snapshot.getJSONArray("windows").getJSONObject(0).put("focused", false)
        fails("native_window_not_focused") { resolve(snapshot, ref(old)) }
        snapshot.getJSONArray("windows").put(tree(node("id/dialog")).getJSONArray("windows").getJSONObject(0))
        fails("native_selector_not_found") { resolve(snapshot, ref(old)) }
        snapshot.getJSONArray("windows").put(JSONObject().put("root", JSONObject()))
        fails("native_window_unavailable") { resolve(snapshot, ref(old)) }
    }

    @Test fun clippedOrDisabledAncestorsExcludeTheControl() {
        val old = editor(); tree(old)
        for (group in listOf(node("id/clip").put("bounds", bounds(0, 150, 300, 500)), node("id/disabled").put("enabled", false))) {
            group.put("children", JSONArray().put(editor()))
            fails("native_selector_not_found") { resolve(tree(group), ref(old)) }
        }
    }

    @Test fun scopedSelectionResolvesOneAnchoredRowAndCarriesItsAncestry() {
        val first = editor(); val second = editor().put("instance", "other-editor")
        fun row(label: String, field: JSONObject) = node("id/row").put("className", "Row")
            .put("children", JSONArray().put(node("id/label-$label", label)).put(field))
        val snapshot = tree(row("One", first), row("Two", second))
        val scoped = selector.put("within", JSONObject().put("text", "Two")
            .put("ancestor", JSONObject().put("className", "Row").put("parent", JSONObject().put("resourceName", "id/root"))))
        assertSame(second, resolve(snapshot, ref(second), scoped).node)
        fails("native_target_replaced") { resolve(snapshot, ref(first), scoped) }
        scoped.getJSONObject("within").put("text", "Absent")
        fails("native_scope_anchor_not_found") { resolve(snapshot, ref(second), scoped) }
    }

    @Test fun semanticRequestsAreClosedAndRequireACompleteReference() {
        val current = editor(); tree(current)
        val request = JSONObject().put("selector", selector).put("targetRef", ref(current)).put("text", "")
        NativeTargetContract.validateRequest(request, true)
        fails("unsupported_argument") { NativeTargetContract.validateRequest(JSONObject(request.toString()).put("x", 30), true) }
        fails("invalid_argument") { NativeTargetContract.validateRequest(JSONObject(request.toString()).put("text", 17), true) }
        val missing = JSONObject(request.toString()); missing.getJSONObject("targetRef").remove("viewId")
        assertEquals("targetRef.viewId", fails("missing_argument") { NativeTargetContract.validateRequest(missing, true) }.field)
        val version = JSONObject(request.toString()); version.getJSONObject("targetRef").put("schemaVersion", "v0")
        fails("native_target_schema_unsupported") { NativeTargetContract.validateRequest(version, true) }
        fails("unsupported_argument") { resolve(tree(editor()), ref(current), JSONObject().put("text", "Before").put("index", 0)) }
    }

    @Test fun coordinateAndSemanticEndpointsCannotAcceptEachOthersPayloadsOrCoerceNumbers() {
        NativeTargetContract.validatePointRequest(JSONObject().put("x", 10).put("y", 20), false)
        NativeTargetContract.validatePointRequest(JSONObject().put("text", ""), true)
        fails("invalid_argument") { NativeTargetContract.validatePointRequest(JSONObject().put("x", "10").put("y", 20), false) }
        fails("missing_argument") { NativeTargetContract.validatePointRequest(JSONObject().put("text", "x").put("x", 10), true) }
        fails("unsupported_argument") { NativeTargetContract.validatePointRequest(JSONObject().put("selector", selector).put("text", "x"), true) }
        fails("missing_argument") { NativeTargetContract.validateRequest(JSONObject().put("text", "x"), true) }
    }
}
