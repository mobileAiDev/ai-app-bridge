package io.github.mobileaidev.aiappbridge.android.capture

import org.json.JSONObject
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStore
import java.io.File

data class CaptureInput(
    val stream: String,
    val targetKey: String,
    val runtimeEpoch: String,
    val captureId: Long,
    val timestampMs: Long,
    val record: JSONObject,
    val actionId: String? = null,
    val source: String = "sdk",
    val stateKey: String? = null,
)

data class AppendReceipt(
    val status: String,
    val accepted: Boolean,
    val committed: Boolean,
    val dropped: Boolean,
    val deduplicated: Boolean,
    val mobileFactId: String?,
    val reason: String? = null,
)

data class CaptureQuery(
    val view: String,
    val stream: String,
    val sinceId: Long? = null,
    val sinceMs: Long? = null,
    val limit: Int? = null,
    val platform: String = "android",
    val afterActionId: String? = null,
    val cursor: String? = null,
    val runtimeEpoch: String? = null,
    val targetKey: String? = null,
    val mobileFactId: String? = null,
)

data class CaptureCoverage(
    val status: String,
    val gap: Boolean,
    val committed: Boolean,
)

data class CaptureFactRef(
    val mobileFactId: String,
    val stream: String,
    val captureId: Long,
    val targetKey: String? = null,
    val runtimeEpoch: String? = null,
    val capturedAtMs: Long? = null,
)

data class CapturePage(
    val ok: Boolean,
    val type: String,
    val items: List<JSONObject>,
    val count: Int,
    val coverage: CaptureCoverage,
    val gap: Boolean,
    val hasMore: Boolean,
    val refs: List<CaptureFactRef>,
    val values: Map<String, Any?> = emptyMap(),
    val nextCursor: String? = null,
    val watermarkCursor: String? = null,
    val runtimeEpoch: String? = null,
    val targetKey: String? = null,
    val storeGeneration: Long? = null,
    val throughWatermark: Long? = null,
    val reason: String? = null,
    val window: JSONObject? = null,
)

data class CaptureWatermark(
    val streams: Map<String, Long>,
)

data class ClearReceipt(
    val ok: Boolean,
    val generation: Long,
)

data class CaptureStoreStatus(
    val persistent: Boolean,
    val generation: Long,
    val ownedBytes: Long,
    val budgetBytes: Long,
    val dropped: Long,
    val streams: Map<String, StreamStatus>,
)

data class StreamStatus(
    val count: Int,
    val ownedBytes: Long,
    val dropped: Long,
    val gap: Boolean,
)

data class ByteBudgets(
    val logs: Int = 256 * 1024,
    val network: Int = 384 * 1024,
    val events: Int = 256 * 1024,
    val state: Int = 128 * 1024,
) {
    fun total(): Int = logs + network + events + state

    fun forStream(stream: String): Int = when (stream) {
        "logs" -> logs
        "network" -> network
        "events" -> events
        "state" -> state
        else -> 0
    }
}

data class CountCaps(
    val logs: Int = 4096,
    val network: Int = 2048,
    val events: Int = 4096,
    val state: Int = 512,
) {
    fun forStream(stream: String): Int = when (stream) {
        "logs" -> logs
        "network" -> network
        "events" -> events
        "state" -> state
        else -> 0
    }
}

class MobileCaptureStore(
    private val budgets: ByteBudgets = ByteBudgets(),
    private val caps: CountCaps = CountCaps(),
) {
    @Volatile private var backend: CaptureBackend = BoundedMemoryCaptureBackend(budgets, caps)

    /** Called while the mobile store opens. No scans or payload hydration on the App thread. */
    internal fun usePersistentStore(store: SegmentedFactStore, directory: File, targetKey: String, runtimeEpoch: String,
        epochStartSequence: Long, existingRecords: Long = 0) {
        if (backend is SegmentedCaptureBackend) return
        synchronized(lock) {
            if (backend is SegmentedCaptureBackend) return
            val startup = backend as BoundedMemoryCaptureBackend
            val pending = startup.pendingRecords()
            require(pending.all { it.targetKey == targetKey && it.runtimeEpoch == runtimeEpoch }) {
                "capture_startup_identity_mismatch"
            }
            val persistent = SegmentedCaptureBackend(store, directory, targetKey, runtimeEpoch, epochStartSequence, budgets, caps,
                initialLossStreams = startup.status().streams.filterValues { it.gap }.keys, existingRecords = existingRecords)
            // This callback runs on the writer. Enqueue without awaiting that same writer; its
            // query barrier proves commitment, and rejected appends retain their stream loss fence.
            pending.forEach { persistent.append(it, "async") }
            backend = persistent
        }
    }

    internal fun detachPersistentStore() {
        synchronized(lock) { backend = BoundedMemoryCaptureBackend(budgets, caps) }
    }
    private val lock = Any()

    fun append(record: CaptureInput, durability: String = "async"): AppendReceipt =
        synchronized(lock) { backend.append(record, durability) }

    fun mark(streams: List<String>): CaptureWatermark =
        synchronized(lock) { backend.mark(streams) }

    fun query(query: CaptureQuery): CapturePage {
        val selected = backend
        // Disk reads must not hold the App callback lock. The backend validates its generation
        // again at the end, so concurrent clear yields an explicit unavailable page.
        return if (selected is SegmentedCaptureBackend) selected.query(query)
        else synchronized(lock) { backend.query(query) }
    }

    fun status(): CaptureStoreStatus =
        synchronized(lock) { backend.status() }

    fun clear(scope: String = "all"): ClearReceipt =
        synchronized(lock) { backend.clear(scope) }
}

internal interface CaptureBackend {
    fun append(record: CaptureInput, durability: String): AppendReceipt
    fun mark(streams: List<String>): CaptureWatermark
    fun query(query: CaptureQuery): CapturePage
    fun status(): CaptureStoreStatus
    fun clear(scope: String): ClearReceipt
}
