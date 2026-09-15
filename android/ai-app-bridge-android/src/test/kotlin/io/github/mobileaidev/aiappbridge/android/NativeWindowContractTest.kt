package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativeWindowContractTest {
    private fun window(id: String, token: String?, type: Int = 2, visible: Boolean = true, display: Int = 0) =
        NativeWindowContract.Window(id, token, type, display, visible)

    @Test fun activityDialogsAndNestedPopupsShareActivityOwnershipWithoutSharingWindowTokens() {
        val windows = listOf(window("activity", "app"), window("dialog", "app"),
            window("popup", "dialog", 1000), window("nested-popup", "popup", 1002))
        for (size in 1..windows.size) {
            assertEquals(size - 1, NativeWindowContract.foregroundIndex(windows.take(size), 0))
        }
    }

    @Test fun attachedExitingActivitiesDoNotDisplaceTheCurrentActivityOrItsDialog() {
        val activity = window("current", "app")
        val exiting = window("old", "old-app")
        assertEquals(0, NativeWindowContract.foregroundIndex(listOf(activity, exiting), 0))
        assertEquals(1, NativeWindowContract.foregroundIndex(listOf(activity, window("dialog", "app"), exiting), 0))
        assertEquals(1, NativeWindowContract.foregroundIndex(listOf(exiting, activity), 1))
    }

    @Test fun hiddenWindowsAndOtherDisplaysDoNotDisplaceTheCurrentWindow() {
        assertEquals(0, NativeWindowContract.foregroundIndex(listOf(window("activity", "app"),
            window("hidden", "app", visible = false), window("presentation", "app", display = 1)), 0))
    }

    @Test fun unknownOwnershipCannotExposeTheBackgroundOrGuessFromFocus() {
        for (overlay in listOf(window("missing-token", null), window("missing-parent", "absent", 1000),
            window("system-window", "app", 2038), window("cycle", "cycle", 1000))) {
            val error = runCatching { NativeWindowContract.foregroundIndex(listOf(window("activity", "app"), overlay), 0) }.exceptionOrNull()
            assertEquals("native_window_metadata_unavailable", (error as NativeTargetFailure).code)
        }
        val duplicateParents = listOf(window("activity", "app"), window("same", "app"),
            window("same", "app"), window("popup", "same", 1000))
        val error = runCatching { NativeWindowContract.foregroundIndex(duplicateParents, 0) }.exceptionOrNull()
        assertEquals("native_window_metadata_unavailable", (error as NativeTargetFailure).code)
    }

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
