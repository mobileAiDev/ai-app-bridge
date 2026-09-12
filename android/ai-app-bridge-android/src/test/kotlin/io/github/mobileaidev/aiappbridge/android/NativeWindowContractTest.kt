package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativeWindowContractTest {
    private fun popup() = JSONObject().put("focused", false).put("focusable", false)
        .put("touchable", true).put("focusOwnerWindowId", "current-owner")

    @Test fun touchablePopupUsesItsFocusedOwnerWithoutClaimingKeyboardFocus() {
        NativeWindowContract.requirePointerWindow(popup())
        val error = runCatching { NativeWindowContract.requirePointerWindow(popup(), editable = true) }.exceptionOrNull()
        assertEquals("native_input_window_not_focused", (error as NativeTargetFailure).code)
    }

    @Test fun inactiveWindowsAndNonTouchableOverlaysRemainClosed() {
        for ((window, code) in listOf(
            popup().put("focusOwnerWindowId", JSONObject.NULL) to "native_window_not_focused",
            popup().put("focusable", true) to "native_window_not_focused",
            popup().put("touchable", false) to "native_window_not_touchable",
            popup().put("focused", true).put("touchable", false) to "native_window_not_touchable",
        )) {
            val error = runCatching { NativeWindowContract.requirePointerWindow(window) }.exceptionOrNull()
            assertEquals(code, (error as NativeTargetFailure).code)
        }
    }

    @Test fun missingOrCoercedWindowMetadataIsNotAReadyWindow() {
        for (window in listOf(JSONObject().put("focused", true), popup().put("touchable", "true"))) {
            val error = runCatching { NativeWindowContract.requirePointerWindow(window) }.exceptionOrNull()
            assertEquals("native_window_metadata_unavailable", (error as NativeTargetFailure).code)
        }
    }
}
