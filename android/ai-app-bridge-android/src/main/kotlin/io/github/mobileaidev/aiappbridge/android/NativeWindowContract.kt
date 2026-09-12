package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject

// Pointer ownership differs from keyboard focus: a non-focusable popup can
// receive touches while its owning window retains focus.
internal object NativeWindowContract {
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
