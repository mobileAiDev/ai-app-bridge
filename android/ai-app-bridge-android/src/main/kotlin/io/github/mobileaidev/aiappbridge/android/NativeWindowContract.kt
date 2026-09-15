package io.github.mobileaidev.aiappbridge.android

import android.view.WindowManager.LayoutParams
import org.json.JSONObject

// Pointer ownership differs from keyboard focus: a non-focusable popup can
// receive touches while its owning window retains focus.
internal object NativeWindowContract {
    data class Window(
        val windowToken: Any?,
        val layoutToken: Any?,
        val type: Int,
        val displayId: Int,
        val visible: Boolean,
    )

    // Application windows carry the Activity token in LayoutParams. Subwindows
    // carry their parent window's token instead. Neither is keyboard focus.
    fun foregroundIndex(windows: List<Window>, activityIndex: Int): Int {
        val activity = windows.getOrNull(activityIndex) ?: throw NativeTargetFailure("native_window_unavailable")
        fun applicationToken(index: Int, ancestors: Set<Int> = emptySet()): Any {
            if (index in ancestors) throw NativeTargetFailure("native_window_metadata_unavailable")
            val window = windows[index]
            val token = window.layoutToken ?: throw NativeTargetFailure("native_window_metadata_unavailable")
            return when (window.type) {
                in LayoutParams.FIRST_APPLICATION_WINDOW..LayoutParams.LAST_APPLICATION_WINDOW -> token
                in LayoutParams.FIRST_SUB_WINDOW..LayoutParams.LAST_SUB_WINDOW -> {
                    val parent = windows.indices.singleOrNull {
                        windows[it].displayId == window.displayId && windows[it].windowToken == token
                    } ?: throw NativeTargetFailure("native_window_metadata_unavailable")
                    applicationToken(parent, ancestors + index)
                }
                else -> throw NativeTargetFailure("native_window_metadata_unavailable")
            }
        }
        val owner = applicationToken(activityIndex)
        return (windows.lastIndex downTo 0).firstOrNull {
            windows[it].visible && windows[it].displayId == activity.displayId && applicationToken(it) == owner
        } ?: throw NativeTargetFailure("native_window_unavailable")
    }

    // Snapshots publish the same SDK decision consumed by semantic execution
    // and the Host. Missing metadata must never trigger another window guess.
    fun foregroundWindow(tree: JSONObject): JSONObject {
        val windows = tree.optJSONArray("windows") ?: throw NativeTargetFailure("native_windows_unavailable")
        val id = (tree.opt("foregroundWindowId") as? String)?.takeIf { it.isNotBlank() }
            ?: throw NativeTargetFailure("native_window_metadata_unavailable")
        return (0 until windows.length()).map { windows.getJSONObject(it) }.singleOrNull { it.opt("windowId") == id }
            ?: throw NativeTargetFailure("native_window_metadata_unavailable")
    }

    fun pointerError(focused: Boolean, focusable: Boolean, touchable: Boolean, focusOwnerWindowId: String?): String? = when {
        !touchable -> "native_window_not_touchable"
        focused -> null
        !focusable && focusOwnerWindowId != null -> null
        else -> "native_window_not_focused"
    }

    fun requirePointerWindow(window: JSONObject, editable: Boolean = false) {
        if (listOf("focused", "focusable", "touchable").any { window.opt(it) !is Boolean }
            || !window.has("focusOwnerWindowId")
            || !window.isNull("focusOwnerWindowId") && (window.opt("focusOwnerWindowId") !is String || window.getString("focusOwnerWindowId").isBlank())) {
            throw NativeTargetFailure("native_window_metadata_unavailable")
        }
        val owner = if (window.isNull("focusOwnerWindowId")) null else window.getString("focusOwnerWindowId")
        pointerError(window.getBoolean("focused"), window.getBoolean("focusable"), window.getBoolean("touchable"), owner)
            ?.let { throw NativeTargetFailure(it) }
        if (editable && !window.getBoolean("focused")) throw NativeTargetFailure("native_input_window_not_focused")
    }
}
