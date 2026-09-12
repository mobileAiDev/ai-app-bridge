package io.github.mobileaidev.aiappbridge.android

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

internal class NativeTargetFailure(val code: String, val field: String? = null, val dispatched: Boolean = false) : RuntimeException(code) {
    fun response(): JSONObject = JSONObject().put("ok", false).put("error", code)
        .put("message", "Native target validation failed: $code")
        .put("dispatched", dispatched).put("ambiguous", false)
        .apply { if (field != null) put("field", field) }
}

internal data class NativeSelection(val node: JSONObject, val window: JSONObject, val x: Int, val y: Int)

// A target reference binds a View instance and its semantic ancestry to a live
// window/runtime. Geometry is deliberately excluded: layout may move the same
// target, whose current bounds are resolved inside the UI-thread action.
internal object NativeTargetContract {
    const val SCHEMA = "aab.native-target/v1"
    private val refFields = setOf("schemaVersion", "runtimeEpoch", "windowId", "viewId", "guard")
    private val labelFields = setOf("text", "resourceName", "contentDescription")
    private val ancestorFields = setOf("className", "resourceName")

    fun reference(epoch: String, windowId: String, viewId: String, parentGuard: String, node: JSONObject): JSONObject {
        val identity = JSONArray().put(epoch).put(windowId).put(viewId).put(parentGuard)
        for (key in listOf("className", "resourceName", "id", "text", "contentDescription", "editable", "clickable", "longClickable", "checked")) {
            identity.put(node.opt(key) ?: JSONObject.NULL)
        }
        val bytes = MessageDigest.getInstance("SHA-256").digest(identity.toString().toByteArray(Charsets.UTF_8))
        val hex = "0123456789abcdef"
        val digest = CharArray(bytes.size * 2)
        bytes.forEachIndexed { index, byte ->
            val value = byte.toInt() and 0xff
            digest[index * 2] = hex[value ushr 4]
            digest[index * 2 + 1] = hex[value and 15]
        }
        return JSONObject().put("schemaVersion", SCHEMA).put("runtimeEpoch", epoch)
            .put("windowId", windowId).put("viewId", viewId).put("guard", String(digest))
    }

    fun validateRequest(request: JSONObject, input: Boolean, additionalFields: Set<String> = emptySet()) {
        val allowed = setOf("selector", "targetRef", "actionId", "execution") + additionalFields + if (input) setOf("text") else emptySet()
        closed(request, allowed, "")
        objectAt(request, "selector", "selector")
        val ref = objectAt(request, "targetRef", "targetRef")
        closed(ref, refFields, "targetRef")
        for (key in refFields) textAt(ref, key, "targetRef.$key")
        if (ref.getString("schemaVersion") != SCHEMA) fail("native_target_schema_unsupported", "targetRef.schemaVersion")
        if (!Regex("[a-f0-9]{64}").matches(ref.getString("guard"))) fail("invalid_argument", "targetRef.guard")
        if (request.has("actionId")) textAt(request, "actionId", "actionId")
        if (input && request.opt("text") !is String) fail("invalid_argument", "text")
    }

    fun validatePointRequest(request: JSONObject, input: Boolean) {
        closed(request, setOf("x", "y", "actionId", "execution") + if (input) setOf("text") else emptySet(), "")
        if (input && request.opt("text") !is String) fail("invalid_argument", "text")
        if (request.has("actionId")) textAt(request, "actionId", "actionId")
        if (!input || request.has("x") || request.has("y")) {
            for (key in listOf("x", "y")) {
                if (!request.has(key)) fail("missing_argument", key)
                val value = request.opt(key) as? Number ?: fail("invalid_argument", key)
                if (!value.toFloat().isFinite()) fail("invalid_argument", key)
            }
        }
    }

    fun resolve(tree: JSONObject, selector: JSONObject, expected: JSONObject, editable: Boolean): NativeSelection {
        val key = identityKey(selector, labelFields, setOf("within"), "selector")
        val scope = if (selector.has("within")) objectAt(selector, "within", "selector.within") else null
        val anchorKey = scope?.let { identityKey(it, labelFields, setOf("ancestor"), "selector.within") }
        val ancestor = scope?.let { objectAt(it, "ancestor", "selector.within.ancestor") }
        val ancestorKey = ancestor?.let { identityKey(it, ancestorFields, setOf("parent"), "selector.within.ancestor") }
        val parent = ancestor?.let { if (it.has("parent")) objectAt(it, "parent", "selector.within.ancestor.parent") else null }
        val parentKey = parent?.let { identityKey(it, ancestorFields, emptySet(), "selector.within.ancestor.parent") }

        val windows = tree.optJSONArray("windows") ?: fail("native_windows_unavailable")
        val window = (windows.length() - 1 downTo 0).map { windows.getJSONObject(it) }
            .firstOrNull { !hidden(it.optJSONObject("root")) } ?: fail("native_window_unavailable")
        val root = window.optJSONObject("root") ?: fail("native_window_unavailable")
        if (!visible(root) || !boundsValid(window.optJSONObject("bounds"))) fail("native_window_unavailable")
        NativeWindowContract.requirePointerWindow(window, editable)

        data class Candidate(val node: JSONObject, val ancestors: List<JSONObject>, val x: Int, val y: Int)
        val eligible = mutableListOf<Candidate>()
        fun visit(node: JSONObject, ancestors: List<JSONObject>) {
            if (!visible(node)) return
            val bounds = node.optJSONObject("bounds")
            if (boundsValid(bounds)) {
                val x = Math.round((bounds!!.getDouble("left") + bounds.getDouble("right")) / 2).toInt()
                val y = Math.round((bounds.getDouble("top") + bounds.getDouble("bottom")) / 2).toInt()
                if (contains(window.getJSONObject("bounds"), x, y) && ancestors.all { contains(it.optJSONObject("bounds"), x, y) }) {
                    eligible.add(Candidate(node, ancestors, x, y))
                }
            }
            val children = node.optJSONArray("children") ?: return
            for (index in 0 until children.length()) visit(children.getJSONObject(index), ancestors + node)
        }
        visit(root, emptyList())
        val scopeRoot = if (scope != null) {
            val anchors = eligible.filter { it.node.opt(anchorKey!!) == scope.getString(anchorKey) }
            if (anchors.size != 1) fail(if (anchors.isEmpty()) "native_scope_anchor_not_found" else "native_scope_anchor_ambiguous")
            val chain = anchors.single().ancestors
            val roots = chain.filterIndexed { index, node -> node.opt(ancestorKey!!) == ancestor!!.getString(ancestorKey)
                && (parentKey == null || index > 0 && chain[index - 1].opt(parentKey) == parent!!.getString(parentKey)) }
            if (roots.size != 1) fail(if (roots.isEmpty()) "native_scope_ancestor_not_found" else "native_scope_ancestor_ambiguous")
            roots.single()
        } else null
        val matches = eligible.filter { it.node.opt(key) == selector.getString(key)
            && (scopeRoot == null || it.node === scopeRoot || it.ancestors.any { node -> node === scopeRoot }) }
        if (matches.size != 1) fail(if (matches.isEmpty()) "native_selector_not_found" else "native_selector_ambiguous")
        val selected = matches.single()
        if (editable && selected.node.opt("editable") != true) fail("native_target_not_editable")
        val current = selected.node.optJSONObject("targetRef") ?: fail("native_target_reference_unavailable")
        for ((field, code) in listOf("runtimeEpoch" to "native_runtime_changed", "windowId" to "native_window_changed",
            "viewId" to "native_target_replaced", "guard" to "native_target_changed")) {
            if (current.opt(field) != expected.opt(field)) fail(code, "targetRef.$field")
        }
        return NativeSelection(selected.node, window, selected.x, selected.y)
    }

    private fun identityKey(value: JSONObject, identities: Set<String>, extra: Set<String>, field: String): String {
        closed(value, identities + extra, field)
        val keys = identities.filter { value.has(it) }
        if (keys.size != 1) fail("invalid_argument", field)
        textAt(value, keys.single(), "$field.${keys.single()}")
        return keys.single()
    }

    private fun closed(value: JSONObject, fields: Set<String>, prefix: String) {
        val keys = value.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (key !in fields) fail("unsupported_argument", if (prefix.isEmpty()) key else "$prefix.$key")
        }
    }

    private fun objectAt(value: JSONObject, key: String, field: String): JSONObject =
        value.opt(key) as? JSONObject ?: fail(if (value.has(key)) "invalid_argument" else "missing_argument", field)
    private fun textAt(value: JSONObject, key: String, field: String): String =
        (value.opt(key) as? String)?.takeIf { it.isNotEmpty() } ?: fail(if (value.has(key)) "invalid_argument" else "missing_argument", field)
    private fun hidden(node: JSONObject?): Boolean = node != null &&
        (node.opt("effectiveVisible") == false || node.opt("visible") == false || node.opt("visibility") in listOf("gone", "invisible") || node.optDouble("alpha", 1.0) <= 0)
    private fun visible(node: JSONObject): Boolean = !hidden(node) && node.opt("enabled") != false &&
        (node.opt("visible") == true || node.opt("effectiveVisible") == true)
    private fun boundsValid(bounds: JSONObject?): Boolean = bounds != null &&
        listOf("left", "top", "right", "bottom").all { bounds.opt(it) is Number && bounds.getDouble(it).isFinite() } &&
        bounds.getDouble("right") > bounds.getDouble("left") && bounds.getDouble("bottom") > bounds.getDouble("top")
    private fun contains(bounds: JSONObject?, x: Int, y: Int): Boolean = boundsValid(bounds) &&
        x >= bounds!!.getDouble("left") && x < bounds.getDouble("right") && y >= bounds.getDouble("top") && y < bounds.getDouble("bottom")
    private fun fail(code: String, field: String? = null): Nothing = throw NativeTargetFailure(code, field)
}
