package io.github.mobileaidev.aiappbridge.android

import android.graphics.Rect
import android.view.InputDevice
import android.view.MotionEvent

// Keep raw coordinates in screen space while dispatching local window coordinates.
internal fun nativeTouchEvent(
    downTime: Long, eventTime: Long, action: Int, screenX: Float, screenY: Float, windowBounds: Rect,
): MotionEvent = MotionEvent.obtain(downTime, eventTime, action, screenX, screenY, 0).apply {
    source = InputDevice.SOURCE_TOUCHSCREEN
    offsetLocation(-windowBounds.left.toFloat(), -windowBounds.top.toFloat())
}
