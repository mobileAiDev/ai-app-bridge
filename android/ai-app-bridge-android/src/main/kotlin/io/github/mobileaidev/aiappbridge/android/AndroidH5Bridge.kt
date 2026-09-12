package io.github.mobileaidev.aiappbridge.android

import android.graphics.Rect
import android.os.Process
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.WeakHashMap

// Window selection is shared with Native actions. Document and DOM element
// identities belong to the renderer; neither side may silently select a replacement.
internal class AndroidH5Bridge(
    private val runtimeEpoch: String,
    private val packageName: String,
    private val adapters: () -> List<AiAppBridge.WebViewAdapter>,
    private val foreground: () -> Window,
) {
    data class Window(val root: View, val activity: String, val type: String)
    private data class Target(val window: Window, val view: View, val adapter: AiAppBridge.WebViewAdapter)
    private val identifiers = WeakHashMap<View, String>()
    private fun identifier(view: View) = identifiers.getOrPut(view) { UUID.randomUUID().toString() }

    private fun screenRect(view: View, rect: Rect): Boolean {
        if (!view.getGlobalVisibleRect(rect)) return false
        // getGlobalVisibleRect uses the window root's coordinate space. Dialog
        // windows need their screen offset before comparing DOM action points.
        val origin = IntArray(2).also(view.rootView::getLocationOnScreen)
        rect.offset(origin[0], origin[1])
        return true
    }

    private fun visible(view: View): Boolean {
        if (!view.isAttachedToWindow || !view.isShown || !view.isEnabled || !view.getGlobalVisibleRect(Rect())) return false
        var ancestor: View? = view
        while (ancestor != null) {
            if (ancestor.alpha <= 0f) return false
            ancestor = ancestor.parent as? View
        }
        return true
    }

    private fun select(id: String?): Target {
        val window = foreground()
        val targets = mutableListOf<Target>()
        fun visit(view: View) {
            if (!visible(view)) return
            val adapter = adapters().firstOrNull { it.matches(view) }
            if (adapter != null) { targets.add(Target(window, view, adapter)); return }
            if (view is ViewGroup) for (index in 0 until view.childCount) visit(view.getChildAt(index))
        }
        visit(window.root)
        val matches = if (id == null) targets else targets.filter { identifier(it.view) == id }
        if (matches.size != 1) {
            val candidates = JSONArray(targets.map { it.adapter.metadata(it.view).put("webViewId", identifier(it.view)) })
            throw H5EvaluationFailure(if (matches.isEmpty()) "android_h5_webview_not_found" else "android_h5_webview_ambiguous",
                JSONObject().put("webViews", candidates))
        }
        return matches.single()
    }

    private fun page(target: Target, documentId: String, url: String) = JSONObject()
        .put("schemaVersion", SCHEMA).put("runtimeEpoch", runtimeEpoch).put("packageName", packageName)
        .put("processId", Process.myPid()).put("activity", target.window.activity)
        .put("windowId", identifier(target.window.root)).put("webViewId", identifier(target.view))
        .put("documentId", documentId).put("url", url)

    fun snapshot(id: String?, complete: (JSONObject) -> Unit) {
        try {
            val target = select(id)
            evaluate(target, JSONObject().put("operation", "snapshot").put("seed", UUID.randomUUID().toString())) { reply ->
                if (!reply.optBoolean("ok")) { complete(reply); return@evaluate }
                try {
                    ensureCurrent(target)
                    val dom = reply.getJSONObject("dom")
                    complete(JSONObject().put("ok", true).put("h5TargetSchema", SCHEMA)
                        .put("pageRef", page(target, dom.getString("documentId"), dom.getString("url")))
                        .put("dom", dom).put("activity", target.window.activity)
                        .put("window", JSONObject().put("type", target.window.type).put("id", identifier(target.window.root)))
                        .put("webView", target.adapter.metadata(target.view).put("webViewId", identifier(target.view)))
                        .put("updatedAtMs", System.currentTimeMillis()))
                } catch (error: H5EvaluationFailure) { complete(error.response()) }
                catch (_: Throwable) { complete(h5Failure("invalid_android_h5_snapshot")) }
            }
        } catch (error: H5EvaluationFailure) { complete(error.response()) }
    }

    fun prepare(payload: JSONObject, check: () -> String?): H5Evaluation {
        validate(payload)
        val expected = payload.getJSONObject("pageRef")
        val target = select(expected.getString("webViewId"))
        val actual = page(target, expected.getString("documentId"), expected.getString("url"))
        if (pageFields.any { actual.get(it) != expected.get(it) }) {
            throw H5EvaluationFailure("reobserve_required")
        }
        return H5Evaluation { complete ->
            fun permit(): Boolean {
                try {
                    check()?.let { throw H5EvaluationFailure(it) }
                    ensureCurrent(target)
                    return true
                } catch (error: H5EvaluationFailure) { complete(error.response()); return false }
            }
            if (permit()) {
                val request = JSONObject(payload.toString()).put("operation", "action")
                if (payload.getString("action") in setOf("click", "input")) {
                    evaluate(target, JSONObject(payload.toString()).put("operation", "prepare")) { probe ->
                        if (!probe.optBoolean("ok")) complete(probe)
                        else if (permit()) {
                            val geometry = probe.getJSONObject("geometry")
                            val hit = checkPoint(target, geometry)
                            if (!hit.optBoolean("ok")) complete(hit)
                            else if (permit()) evaluate(target, request.put("geometry", geometry)) { result ->
                                complete(result.put("nativeHit", hit))
                            }
                        }
                    }
                } else {
                    val rect = Rect()
                    screenRect(target.view, rect)
                    if (!ownsPoint(target, rect.centerX(), rect.centerY())) complete(h5Failure("android_h5_native_target_obscured"))
                    else if (permit()) evaluate(target, request, complete)
                }
            }
        }
    }

    private fun ensureCurrent(target: Target) {
        val current = foreground()
        if (current.root !== target.window.root || current.activity != target.window.activity || !visible(target.view)
            || target.view.rootView !== current.root) throw H5EvaluationFailure("reobserve_required")
    }

    @Suppress("DEPRECATION")
    private fun checkPoint(target: Target, geometry: JSONObject): JSONObject {
        val view = target.view as? WebView ?: return h5Failure("android_h5_native_geometry_unsupported")
        var ancestor: View? = view
        while (ancestor != null) {
            if (!ancestor.matrix.isIdentity) return h5Failure("android_h5_native_transform_unsupported")
            ancestor = ancestor.parent as? View
        }
        val values = listOf("x", "y", "width", "height", "scrollX", "scrollY").map { geometry.optDouble(it, Double.NaN) }
        if (values.any { !it.isFinite() } || values[2] <= 0 || values[3] <= 0 || view.scale <= 0f) {
            return h5Failure("android_h5_viewport_invalid")
        }
        val location = IntArray(2).also(view::getLocationOnScreen)
        val x = location[0] + view.paddingLeft + (values[0] + values[4]) * view.scale - view.scrollX
        val y = location[1] + view.paddingTop + (values[1] + values[5]) * view.scale - view.scrollY
        val rect = Rect()
        if (!screenRect(view, rect) || !rect.contains(x.toInt(), y.toInt())) return h5Failure("android_h5_target_outside_native_viewport")
        if (!ownsPoint(target, x.toInt(), y.toInt())) return h5Failure("android_h5_native_target_obscured")
        return JSONObject().put("ok", true).put("point", JSONObject().put("x", x).put("y", y))
            .put("scale", view.scale).put("geometry", geometry)
    }

    private fun ownsPoint(target: Target, x: Int, y: Int): Boolean {
        fun hit(view: View): View? {
            val rect = Rect()
            if (!view.isShown || view.alpha <= 0f || !screenRect(view, rect) || !rect.contains(x, y)) return null
            if (view is ViewGroup) {
                val children = (0 until view.childCount).map { view.getChildAt(it) }
                    .withIndex().sortedWith(compareByDescending<IndexedValue<View>> {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) it.value.z else 0f
                    }.thenByDescending { it.index })
                for (child in children) hit(child.value)?.let { return it }
            }
            return view
        }
        var selected = hit(target.window.root)
        while (selected != null) {
            if (selected === target.view) return true
            selected = selected.parent as? View
        }
        return false
    }

    private fun evaluate(target: Target, request: JSONObject, complete: (JSONObject) -> Unit) {
        H5EvaluationInvocation(complete).run(H5Evaluation { finish ->
          target.adapter.evaluateJavascript(target.view, "(${AndroidH5Renderer.source})($request)") { raw ->
            val result = try {
                JSONObject(raw ?: "null").also { require(it.opt("ok") is Boolean) }
            } catch (_: Throwable) {
                h5Failure("invalid_android_h5_reply").put("dispatched", request.optString("operation") == "action")
                    .put("ambiguous", request.optString("operation") == "action")
            }
            finish(result)
          }
        })
    }

    companion object {
        const val SCHEMA = "aab.android-h5-target/v1"
        private val pageFields = setOf("schemaVersion", "runtimeEpoch", "packageName", "processId", "activity", "windowId", "webViewId", "documentId", "url")
        private val elementFields = setOf("elementId", "tag", "id", "name", "type", "text", "ariaLabel", "href")
        fun validate(payload: JSONObject) {
            val action = payload.opt("action")
            val fields = when (action) {
                "eval" -> setOf("action", "pageRef", "script")
                "scrollBy" -> setOf("action", "pageRef", "deltaX", "deltaY")
                "click", "scroll" -> setOf("action", "pageRef", "element")
                "input" -> setOf("action", "pageRef", "element", "text")
                else -> throw H5EvaluationFailure("invalid_h5_action")
            }
            if (payload.keys().asSequence().toSet() != fields) throw H5EvaluationFailure("invalid_h5_payload")
            val page = payload.optJSONObject("pageRef") ?: throw H5EvaluationFailure("invalid_h5_page_ref")
            if (page.keys().asSequence().toSet() != pageFields || pageFields.filter { it != "processId" }.any {
                page.opt(it) !is String || page.getString(it).isBlank()
            } || page.opt("processId") !is Int || page.getInt("processId") < 1) throw H5EvaluationFailure("invalid_h5_page_ref")
            if (payload.has("element")) {
                val element = payload.optJSONObject("element") ?: throw H5EvaluationFailure("invalid_h5_element_ref")
                if (element.keys().asSequence().toSet() != elementFields || elementFields.any { element.opt(it) !is String }
                    || element.getString("elementId").isBlank()) throw H5EvaluationFailure("invalid_h5_element_ref")
            }
            if (action == "input" && (payload.opt("text") !is String || payload.getString("text").length > 16384)) throw H5EvaluationFailure("invalid_h5_text")
            if (action == "eval" && (payload.opt("script") !is String || payload.getString("script").isBlank())) throw H5EvaluationFailure("invalid_h5_script")
            if (action == "scrollBy" && (listOf("deltaX", "deltaY").any { payload.opt(it) !is Number || !payload.getDouble(it).isFinite() }
                || payload.getDouble("deltaX") == 0.0 && payload.getDouble("deltaY") == 0.0)) throw H5EvaluationFailure("invalid_h5_scroll")
        }
    }
}
