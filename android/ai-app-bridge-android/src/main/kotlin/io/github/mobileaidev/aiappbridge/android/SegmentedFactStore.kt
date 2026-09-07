package io.github.mobileaidev.aiappbridge.android

import android.content.Context
import android.os.Build
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.OverlappingFileLockException
import java.util.ArrayDeque
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

internal object SegmentedFactStoreResultCode {
    const val OK = 0
    const val END = 1
    const val BUFFER_TOO_SMALL = 2
    const val INVALID_ARGUMENT = -1
    const val IO = -2
    const val FORMAT_VERSION = -3
    const val CORRUPT = -4
    const val FULL = -5
    const val BUSY = -6
    const val NO_MEMORY = -7
    const val CLOSED = -8
    const val PARTITION_DISABLED = -9
}

internal enum class SegmentedFactStoreDurability(internal val nativeValue: Int) {
    MEMORY(0),
    SYNC(1),
}

internal enum class SegmentedFactStoreState {
    CLOSED,
    DISABLED,
    OPENING,
    OPEN,
    CLOSING,
    FAILED,
}

internal enum class SegmentedFactRecordEnqueueResult {
    ACCEPTED,
    DISABLED,
    CLOSED,
    QUEUE_FULL,
    PAYLOAD_TOO_LARGE,
}

internal data class SegmentedFactStoreOptions(
    val directory: File,
    val segmentSizeBytes: Long = 1024L * 1024L,
    val flags: Int = 1,
    val partitionQuotas: LongArray = longArrayOf(8L * 1024L * 1024L),
    val enabled: Boolean = true,
    val receiveObservationFacts: Boolean = true,
)

internal data class SegmentedFactStoreCursor(
    val partitionId: Int = -1,
    val flags: Int = 0,
    val afterSequence: Long = 0,
    val segmentId: Long = 0,
    val offset: Long = 0,
)

internal data class SegmentedFactStoreRecord(
    val payload: ByteArray,
    val payloadLength: Int,
    val partitionId: Int,
    val flags: Int,
    val sequence: Long,
    val segmentId: Long,
    val frameOffset: Long,
    val gapFirstSequence: Long,
    val gapLastSequence: Long,
)

internal data class SegmentedFactStoreOperationResult(
    val code: Int,
    val systemCode: Int = 0,
    val message: String = "",
) {
    val isSuccess: Boolean get() = code == SegmentedFactStoreResultCode.OK
}

internal data class SegmentedFactStoreReadResult(
    val operation: SegmentedFactStoreOperationResult,
    val cursor: SegmentedFactStoreCursor,
    val record: SegmentedFactStoreRecord? = null,
    val requiredCapacity: Int = 0,
) {
    val isEnd: Boolean get() = operation.code == SegmentedFactStoreResultCode.END
}

internal data class SegmentedFactStoreStatus(
    val operation: SegmentedFactStoreOperationResult,
    val state: SegmentedFactStoreState,
    val enabled: Boolean,
    val queuedRecords: Int,
    val acceptedRecords: Long,
    val writtenRecords: Long,
    val droppedRecords: Long,
    val formatVersion: Int = 0,
    val recoveredTail: Boolean = false,
    val segmentSizeBytes: Long = 0,
    val segmentCount: Long = 0,
    val firstSegmentId: Long = 0,
    val activeSegmentId: Long = 0,
    val activeWriteOffset: Long = 0,
    val recordCount: Long = 0,
    val payloadBytes: Long = 0,
    val nextSequence: Long = 0,
    val recoveryPartitionId: Int = 0,
    val recoverySegmentId: Long = 0,
    val recoveryOffset: Long = 0,
    val recoveryDiscardedBytes: Long = 0,
    val cleanupPending: Boolean = false,
    val inactiveBytes: Long = 0,
    val cleanupError: String? = null,
    val queuedPayloadBytes: Long = 0,
)

/**
 * Asynchronous mobile adapter for the portable segmented fact store.
 *
 * All native calls run on one background writer. [record] copies normal facts and performs only
 * bounded in-memory JSON/SHA/chunk preflight for a large fact before enqueueing it; UI and observer
 * callbacks never perform file or mmap work. Completion callbacks run on the writer.
 */
internal class SegmentedFactStore internal constructor(
    private val nativeFactory: () -> SegmentedFactStoreNative,
    private val writer: ExecutorService,
    private val maxQueuedRecords: Int,
    private val flushScheduler: ScheduledExecutorService = newFlushScheduler(),
    private val flushIntervalMs: Long = GROUP_FLUSH_INTERVAL_MS,
    private val maxUnflushedRecords: Int = GROUP_FLUSH_RECORD_LIMIT,
    private val maxQueuedPayloadBytes: Long = 1024L * 1024,
) {
    constructor(maxQueuedRecords: Int = 256) : this(
        nativeFactory = { MappedSegmentedFactStore() },
        writer = Executors.newSingleThreadExecutor { task ->
            Thread(task, "ai-app-bridge-fact-writer").apply { isDaemon = true }
        },
        maxQueuedRecords = maxQueuedRecords,
    )

    companion object {
        const val MAX_PERSISTED_PAYLOAD_BYTES = 1024 * 1024
        const val GROUP_FLUSH_INTERVAL_MS = 2_000L
        const val GROUP_FLUSH_RECORD_LIMIT = 64
        private const val DEFAULT_SEGMENT_SIZE_BYTES = 1024L * 1024L
        private const val NATIVE_SEGMENT_HEADER_BYTES = 64L
        private const val NATIVE_FRAME_PREFIX_BYTES = 24L
        private const val NATIVE_FRAME_COMMIT_BYTES = 8L
        private const val RECORD_GAP_BEFORE = 1
        val shared: SegmentedFactStore by lazy { SegmentedFactStore() }

        private fun newFlushScheduler(): ScheduledExecutorService =
            Executors.newSingleThreadScheduledExecutor { task ->
                Thread(task, "ai-app-bridge-fact-flush").apply { isDaemon = true }
            }
    }

    private val lock = Any()
    private val recordPermits = Semaphore(maxQueuedRecords)
    private val queuedPayloadBytes = AtomicLong(0)
    private val acceptedRecords = AtomicLong(0)
    private val writtenRecords = AtomicLong(0)
    private val droppedRecords = AtomicLong(0)
    private val receiptOutcomes = ArrayDeque<Boolean>()
    private var state = SegmentedFactStoreState.CLOSED
    private var native: SegmentedFactStoreNative? = null
    private var handle = 0L
    private var enabled = false
    private var receiveObservationFacts = false
    private var lastOperation = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.CLOSED)
    private var unflushedRecords = 0
    private var flushTask: ScheduledFuture<*>? = null
    private var profileCleanupPending = false
    private var inactiveProfileBytes = 0L
    private var profileCleanupError: String? = null
    private var mobileProfileCleanupPlan: MobileProfileCleanupPlan? = null
    private var configuredSegmentSizeBytes = DEFAULT_SEGMENT_SIZE_BYTES
    private var configuredPartitionQuotas = LongArray(0)

    init {
        require(maxQueuedPayloadBytes > 0) { "maxQueuedPayloadBytes must be positive" }
        require(maxQueuedRecords > 0) { "maxQueuedRecords must be positive" }
        require(flushIntervalMs > 0L) { "flushIntervalMs must be positive" }
        require(maxUnflushedRecords > 0) { "maxUnflushedRecords must be positive" }
    }

    @JvmOverloads
    fun open(
        options: SegmentedFactStoreOptions,
        completion: (SegmentedFactStoreOperationResult) -> Unit = {},
    ) = openInternal(options, cleanupPlan = null, completion)

    internal fun openMobileProfile(
        configuration: MobileFactStoreConfiguration,
        completion: (SegmentedFactStoreOperationResult) -> Unit,
    ) = openInternal(
        options = configuration.options,
        cleanupPlan = MobileProfileCleanupPlan(
            baseDirectory = configuration.options.directory.parentFile,
            activeProfile = configuration.profile,
            selectedDirectory = configuration.options.directory,
        ),
        completion = completion,
    )

    private fun openInternal(
        options: SegmentedFactStoreOptions,
        cleanupPlan: MobileProfileCleanupPlan?,
        completion: (SegmentedFactStoreOperationResult) -> Unit,
    ) {
        require(options.segmentSizeBytes >= 0) { "segmentSizeBytes must not be negative" }
        require(options.partitionQuotas.size <= 8) { "at most 8 partition quotas are supported" }
        require(options.partitionQuotas.all { it >= 0 }) { "partition quotas must not be negative" }
        val shouldOpen = synchronized(lock) {
            when (state) {
                SegmentedFactStoreState.OPENING,
                SegmentedFactStoreState.OPEN,
                SegmentedFactStoreState.CLOSING,
                -> false

                else -> {
                    enabled = options.enabled
                    receiveObservationFacts = options.receiveObservationFacts
                    configuredSegmentSizeBytes = options.segmentSizeBytes.takeIf { it > 0 }
                        ?: DEFAULT_SEGMENT_SIZE_BYTES
                    configuredPartitionQuotas = options.partitionQuotas.copyOf()
                    profileCleanupPending = cleanupPlan != null
                    inactiveProfileBytes = 0L
                    profileCleanupError = null
                    mobileProfileCleanupPlan = cleanupPlan
                    state = if (options.enabled) {
                        SegmentedFactStoreState.OPENING
                    } else {
                        SegmentedFactStoreState.DISABLED
                    }
                    true
                }
            }
        }
        if (!shouldOpen) {
            completion(
                SegmentedFactStoreOperationResult(
                    SegmentedFactStoreResultCode.INVALID_ARGUMENT,
                    message = "fact store is already opening, open, or closing",
                ),
            )
            return
        }
        if (!options.enabled) {
            val result = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK)
            synchronized(lock) { lastOperation = result }
            if (cleanupPlan != null) {
                writer.execute { cleanInactiveMobileProfiles(cleanupPlan) }
            }
            completion(result)
            return
        }
        if (options.receiveObservationFacts) {
            AndroidObservationFactStoreRegistry.attach(this)
        }

        writer.execute {
            val result = try {
                val adapter = native ?: nativeFactory().also { native = it }
                adapter.open(
                    directory = options.directory.absolutePath,
                    segmentSizeBytes = options.segmentSizeBytes,
                    flags = options.flags,
                    partitionQuotas = options.partitionQuotas.copyOf(),
                )
            } catch (error: Throwable) {
                NativeOpenResult(nativeFailure(error), handle = 0L)
            }
            val geometry = if (result.operation.isSuccess) {
                try {
                    native?.geometry(result.handle)
                } catch (_: Throwable) {
                    null
                }
            } else {
                null
            }
            val closePending = synchronized(lock) {
                lastOperation = result.operation
                if (result.operation.isSuccess) {
                    handle = result.handle
                    if (geometry?.operation?.isSuccess == true) {
                        if (geometry.segmentSizeBytes > 0L) {
                            configuredSegmentSizeBytes = geometry.segmentSizeBytes
                        }
                        if (geometry.partitionQuotas.isNotEmpty()) {
                            configuredPartitionQuotas = geometry.partitionQuotas.copyOf()
                        }
                    }
                    if (state != SegmentedFactStoreState.CLOSING) {
                        state = SegmentedFactStoreState.OPEN
                    }
                } else {
                    handle = 0L
                    state = SegmentedFactStoreState.FAILED
                }
                state == SegmentedFactStoreState.CLOSING
            }
            if (result.operation.isSuccess && receiveObservationFacts && !closePending) {
                AndroidObservationFactStoreRegistry.attach(this)
            } else if (!result.operation.isSuccess) {
                AndroidObservationFactStoreRegistry.detach(this)
            }
            if (result.operation.isSuccess && !closePending) {
                startGroupFlushOnWriter()
            }
            if (cleanupPlan != null) {
                if (result.operation.isSuccess) {
                    // Queue cleanup behind the successful open on the same fact writer. This keeps
                    // directory scans and deletion off App/observer threads and orders a following
                    // close behind cleanup when it is requested from the completion callback.
                    writer.execute { cleanInactiveMobileProfiles(cleanupPlan) }
                } else {
                    synchronized(lock) { profileCleanupPending = false }
                }
            }
            completion(result.operation)
        }
    }

    @JvmOverloads
    fun record(
        payload: ByteArray,
        partitionId: Int = 0,
        durability: SegmentedFactStoreDurability = SegmentedFactStoreDurability.MEMORY,
    ): SegmentedFactRecordEnqueueResult {
        return enqueueRecord(payload, partitionId, durability, trackReceiptOutcome = false)
    }

    internal fun recordForReceipt(
        payload: ByteArray,
        partitionId: Int = 0,
        durability: SegmentedFactStoreDurability = SegmentedFactStoreDurability.MEMORY,
    ): SegmentedFactRecordEnqueueResult {
        return enqueueRecord(payload, partitionId, durability, trackReceiptOutcome = true)
    }

    /** Completion contains the actual native append identity, on the writer after read visibility. */
    internal fun appendWithReceipt(
        payload: ByteArray,
        partitionId: Int,
        durability: SegmentedFactStoreDurability,
        completion: (NativeAppendResult) -> Unit,
    ): SegmentedFactRecordEnqueueResult = enqueueRecord(
        payload, partitionId, durability, trackReceiptOutcome = false, completion = completion,
    )

    internal fun takeReceiptOutcomes(): List<Boolean> {
        synchronized(lock) {
            if (receiptOutcomes.isEmpty()) return emptyList()
            val taken = receiptOutcomes.toList()
            receiptOutcomes.clear()
            return taken
        }
    }

    private fun offerReceiptOutcome(track: Boolean, success: Boolean) {
        if (!track) return
        synchronized(lock) { receiptOutcomes.addLast(success) }
    }

    private fun enqueueRecord(
        payload: ByteArray,
        partitionId: Int,
        durability: SegmentedFactStoreDurability,
        trackReceiptOutcome: Boolean,
        completion: ((NativeAppendResult) -> Unit)? = null,
    ): SegmentedFactRecordEnqueueResult {
        val configuration = synchronized(lock) {
            RecordConfiguration(state, configuredSegmentSizeBytes, configuredPartitionQuotas.copyOf())
        }
        if (configuration.state == SegmentedFactStoreState.DISABLED) {
            return SegmentedFactRecordEnqueueResult.DISABLED
        }
        if (configuration.state != SegmentedFactStoreState.OPENING &&
            configuration.state != SegmentedFactStoreState.OPEN) {
            return SegmentedFactRecordEnqueueResult.CLOSED
        }
        if (payload.size > MAX_PERSISTED_PAYLOAD_BYTES) {
            droppedRecords.incrementAndGet()
            return SegmentedFactRecordEnqueueResult.PAYLOAD_TOO_LARGE
        }
        val maxNativePayload = maximumNativePayload(configuration.segmentSizeBytes)
        val largePlan = if (payload.size.toLong() > maxNativePayload) {
            try {
                createLargeFactPlan(payload, partitionId, configuration)
            } catch (_: Exception) {
                droppedRecords.incrementAndGet()
                return SegmentedFactRecordEnqueueResult.PAYLOAD_TOO_LARGE
            }
        } else {
            null
        }
        if (!recordPermits.tryAcquire()) {
            droppedRecords.incrementAndGet()
            return SegmentedFactRecordEnqueueResult.QUEUE_FULL
        }
        val ownedByteCount = payload.size.toLong()
        while (true) {
            val queued = queuedPayloadBytes.get()
            if (ownedByteCount > maxQueuedPayloadBytes - queued) {
                recordPermits.release()
                droppedRecords.incrementAndGet()
                return SegmentedFactRecordEnqueueResult.QUEUE_FULL
            }
            if (queuedPayloadBytes.compareAndSet(queued, queued + ownedByteCount)) break
        }
        val ownedPayload = if (largePlan == null) payload.copyOf() else null
        acceptedRecords.incrementAndGet()
        writer.execute {
            try {
                val currentHandle = synchronized(lock) { handle }
                val adapter = native
                if (currentHandle == 0L || adapter == null) {
                    droppedRecords.incrementAndGet()
                    offerReceiptOutcome(trackReceiptOutcome, false)
                    completion?.invoke(NativeAppendResult(SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.CLOSED), 0))
                    return@execute
                }
                val result = if (largePlan == null) {
                    adapter.append(
                        handle = currentHandle,
                        partitionId = partitionId,
                        payload = requireNotNull(ownedPayload),
                        durability = durability.nativeValue,
                    )
                } else {
                    appendLargeFact(adapter, currentHandle, partitionId, durability, largePlan)
                }
                synchronized(lock) { lastOperation = result.operation }
                if (result.operation.isSuccess) {
                    writtenRecords.incrementAndGet()
                    unflushedRecords += 1
                    if (unflushedRecords >= maxUnflushedRecords) {
                        flushPendingOnWriter(adapter, currentHandle)
                    }
                    offerReceiptOutcome(trackReceiptOutcome, true)
                } else {
                    droppedRecords.incrementAndGet()
                    offerReceiptOutcome(trackReceiptOutcome, false)
                }
                completion?.invoke(result)
            } catch (error: Throwable) {
                synchronized(lock) { lastOperation = nativeFailure(error) }
                droppedRecords.incrementAndGet()
                offerReceiptOutcome(trackReceiptOutcome, false)
                completion?.invoke(NativeAppendResult(nativeFailure(error), 0))
            } finally {
                queuedPayloadBytes.addAndGet(-ownedByteCount)
                recordPermits.release()
            }
        }
        return SegmentedFactRecordEnqueueResult.ACCEPTED
    }

    @JvmOverloads
    fun read(
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int = 64 * 1024,
        completion: (SegmentedFactStoreReadResult) -> Unit,
    ) {
        require(bufferCapacity >= 0) { "bufferCapacity must not be negative" }
        writer.execute {
            val currentHandle = synchronized(lock) { handle }
            val adapter = native
            if (currentHandle == 0L || adapter == null) {
                completion(closedRead(cursor))
                return@execute
            }
            completion(readLogical(adapter, currentHandle, cursor, bufferCapacity))
        }
    }

    /** A bounded scan on the existing writer; no retained payload index or per-record thread hops. */
    internal fun readPage(
        cursor: SegmentedFactStoreCursor,
        maxRecords: Int = 128,
        maxBytes: Int = 256 * 1024,
        completion: (List<SegmentedFactStoreRecord>, SegmentedFactStoreReadResult) -> Unit,
    ) {
        require(maxRecords > 0 && maxBytes > 0)
        writer.execute {
            val currentHandle = synchronized(lock) { handle }
            val adapter = native
            if (currentHandle == 0L || adapter == null) {
                completion(emptyList(), closedRead(cursor))
                return@execute
            }
            val records = ArrayList<SegmentedFactStoreRecord>()
            var next = cursor
            var bytes = 0
            var result: SegmentedFactStoreReadResult
            do {
                result = readLogical(adapter, currentHandle, next, minOf(maxBytes, 64 * 1024))
                if (result.operation.code == SegmentedFactStoreResultCode.BUFFER_TOO_SMALL &&
                    result.requiredCapacity in 1..MAX_PERSISTED_PAYLOAD_BYTES) {
                    result = readLogical(adapter, currentHandle, next, result.requiredCapacity)
                }
                val record = result.record
                if (!result.operation.isSuccess || record == null) break
                records.add(record)
                bytes += record.payload.size
                next = result.cursor
            } while (records.size < maxRecords && bytes < maxBytes)
            completion(records, result)
        }
    }

    fun flush(completion: (SegmentedFactStoreOperationResult) -> Unit) {
        writer.execute {
            val currentHandle = synchronized(lock) { handle }
            val adapter = native
            if (currentHandle == 0L || adapter == null) {
                completion(SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.CLOSED))
                return@execute
            }
            if (unflushedRecords == 0) {
                completion(SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK))
                return@execute
            }
            flushPendingOnWriter(adapter, currentHandle)
            completion(synchronized(lock) { lastOperation })
        }
    }

    fun status(completion: (SegmentedFactStoreStatus) -> Unit) {
        writer.execute {
            val retryPlan = synchronized(lock) {
                mobileProfileCleanupPlan.takeIf { profileCleanupPending }
            }
            if (retryPlan != null) cleanInactiveMobileProfiles(retryPlan)
            val snapshot = wrapperSnapshot()
            val currentHandle = synchronized(lock) { handle }
            val adapter = native
            if (currentHandle == 0L || adapter == null) {
                completion(snapshot)
                return@execute
            }
            completion(adapter.status(currentHandle).withWrapper(snapshot))
        }
    }

    @JvmOverloads
    fun close(completion: (SegmentedFactStoreOperationResult) -> Unit = {}) {
        val shouldClose = synchronized(lock) {
            when (state) {
                SegmentedFactStoreState.OPENING,
                SegmentedFactStoreState.OPEN,
                -> {
                    state = SegmentedFactStoreState.CLOSING
                    true
                }

                SegmentedFactStoreState.DISABLED,
                SegmentedFactStoreState.FAILED,
                SegmentedFactStoreState.CLOSED,
                -> {
                    enabled = false
                    state = SegmentedFactStoreState.CLOSED
                    false
                }

                SegmentedFactStoreState.CLOSING -> false
            }
        }
        AndroidObservationFactStoreRegistry.detach(this)
        if (!shouldClose) {
            completion(SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK))
            return
        }
        writer.execute {
            cancelGroupFlush()
            val currentHandle = synchronized(lock) { handle }
            val adapter = native
            if (currentHandle != 0L && adapter != null) {
                flushPendingOnWriter(adapter, currentHandle)
            }
            val closeResult = if (currentHandle != 0L && adapter != null) {
                adapter.close(currentHandle)
            } else {
                SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.CLOSED)
            }
            val result = closeResult
            synchronized(lock) {
                handle = 0L
                enabled = false
                state = SegmentedFactStoreState.CLOSED
                lastOperation = result
            }
            unflushedRecords = 0
            completion(result)
        }
    }

    private fun startGroupFlushOnWriter() {
        cancelGroupFlush()
        flushTask = flushScheduler.scheduleAtFixedRate(
            {
                writer.execute {
                    if (unflushedRecords == 0) return@execute
                    val currentHandle = synchronized(lock) { handle }
                    val adapter = native
                    if (currentHandle != 0L && adapter != null) {
                        flushPendingOnWriter(adapter, currentHandle)
                    }
                }
            },
            flushIntervalMs,
            flushIntervalMs,
            TimeUnit.MILLISECONDS,
        )
    }

    private fun cancelGroupFlush() {
        flushTask?.cancel(false)
        flushTask = null
    }

    private fun flushPendingOnWriter(adapter: SegmentedFactStoreNative, currentHandle: Long) {
        if (unflushedRecords == 0) return
        val result = adapter.flush(currentHandle)
        synchronized(lock) { lastOperation = result }
        if (result.isSuccess) unflushedRecords = 0
    }

    private fun closedRead(cursor: SegmentedFactStoreCursor) = SegmentedFactStoreReadResult(
        operation = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.CLOSED),
        cursor = cursor,
    )

    private fun createLargeFactPlan(
        payload: ByteArray,
        partitionId: Int,
        configuration: RecordConfiguration,
    ): LargeFactWritePlan {
        require(partitionId in configuration.partitionQuotas.indices) { "large fact partition is invalid" }
        val quota = configuration.partitionQuotas[partitionId]
        require(quota >= configuration.segmentSizeBytes) {
            "large fact partition is disabled or has an invalid quota"
        }
        val maxNativePayload = maximumNativePayload(configuration.segmentSizeBytes)
        val maxChunkBytes = maxNativePayload - LargeFactWire.HEADER_BYTES
        require(maxChunkBytes in 1..Int.MAX_VALUE.toLong()) { "segment is too small for a large fact chunk" }
        val digest = LargeFactWire.sha256(payload)
        val index = LargeFactWire.extractIndex(payload)
        val chunks = payload.asListOfChunks(maxChunkBytes.toInt())
        val upperLocations = chunks.mapIndexed { ordinal, bytes ->
            LargeFactWire.ChunkLocation(
                ordinal = ordinal,
                sequence = Long.MAX_VALUE - chunks.size + ordinal,
                segmentId = Long.MAX_VALUE,
                frameOffset = Long.MAX_VALUE,
                payloadLength = LargeFactWire.HEADER_BYTES + bytes.size,
                byteLength = bytes.size,
            )
        }
        val manifestUpperBound = LargeFactWire.encodeManifest(index, digest, payload.size, upperLocations)
        require(manifestUpperBound.size.toLong() <= maxNativePayload) {
            "large fact manifest does not fit in an empty segment"
        }
        val physicalPayloadLengths = chunks.map { LargeFactWire.HEADER_BYTES + it.size } +
            manifestUpperBound.size
        val requiredSegments = requiredSegments(configuration.segmentSizeBytes, physicalPayloadLengths)
        require(requiredSegments.toLong() <= quota / configuration.segmentSizeBytes) {
            "large fact exceeds its partition quota"
        }
        return LargeFactWritePlan(index, digest, payload.size, chunks)
    }

    private fun appendLargeFact(
        adapter: SegmentedFactStoreNative,
        currentHandle: Long,
        partitionId: Int,
        durability: SegmentedFactStoreDurability,
        plan: LargeFactWritePlan,
    ): NativeAppendResult {
        val locations = ArrayList<LargeFactWire.ChunkLocation>(plan.chunks.size)
        plan.chunks.forEachIndexed { ordinal, bytes ->
            val chunkPayload = LargeFactWire.encodeChunk(
                digest = plan.digest,
                ordinal = ordinal,
                chunkCount = plan.chunks.size,
                totalLength = plan.byteLength,
                bytes = bytes,
            )
            val receipt = adapter.append(
                handle = currentHandle,
                partitionId = partitionId,
                payload = chunkPayload,
                durability = SegmentedFactStoreDurability.MEMORY.nativeValue,
            )
            if (!receipt.operation.isSuccess) return receipt
            if (receipt.partitionId != partitionId || receipt.sequence <= 0 || receipt.segmentId <= 0 ||
                receipt.frameOffset < NATIVE_SEGMENT_HEADER_BYTES || receipt.payloadLength != chunkPayload.size) {
                return NativeAppendResult(
                    operation = SegmentedFactStoreOperationResult(
                        SegmentedFactStoreResultCode.CORRUPT,
                        message = "large fact chunk append receipt is invalid",
                    ),
                    sequence = 0,
                )
            }
            locations += LargeFactWire.ChunkLocation(
                ordinal = ordinal,
                sequence = receipt.sequence,
                segmentId = receipt.segmentId,
                frameOffset = receipt.frameOffset,
                payloadLength = receipt.payloadLength,
                byteLength = bytes.size,
            )
        }
        val manifest = LargeFactWire.encodeManifest(plan.index, plan.digest, plan.byteLength, locations)
        return adapter.append(
            handle = currentHandle,
            partitionId = partitionId,
            payload = manifest,
            durability = durability.nativeValue,
        )
    }

    private fun readLogical(
        adapter: SegmentedFactStoreNative,
        currentHandle: Long,
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int,
    ): SegmentedFactStoreReadResult {
        var physicalCursor = cursor
        var skippedGapFirstSequence = 0L
        var skippedGapLastSequence = 0L
        while (true) {
            val physical = scanPhysical(adapter, currentHandle, physicalCursor, bufferCapacity)
            if (!physical.operation.isSuccess) return physical
            val record = physical.record ?: return corruptRead(cursor, "native scan returned no record")
            if (record.flags and RECORD_GAP_BEFORE != 0) {
                if (skippedGapFirstSequence == 0L) skippedGapFirstSequence = record.gapFirstSequence
                skippedGapLastSequence = maxOf(skippedGapLastSequence, record.gapLastSequence)
            }
            if (LargeFactWire.isChunk(record.payload)) {
                physicalCursor = physical.cursor
                continue
            }
            val manifest = try {
                LargeFactWire.decodeManifest(record.payload, record.sequence)
            } catch (error: Exception) {
                return corruptRead(cursor, error.message ?: "large fact manifest is invalid")
            }
            if (manifest == null) {
                if (record.payloadLength > bufferCapacity) {
                    return bufferTooSmallRead(cursor, record.payloadLength)
                }
                return physical.copy(record = record.withSkippedGap(
                    skippedGapFirstSequence,
                    skippedGapLastSequence,
                ))
            }
            if (manifest.byteLength > bufferCapacity) {
                return bufferTooSmallRead(cursor, manifest.byteLength)
            }
            val assembled = try {
                assembleLargeFact(adapter, currentHandle, record, manifest)
            } catch (error: Exception) {
                return corruptRead(cursor, error.message ?: "large fact is invalid")
            }
            return physical.copy(
                record = record.copy(payload = assembled, payloadLength = assembled.size).withSkippedGap(
                    skippedGapFirstSequence,
                    skippedGapLastSequence,
                ),
                requiredCapacity = 0,
            )
        }
    }

    private fun scanPhysical(
        adapter: SegmentedFactStoreNative,
        currentHandle: Long,
        cursor: SegmentedFactStoreCursor,
        requestedCapacity: Int,
    ): SegmentedFactStoreReadResult {
        val first = adapter.scan(currentHandle, cursor, requestedCapacity)
        if (first.operation.code != SegmentedFactStoreResultCode.BUFFER_TOO_SMALL) return first
        if (first.requiredCapacity <= 0) return corruptRead(cursor, "native scan reported an invalid required capacity")
        return adapter.scan(currentHandle, cursor, first.requiredCapacity)
    }

    private fun assembleLargeFact(
        adapter: SegmentedFactStoreNative,
        currentHandle: Long,
        manifestRecord: SegmentedFactStoreRecord,
        manifest: LargeFactWire.Manifest,
    ): ByteArray {
        val output = ByteArrayOutputStream(manifest.byteLength)
        manifest.chunks.forEach { expected ->
            val exactCursor = SegmentedFactStoreCursor(
                partitionId = manifestRecord.partitionId,
                afterSequence = expected.sequence - 1,
                segmentId = expected.segmentId,
                offset = expected.frameOffset,
            )
            val scanned = scanPhysical(adapter, currentHandle, exactCursor, expected.payloadLength)
            val record = scanned.record
            require(scanned.operation.isSuccess && record != null) {
                "large fact chunk ${expected.ordinal} is missing"
            }
            require(
                record.partitionId == manifestRecord.partitionId &&
                    record.sequence == expected.sequence &&
                    record.segmentId == expected.segmentId &&
                    record.frameOffset == expected.frameOffset &&
                    record.payloadLength == expected.payloadLength,
            ) { "large fact chunk ${expected.ordinal} location changed" }
            val chunk = LargeFactWire.decodeChunk(record.payload)
            require(
                chunk.ordinal == expected.ordinal &&
                    chunk.chunkCount == manifest.chunks.size &&
                    chunk.totalLength == manifest.byteLength &&
                    chunk.bytes.size == expected.byteLength &&
                    chunk.digest.contentEquals(manifest.digest),
            ) { "large fact chunk ${expected.ordinal} metadata does not match the manifest" }
            output.write(chunk.bytes)
        }
        val assembled = output.toByteArray()
        require(assembled.size == manifest.byteLength) { "large fact assembled length is invalid" }
        require(LargeFactWire.sha256(assembled).contentEquals(manifest.digest)) {
            "large fact SHA-256 does not match the manifest"
        }
        require(LargeFactWire.extractIndex(assembled) == manifest.index) {
            "large fact index metadata does not match the manifest"
        }
        return assembled
    }

    private fun bufferTooSmallRead(cursor: SegmentedFactStoreCursor, requiredCapacity: Int) =
        SegmentedFactStoreReadResult(
            operation = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.BUFFER_TOO_SMALL),
            cursor = cursor,
            requiredCapacity = requiredCapacity,
        )

    private fun corruptRead(cursor: SegmentedFactStoreCursor, message: String) =
        SegmentedFactStoreReadResult(
            operation = SegmentedFactStoreOperationResult(
                SegmentedFactStoreResultCode.CORRUPT,
                message = message,
            ),
            cursor = cursor,
        )

    private fun requiredSegments(segmentSizeBytes: Long, payloadLengths: List<Int>): Int {
        var segments = 1
        var offset = NATIVE_SEGMENT_HEADER_BYTES
        payloadLengths.forEach { payloadLength ->
            val frameLength = nativeFrameLength(payloadLength)
            require(frameLength <= segmentSizeBytes - NATIVE_SEGMENT_HEADER_BYTES) {
                "large fact physical record does not fit in an empty segment"
            }
            if (offset + frameLength > segmentSizeBytes) {
                segments += 1
                offset = NATIVE_SEGMENT_HEADER_BYTES
            }
            offset += frameLength
        }
        return segments
    }

    private fun nativeFrameLength(payloadLength: Int): Long =
        ((NATIVE_FRAME_PREFIX_BYTES + payloadLength + 7L) and 7L.inv()) + NATIVE_FRAME_COMMIT_BYTES

    private fun maximumNativePayload(segmentSizeBytes: Long): Long {
        val availableFrameBody = segmentSizeBytes - NATIVE_SEGMENT_HEADER_BYTES - NATIVE_FRAME_COMMIT_BYTES
        if (availableFrameBody < NATIVE_FRAME_PREFIX_BYTES) return 0L
        return (availableFrameBody and 7L.inv()) - NATIVE_FRAME_PREFIX_BYTES
    }

    private fun SegmentedFactStoreRecord.withSkippedGap(first: Long, last: Long): SegmentedFactStoreRecord {
        if (first <= 0L || last < first) return this
        return copy(
            flags = flags or RECORD_GAP_BEFORE,
            gapFirstSequence = minOf(first, gapFirstSequence.takeIf { it > 0L } ?: first),
            gapLastSequence = maxOf(last, gapLastSequence),
        )
    }

    private fun ByteArray.asListOfChunks(chunkBytes: Int): List<ByteArray> {
        val chunks = ArrayList<ByteArray>((size + chunkBytes - 1) / chunkBytes)
        var offset = 0
        while (offset < size) {
            val end = minOf(size, offset + chunkBytes)
            chunks += copyOfRange(offset, end)
            offset = end
        }
        return chunks
    }

    private fun wrapperSnapshot(): SegmentedFactStoreStatus {
        val local = synchronized(lock) {
            WrapperSnapshot(
                state = state,
                operation = lastOperation,
                enabled = enabled,
                profileCleanupPending = profileCleanupPending,
                inactiveProfileBytes = inactiveProfileBytes,
                profileCleanupError = profileCleanupError,
            )
        }
        return SegmentedFactStoreStatus(
            operation = local.operation,
            state = local.state,
            enabled = local.enabled,
            queuedRecords = maxQueuedRecords - recordPermits.availablePermits(),
            queuedPayloadBytes = queuedPayloadBytes.get(),
            acceptedRecords = acceptedRecords.get(),
            writtenRecords = writtenRecords.get(),
            droppedRecords = droppedRecords.get(),
            cleanupPending = local.profileCleanupPending,
            inactiveBytes = local.inactiveProfileBytes,
            cleanupError = local.profileCleanupError,
        )
    }

    private fun cleanInactiveMobileProfiles(plan: MobileProfileCleanupPlan) {
        val result = MobileProfileJanitor.clean(plan)
        synchronized(lock) {
            profileCleanupPending = result.pending
            inactiveProfileBytes = result.inactiveBytes
            profileCleanupError = result.error
        }
    }

    private fun nativeFailure(error: Throwable): SegmentedFactStoreOperationResult {
        return SegmentedFactStoreOperationResult(
            code = SegmentedFactStoreResultCode.IO,
            message = error.message ?: error.javaClass.name,
        )
    }
}

private data class RecordConfiguration(
    val state: SegmentedFactStoreState,
    val segmentSizeBytes: Long,
    val partitionQuotas: LongArray,
)

private data class LargeFactWritePlan(
    val index: LargeFactWire.IndexMetadata,
    val digest: ByteArray,
    val byteLength: Int,
    val chunks: List<ByteArray>,
)

private data class WrapperSnapshot(
    val state: SegmentedFactStoreState,
    val operation: SegmentedFactStoreOperationResult,
    val enabled: Boolean,
    val profileCleanupPending: Boolean,
    val inactiveProfileBytes: Long,
    val profileCleanupError: String?,
)

private fun SegmentedFactStoreStatus.withWrapper(wrapper: SegmentedFactStoreStatus) = copy(
    state = wrapper.state,
    enabled = wrapper.enabled,
    queuedRecords = wrapper.queuedRecords,
    queuedPayloadBytes = wrapper.queuedPayloadBytes,
    acceptedRecords = wrapper.acceptedRecords,
    writtenRecords = wrapper.writtenRecords,
    droppedRecords = wrapper.droppedRecords,
    cleanupPending = wrapper.cleanupPending,
    inactiveBytes = wrapper.inactiveBytes,
    cleanupError = wrapper.cleanupError,
)

private data class MobileProfileCleanupPlan(
    val baseDirectory: File?,
    val activeProfile: String,
    val selectedDirectory: File,
)

private data class MobileProfileCleanupResult(
    val pending: Boolean,
    val inactiveBytes: Long,
    val error: String?,
)

/**
 * Deletes data from inactive, known profile directories while preserving their lock inode.
 *
 * Leaving `.sfs-lock` and the empty directory in place closes the race where a second process
 * could open a newly-created lock inode between releasing the janitor lock and removing the old
 * directory. An inactive store that is open in another App process is skipped immediately.
 */
private object MobileProfileJanitor {
    private const val MAINTENANCE_LOCK_FILE = ".profile-maintenance.lock"
    private const val STORE_LOCK_FILE = ".sfs-lock"
    private val allowedProfiles = setOf("1gb", "512mb", "256mb", "64mb", "off-low-disk")

    fun clean(plan: MobileProfileCleanupPlan): MobileProfileCleanupResult {
        val base = plan.baseDirectory
        if (base == null || plan.activeProfile !in allowedProfiles) {
            return MobileProfileCleanupResult(
                pending = true,
                inactiveBytes = 0L,
                error = "invalid-profile-cleanup-scope",
            )
        }
        val canonicalBase = try {
            base.canonicalFile
        } catch (error: Exception) {
            return MobileProfileCleanupResult(true, 0L, "invalid-profile-base:${safeMessage(error)}")
        }
        if (!isExactChild(canonicalBase, plan.selectedDirectory, plan.activeProfile)) {
            return MobileProfileCleanupResult(true, 0L, "invalid-profile-cleanup-scope")
        }
        if (!canonicalBase.exists()) return MobileProfileCleanupResult(false, 0L, null)
        if (!canonicalBase.isDirectory) {
            return MobileProfileCleanupResult(true, 0L, "invalid-profile-base:not-directory")
        }
        val maintenanceLockPath = File(canonicalBase, MAINTENANCE_LOCK_FILE)
        if (!isExactChild(canonicalBase, maintenanceLockPath, MAINTENANCE_LOCK_FILE)) {
            return MobileProfileCleanupResult(true, inactiveBytes(canonicalBase, plan), "maintenance:unsafe-lock")
        }
        return try {
            RandomAccessFile(maintenanceLockPath, "rw").use { lockFile ->
                val maintenanceLock = try {
                    lockFile.channel.tryLock()
                } catch (_: OverlappingFileLockException) {
                    null
                }
                if (maintenanceLock == null) {
                    return MobileProfileCleanupResult(
                        pending = true,
                        inactiveBytes = inactiveBytes(canonicalBase, plan),
                        error = "maintenance:busy",
                    )
                }
                maintenanceLock.use { cleanWithMaintenanceLock(canonicalBase, plan) }
            }
        } catch (error: Exception) {
            MobileProfileCleanupResult(
                pending = true,
                inactiveBytes = inactiveBytes(canonicalBase, plan),
                error = "maintenance:cleanup-failed:${safeMessage(error)}",
            )
        }
    }

    private fun cleanWithMaintenanceLock(
        canonicalBase: File,
        plan: MobileProfileCleanupPlan,
    ): MobileProfileCleanupResult {
        val errors = mutableListOf<String>()
        for (profile in allowedProfiles) {
            if (profile == plan.activeProfile) continue
            val directory = File(canonicalBase, profile)
            if (!directory.exists()) continue
            if (!isExactProfileDirectory(canonicalBase, directory, profile)) {
                errors += "$profile:unsafe-path"
                continue
            }
            if (!directory.isDirectory) {
                errors += "$profile:not-directory"
                continue
            }
            cleanOneProfile(directory, profile, errors)
        }
        return MobileProfileCleanupResult(
            pending = errors.isNotEmpty(),
            inactiveBytes = inactiveBytes(canonicalBase, plan),
            error = errors.takeIf { it.isNotEmpty() }?.joinToString(";"),
        )
    }

    private fun cleanOneProfile(directory: File, profile: String, errors: MutableList<String>) {
        val lockPath = File(directory, STORE_LOCK_FILE)
        if (!isExactChild(directory, lockPath, STORE_LOCK_FILE)) {
            errors += "$profile:unsafe-lock"
            return
        }
        try {
            RandomAccessFile(lockPath, "rw").use { lockFile ->
                val directoryLock = try {
                    lockFile.channel.tryLock()
                } catch (_: OverlappingFileLockException) {
                    null
                }
                if (directoryLock == null) {
                    errors += "$profile:busy"
                    return
                }
                directoryLock.use {
                    val children = directory.listFiles()
                    if (children == null) {
                        errors += "$profile:list-failed"
                        return
                    }
                    children.forEach { child ->
                        if (child.name == STORE_LOCK_FILE) return@forEach
                        if (!deleteInsideProfile(directory, child)) {
                            errors += "$profile:delete-failed:${child.name}"
                        }
                    }
                }
            }
        } catch (error: Exception) {
            errors += "$profile:cleanup-failed:${safeMessage(error)}"
        }
    }

    private fun deleteInsideProfile(root: File, target: File): Boolean {
        val canonicalRoot = try {
            root.canonicalFile
        } catch (_: Exception) {
            return false
        }
        val expectedTarget = File(canonicalRoot, target.name).absoluteFile
        val canonicalTarget = try {
            target.canonicalFile
        } catch (_: Exception) {
            return false
        }
        // A direct child whose canonical location differs is a symlink. Remove only the link;
        // never recurse through it into another profile or outside the App-owned base.
        if (canonicalTarget != expectedTarget) return target.delete()
        if (target.isDirectory) {
            val children = target.listFiles() ?: return false
            children.forEach { child ->
                if (!deleteInsideProfile(target, child)) return false
            }
        }
        return target.delete()
    }

    private fun isExactProfileDirectory(base: File, directory: File, profile: String): Boolean {
        if (profile !in allowedProfiles) return false
        return try {
            val canonical = directory.canonicalFile
            canonical.parentFile == base && canonical.name == profile
        } catch (_: Exception) {
            false
        }
    }

    private fun isExactChild(parent: File, child: File, name: String): Boolean {
        return try {
            val canonicalParent = parent.canonicalFile
            val canonicalChild = child.canonicalFile
            canonicalChild.parentFile == canonicalParent && canonicalChild.name == name
        } catch (_: Exception) {
            false
        }
    }

    private fun inactiveBytes(base: File, plan: MobileProfileCleanupPlan): Long = allowedProfiles
        .asSequence()
        .filter { it != plan.activeProfile }
        .map { File(base, it) }
        .filter { it.exists() && isExactProfileDirectory(base, it, it.name) }
        .fold(0L) { total, directory -> saturatingAdd(total, safeTreeBytes(directory)) }

    private fun safeTreeBytes(file: File): Long {
        val canonical = try {
            file.canonicalFile
        } catch (_: Exception) {
            return 0L
        }
        if (canonical != file.absoluteFile) return file.length().coerceAtLeast(0L)
        if (!file.isDirectory) return file.length().coerceAtLeast(0L)
        return file.listFiles().orEmpty().fold(0L) { total, child ->
            saturatingAdd(total, safeTreeBytes(child))
        }
    }

    private fun saturatingAdd(left: Long, right: Long): Long =
        if (Long.MAX_VALUE - left < right) Long.MAX_VALUE else left + right

    private fun safeMessage(error: Exception): String =
        (error.message ?: error.javaClass.simpleName).replace(';', '_').take(160)
}

internal data class NativeOpenResult(
    val operation: SegmentedFactStoreOperationResult,
    val handle: Long,
)

internal data class NativeAppendResult(
    val operation: SegmentedFactStoreOperationResult,
    val sequence: Long,
    val partitionId: Int = 0,
    val segmentId: Long = 0,
    val frameOffset: Long = 0,
    val payloadLength: Int = 0,
)

internal data class NativeStoreGeometry(
    val operation: SegmentedFactStoreOperationResult,
    val segmentSizeBytes: Long,
    val partitionQuotas: LongArray,
)

internal interface SegmentedFactStoreNative {
    fun open(
        directory: String,
        segmentSizeBytes: Long,
        flags: Int,
        partitionQuotas: LongArray,
    ): NativeOpenResult

    fun append(
        handle: Long,
        partitionId: Int,
        payload: ByteArray,
        durability: Int,
    ): NativeAppendResult

    fun scan(
        handle: Long,
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int,
    ): SegmentedFactStoreReadResult

    fun status(handle: Long): SegmentedFactStoreStatus
    fun geometry(handle: Long): NativeStoreGeometry {
        val status = status(handle)
        return NativeStoreGeometry(status.operation, status.segmentSizeBytes, longArrayOf())
    }
    fun flush(handle: Long): SegmentedFactStoreOperationResult
    fun close(handle: Long): SegmentedFactStoreOperationResult
}

internal data class MobileFactStoreConfiguration(
    val profile: String,
    val budgetBytes: Long,
    val disabledReason: String? = null,
    val options: SegmentedFactStoreOptions,
)

internal object MobileFactStoreProfiles {
    private const val MIB = 1024L * 1024L
    private const val GIB = 1024L * MIB
    private const val MINIMUM_SAFETY_RESERVE = 256L * MIB
    private val partitionWeights = intArrayOf(25, 18, 10, 7, 10, 13, 5, 2)

    fun forContext(context: Context): MobileFactStoreConfiguration {
        val application = context.applicationContext
        // Both roots are owned by this application sandbox. The selected
        // 64/256/512 MiB or 1 GiB budget therefore belongs to exactly one App install
        // on one device and is never pooled across packages or devices.
        val storageRoot = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            application.noBackupFilesDir
        } else {
            application.cacheDir
        }
        val baseDirectory = File(storageRoot, "ai-app-bridge/segmented-fact-store")
        return configuration(
            baseDirectory = baseDirectory,
            totalBytes = storageRoot.totalSpace.coerceAtLeast(0L),
            availableBytes = storageRoot.usableSpace.coerceAtLeast(0L),
        )
    }

    fun configuration(
        baseDirectory: File,
        totalBytes: Long,
        availableBytes: Long,
    ): MobileFactStoreConfiguration {
        require(totalBytes >= 0L) { "totalBytes must not be negative" }
        require(availableBytes >= 0L) { "availableBytes must not be negative" }
        if (availableBytes < 64L * MIB + MINIMUM_SAFETY_RESERVE) {
            return MobileFactStoreConfiguration(
                profile = "off-low-disk",
                budgetBytes = 0L,
                disabledReason = "insufficient-space",
                options = SegmentedFactStoreOptions(
                    directory = File(baseDirectory, "off-low-disk"),
                    segmentSizeBytes = 512L * 1024L,
                    flags = 1,
                    partitionQuotas = LongArray(8),
                    enabled = false,
                    receiveObservationFacts = false,
                ),
            )
        }
        val profile = when {
            totalBytes >= 32L * GIB && availableBytes >= 8L * GIB -> "1gb"
            totalBytes >= 16L * GIB && availableBytes >= 4L * GIB -> "512mb"
            totalBytes >= 4L * GIB && availableBytes >= 2L * GIB -> "256mb"
            else -> "64mb"
        }
        val budgetBytes = when (profile) {
            "1gb" -> GIB
            "512mb" -> 512L * MIB
            "256mb" -> 256L * MIB
            else -> 64L * MIB
        }
        val segmentSizeBytes = when (profile) {
            "1gb" -> 4L * MIB
            "512mb" -> 4L * MIB
            "256mb" -> 2L * MIB
            else -> 512L * 1024L
        }
        val quotas = partitionWeights.map { weight ->
            val target = budgetBytes * weight / 100L
            (target / segmentSizeBytes * segmentSizeBytes).coerceAtLeast(segmentSizeBytes)
        }.toLongArray()
        check(quotas.size == 8 && quotas.sum() <= budgetBytes)
        return MobileFactStoreConfiguration(
            profile = profile,
            budgetBytes = budgetBytes,
            options = SegmentedFactStoreOptions(
                directory = File(baseDirectory, profile),
                segmentSizeBytes = segmentSizeBytes,
                flags = 1,
                partitionQuotas = quotas,
                enabled = true,
                receiveObservationFacts = true,
            ),
        )
    }
}

internal interface ObservationFactStore {
    fun open(
        configuration: MobileFactStoreConfiguration,
        completion: (SegmentedFactStoreOperationResult) -> Unit,
    )

    fun close(completion: (SegmentedFactStoreOperationResult) -> Unit)
    fun status(completion: (SegmentedFactStoreStatus) -> Unit)
}

private class SegmentedObservationFactStore(
    private val store: SegmentedFactStore,
) : ObservationFactStore {
    override fun open(
        configuration: MobileFactStoreConfiguration,
        completion: (SegmentedFactStoreOperationResult) -> Unit,
    ) = store.openMobileProfile(configuration, completion)

    override fun close(completion: (SegmentedFactStoreOperationResult) -> Unit) = store.close(completion)

    override fun status(completion: (SegmentedFactStoreStatus) -> Unit) = store.status(completion)
}

internal data class ObservationFactStoreRuntimeStatus(
    val desiredRunning: Boolean,
    val lifecycleState: SegmentedFactStoreState,
    val profile: String?,
    val budgetBytes: Long,
    val disabledReason: String?,
    val directory: String?,
    val partitionQuotas: LongArray,
    val store: SegmentedFactStoreStatus,
)

internal class ObservationFactStoreLifecycle(
    private val store: ObservationFactStore,
    private val onOpened: (MobileFactStoreConfiguration, SegmentedFactStoreOperationResult) -> Unit = { _, _ -> },
) {
    constructor(
        store: SegmentedFactStore,
        onOpened: (MobileFactStoreConfiguration, SegmentedFactStoreOperationResult) -> Unit = { _, _ -> },
    ) : this(SegmentedObservationFactStore(store), onOpened)

    private val lock = Any()
    private var desiredRunning = false
    private var lifecycleState = SegmentedFactStoreState.CLOSED
    private var configuration: MobileFactStoreConfiguration? = null
    private var closeIssued = false
    private var lifecycleOperation = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.CLOSED)

    fun start(configuration: MobileFactStoreConfiguration) {
        val shouldOpen = synchronized(lock) {
            desiredRunning = true
            this.configuration = configuration
            when (lifecycleState) {
                SegmentedFactStoreState.CLOSED,
                SegmentedFactStoreState.DISABLED,
                SegmentedFactStoreState.FAILED,
                -> {
                    lifecycleState = SegmentedFactStoreState.OPENING
                    true
                }

                SegmentedFactStoreState.OPENING,
                SegmentedFactStoreState.OPEN,
                SegmentedFactStoreState.CLOSING,
                -> false
            }
        }
        if (shouldOpen) requestOpen(configuration)
    }

    fun stop() {
        val shouldClose = synchronized(lock) {
            desiredRunning = false
            when (lifecycleState) {
                SegmentedFactStoreState.OPENING,
                SegmentedFactStoreState.OPEN,
                -> if (!closeIssued) {
                    lifecycleState = SegmentedFactStoreState.CLOSING
                    closeIssued = true
                    true
                } else {
                    false
                }

                SegmentedFactStoreState.FAILED,
                SegmentedFactStoreState.DISABLED,
                -> {
                    lifecycleState = SegmentedFactStoreState.CLOSED
                    false
                }

                SegmentedFactStoreState.CLOSED,
                SegmentedFactStoreState.CLOSING,
                -> false
            }
        }
        if (shouldClose) requestClose()
    }

    fun status(completion: (ObservationFactStoreRuntimeStatus) -> Unit) {
        val metadata = synchronized(lock) { metadataSnapshot() }
        store.status { storeStatus -> completion(metadata.copy(store = storeStatus)) }
    }

    fun snapshot(): ObservationFactStoreRuntimeStatus = synchronized(lock) { metadataSnapshot() }

    private fun requestOpen(configuration: MobileFactStoreConfiguration) {
        store.open(configuration) { result ->
            var shouldClose = false
            synchronized(lock) {
                lifecycleOperation = result
                if (result.isSuccess) {
                    if (!configuration.options.enabled) {
                        lifecycleState = SegmentedFactStoreState.DISABLED
                    } else if (desiredRunning && !closeIssued) {
                        lifecycleState = SegmentedFactStoreState.OPEN
                    } else if (!closeIssued) {
                        lifecycleState = SegmentedFactStoreState.CLOSING
                        closeIssued = true
                        shouldClose = true
                    }
                } else if (!closeIssued) {
                    lifecycleState = SegmentedFactStoreState.FAILED
                }
            }
            if (shouldClose) requestClose()
            else onOpened(configuration, result)
        }
    }

    private fun requestClose() {
        store.close { result ->
            val reopen = synchronized(lock) {
                lifecycleOperation = result
                closeIssued = false
                lifecycleState = SegmentedFactStoreState.CLOSED
                if (desiredRunning) configuration else null
            }
            if (reopen != null) {
                val shouldOpen = synchronized(lock) {
                    if (lifecycleState == SegmentedFactStoreState.CLOSED && desiredRunning) {
                        lifecycleState = SegmentedFactStoreState.OPENING
                        true
                    } else {
                        false
                    }
                }
                if (shouldOpen) requestOpen(reopen)
            }
        }
    }

    private fun metadataSnapshot(): ObservationFactStoreRuntimeStatus {
        val selected = configuration
        return ObservationFactStoreRuntimeStatus(
            desiredRunning = desiredRunning,
            lifecycleState = lifecycleState,
            profile = selected?.profile,
            budgetBytes = selected?.budgetBytes ?: 0L,
            disabledReason = selected?.disabledReason,
            directory = selected?.options?.directory?.absolutePath,
            partitionQuotas = selected?.options?.partitionQuotas?.copyOf() ?: longArrayOf(),
            store = SegmentedFactStoreStatus(
                operation = lifecycleOperation,
                state = lifecycleState,
                enabled = false,
                queuedRecords = 0,
                acceptedRecords = 0,
                writtenRecords = 0,
                droppedRecords = 0,
            ),
        )
    }
}
