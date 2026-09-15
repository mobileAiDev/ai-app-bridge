package io.github.mobileaidev.aiappbridge.android

import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UiObservationLogicTest {
    @Test
    fun batchedHashPreservesTheOriginalLengthPrefixedEncoding() {
        // Golden SHA-256 from the original byte-at-a-time encoding, including
        // field order, null markers and normalized float strings.
        assertEquals("7659ee3a70d0a18a399faa0c8797a110773fb96bd3981ace27fbb8b7c6b39323",
            fingerprint(alpha = 1f, translationX = 0f).hash)
        val salt = ByteArray(32) { it.toByte() }
        val first = semanticTextFingerprint(salt, "商品🙂".repeat(3000), "描述")
        semanticTextFingerprint(salt, "other", null)
        assertEquals(first, semanticTextFingerprint(salt, "商品🙂".repeat(3000), "描述"))
        assertNotEquals(first, semanticTextFingerprint(salt, "商品🙂".repeat(3000), "述描"))
    }

    @Test
    fun visualPropertyChangeProducesANewFingerprint() {
        val baseline = fingerprint(alpha = 1f, translationX = 0f)
        val animated = fingerprint(alpha = 0.75f, translationX = 12f)

        assertNotEquals(baseline.hash, animated.hash)
    }

    @Test
    fun changedUiBecomesStableOnceAfterTheQuietPeriod() {
        val tracker = UiStabilityTracker(stableAfterMs = 300L)
        val initial = fingerprint(alpha = 1f, translationX = 0f)
        val changed = fingerprint(alpha = 0.8f, translationX = 20f)

        assertNull(tracker.observe(initial, nowMs = 0L))
        assertEquals(UiObservationSignalKind.CHANGED, tracker.observe(changed, nowMs = 100L)?.kind)
        assertNull(tracker.poll(nowMs = 399L))
        assertEquals(UiObservationSignalKind.STABLE, tracker.poll(nowMs = 400L)?.kind)
        assertNull(tracker.poll(nowMs = 800L))
    }

    @Test
    fun uiDiffNamesTheChangedVisualProperties() {
        val baseline = fingerprint(alpha = 1f, translationX = 0f)
        val animated = fingerprint(alpha = 0.75f, translationX = 12f)

        val diff = UiFingerprintDiff.between(baseline, animated, maxChanges = 4)

        assertEquals(1, diff.updatedCount)
        assertEquals(listOf("alpha", "translationX"), diff.changes.single().fields)
        assertEquals(false, diff.semanticChanged)
        assertEquals(true, diff.renderChanged)
    }

    @Test
    fun sameLengthSemanticTextChangeProducesANodeDiffWithoutRetainingText() {
        val salt = ByteArray(32) { index -> (index + 1).toByte() }
        val beforeText = semanticTextFingerprint(salt, text = "20", contentDescription = null)
        val afterText = semanticTextFingerprint(salt, text = "21", contentDescription = null)
        assertNotNull(beforeText)
        assertNotNull(afterText)
        assertEquals(2, beforeText?.length)
        assertEquals(2, afterText?.length)
        assertNotEquals(beforeText?.digest, afterText?.digest)
        assertFalse(beforeText?.digest.orEmpty().contains("20"))

        val baseline = fingerprint(
            alpha = 1f,
            translationX = 0f,
            semanticTextDigest = beforeText?.digest,
            semanticTextLength = beforeText?.length,
        )
        val changed = fingerprint(
            alpha = 1f,
            translationX = 0f,
            semanticTextDigest = afterText?.digest,
            semanticTextLength = afterText?.length,
        )

        val diff = UiFingerprintDiff.between(baseline, changed, maxChanges = 4)

        assertNotEquals(baseline.hash, changed.hash)
        assertEquals(1, diff.updatedCount)
        assertEquals(listOf("semanticText"), diff.changes.single().fields)
        assertEquals(2, diff.changes.single().node.semanticTextLength)
        assertEquals(true, diff.semanticChanged)
        assertEquals(false, diff.renderChanged)
    }

    @Test
    fun emptySemanticTextDoesNotCreateADigest() {
        assertNull(semanticTextFingerprint(ByteArray(32) { 7 }, text = "", contentDescription = null))
    }

    @Test
    fun captureActionContextBindsAndRestoresNestedRuntimeActions() {
        assertNull(CaptureActionContext.currentActionId())
        val restored = CaptureActionContext.withActionId("outer-action") {
            assertEquals("outer-action", CaptureActionContext.currentActionId())
            CaptureActionContext.withActionId("inner-action") {
                assertEquals("inner-action", CaptureActionContext.currentActionId())
            }
            CaptureActionContext.currentActionId()
        }
        assertEquals("outer-action", restored)
        assertNull(CaptureActionContext.currentActionId())
    }

    @Test
    fun captureActionContextCanSurviveOneQueuedMainThreadCallback() {
        var clear: (() -> Unit)? = null

        assertTrue(CaptureActionContext.deferActionId("queued-action") { callback ->
            clear = callback
            true
        })
        assertEquals("queued-action", CaptureActionContext.currentActionId())

        clear?.invoke()
        assertNull(CaptureActionContext.currentActionId())
    }

    private fun fingerprint(
        alpha: Float,
        translationX: Float,
        semanticTextDigest: String? = null,
        semanticTextLength: Int? = null,
    ): UiFingerprint {
        return UiFingerprintAccumulator(renderVersion = 7L).apply {
            addActivity("CheckoutActivity")
            addWindow(
                index = 0,
                type = "activity",
                className = "DecorView",
                bounds = UiBounds(0, 0, 1080, 1920),
                visible = true,
            )
            addNode(
                path = "0/2",
                windowType = "activity",
                className = "android.widget.EditText",
                resourceName = "id/payment_code",
                bounds = UiBounds(40, 300, 1040, 420),
                visible = true,
                enabled = true,
                focused = true,
                selected = false,
                checked = null,
                alpha = alpha,
                translationX = translationX,
                translationY = 0f,
                rotation = 0f,
                inputLength = 4,
                semanticTextDigest = semanticTextDigest,
                semanticTextLength = semanticTextLength,
            )
        }.finish()
    }
}
