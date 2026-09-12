package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativeGestureContractTest {
    private fun request(action: String = "longPress") = JSONObject()
        .put("action", action).put("actionId", "gesture-1").put("durationMs", 600)
        .put("execution", JSONObject().put("timeoutMs", 11500))
        .put("selector", JSONObject().put("text", "Note"))
        .put("targetRef", NativeTargetContract.reference("runtime", "window", "view", "parent", JSONObject()))

    private fun fails(body: JSONObject, code: String, field: String) {
        try { NativeGestureContract.parse(body); fail("Expected $code at $field") }
        catch (failure: NativeTargetFailure) {
            assertEquals(code, failure.code); assertEquals(field, failure.field)
            assertFalse(failure.response().getBoolean("dispatched")); assertFalse(failure.response().getBoolean("ambiguous"))
        }
    }

    @Test fun actionsShareTheSameBoundReferenceAndBudgetContract() {
        assertEquals(11500L, NativeGestureContract.parse(request()).timeoutMs)
        val swipe = NativeGestureContract.parse(request("swipe").put("deltaX", 0).put("deltaY", -12.5).put("durationMs", 1))
        assertEquals(-12.5, swipe.deltaY, 0.0); assertEquals(11500L, swipe.timeoutMs)
        assertEquals("down", NativeGestureContract.parse(request("scroll").put("direction", "down")).direction)
    }

    @Test fun unknownActionsAndFieldsNeverBecomeAnotherGesture() {
        fails(request("drag"), "unsupported_gesture", "action")
        fails(request().put("action", 1), "invalid_argument", "action")
        fails(request().apply { remove("action") }, "missing_argument", "action")
        for (key in listOf("x", "direction", "deltaX", "pressure")) fails(request().put(key, 1), "unsupported_argument", key)
    }

    @Test fun durationsAndTimeoutsAreBoundedIntegersWithoutCoercion() {
        for (value in listOf(499, 10001, 650.5, "650", JSONObject.NULL)) fails(request().put("durationMs", value), "invalid_argument", "durationMs")
        fails(request().apply { getJSONObject("execution").put("timeoutMs", 599) }, "insufficient_gesture_budget", "execution.timeoutMs")
        fails(request().put("timeoutMs", 700), "unsupported_argument", "timeoutMs")
        assertEquals(10000L, NativeGestureContract.parse(request().put("durationMs", 10000)).durationMs)
    }

    @Test fun actionIdentityAndCompleteTargetReferenceAreRequired() {
        fails(request().apply { remove("actionId") }, "missing_argument", "actionId")
        fails(request().put("actionId", ""), "invalid_argument", "actionId")
        fails(request().apply { getJSONObject("targetRef").remove("runtimeEpoch") }, "missing_argument", "targetRef.runtimeEpoch")
    }

    @Test fun swipeAndScrollRequireTheirOwnTypedArguments() {
        fails(request("swipe"), "missing_argument", "deltaX")
        fails(request("swipe").put("deltaX", "0").put("deltaY", 1), "invalid_argument", "deltaX")
        fails(request("scroll").put("direction", "left"), "invalid_argument", "direction")
        fails(request("scroll").put("direction", "down").put("deltaY", 10), "unsupported_argument", "deltaY")
    }

}
