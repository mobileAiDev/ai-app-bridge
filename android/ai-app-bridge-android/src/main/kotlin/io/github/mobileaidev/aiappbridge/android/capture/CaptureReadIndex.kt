package io.github.mobileaidev.aiappbridge.android.capture

import java.util.ArrayDeque

/** Current-attachment prefix bounds, not a payload cache. Accessed under the backend metadata lock. */
internal class CaptureReadIndex(private val epochStartSequence: Long) {
    private data class Prefix(val sequence: Long, val timestampMs: Long, val captureId: Long) {
        fun excludedBy(sinceMs: Long?, sinceId: Long?) =
            (sinceMs != null && timestampMs < sinceMs) || (sinceId != null && captureId <= sinceId)
    }

    private val prefixes = ArrayDeque<Prefix>()
    private var latest = Prefix(epochStartSequence, Long.MIN_VALUE, 0)
    private var count = 0
    private var bytes = 0
    val captureWatermark: Long get() = latest.captureId

    fun committed(sequence: Long, timestampMs: Long, captureId: Long, payloadBytes: Int) {
        // Prefix maxima remain safe when producer clocks or capture IDs move backwards.
        latest = Prefix(sequence, maxOf(latest.timestampMs, timestampMs), maxOf(latest.captureId, captureId))
        bytes += payloadBytes
        if (++count == RECORDS_PER_PREFIX || bytes >= BYTES_PER_PREFIX) {
            prefixes.addLast(latest)
            if (prefixes.size > MAX_PREFIXES) prefixes.removeFirst()
            count = 0
            bytes = 0
        }
    }

    /** Called at a writer barrier: no later commit is included in throughSequence or these bounds. */
    fun skipThrough(sinceMs: Long?, sinceId: Long?, throughSequence: Long): Long {
        // Includes streams with no capture facts: ordinary shared-partition records cannot match.
        if (latest.excludedBy(sinceMs, sinceId)) return throughSequence
        return prefixes.descendingIterator().asSequence()
            .firstOrNull { it.excludedBy(sinceMs, sinceId) }?.sequence ?: epochStartSequence
    }

    companion object {
        private const val RECORDS_PER_PREFIX = 128
        private const val BYTES_PER_PREFIX = 64 * 1024
        private const val MAX_PREFIXES = 512
    }
}
