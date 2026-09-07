package io.github.mobileaidev.aiappbridge.android

import android.os.Build
import java.io.File
import java.io.FileDescriptor
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.MappedByteBuffer
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.util.Locale

/** API-19-compatible implementation of the portable v1 frame and manifest format. */
internal class MappedSegmentedFactStore(
    private val manifestFileForce: (RandomAccessFile) -> Unit = { it.channel.force(true) },
    private val directorySync: (File) -> Unit = ::syncDirectoryBestEffort,
) : SegmentedFactStoreNative {
    private var directory: File? = null
    private var lockFile: RandomAccessFile? = null
    private var directoryLock: FileLock? = null
    private var manifestFile: RandomAccessFile? = null
    private var manifestMap: MappedByteBuffer? = null
    private var manifestActiveSlot = -1
    private var manifestGeneration = 0L
    private var segmentSize = 0L
    private var nextSequence = 1L
    private var opened = false
    private var recoveredTail = false
    private var recoveryPartitionId = -1
    private var recoverySegmentId = 0L
    private var recoveryOffset = 0L
    private var recoveryDiscardedBytes = 0L
    private val partitions = Array(MAX_PARTITIONS) { Partition(it) }

    override fun open(
        directory: String,
        segmentSizeBytes: Long,
        flags: Int,
        partitionQuotas: LongArray,
    ): NativeOpenResult {
        if (opened || directory.isBlank() || flags and OPEN_CREATE.inv() != 0 ||
            segmentSizeBytes < 0 || partitionQuotas.size > MAX_PARTITIONS) {
            return NativeOpenResult(error(SegmentedFactStoreResultCode.INVALID_ARGUMENT, "invalid open options"), 0)
        }
        val root = File(directory)
        val create = flags and OPEN_CREATE != 0
        return try {
            recoveredTail = false
            recoveryPartitionId = -1
            recoverySegmentId = 0
            recoveryOffset = 0
            recoveryDiscardedBytes = 0
            if (!root.exists()) {
                if (!create || !root.mkdirs()) {
                    return NativeOpenResult(error(SegmentedFactStoreResultCode.IO, "store directory does not exist"), 0)
                }
            }
            if (!root.isDirectory) {
                return NativeOpenResult(error(SegmentedFactStoreResultCode.IO, "store path is not a directory"), 0)
            }
            this.directory = root
            val lock = RandomAccessFile(File(root, LOCK_FILE), "rw")
            lockFile = lock
            directoryLock = try {
                lock.channel.tryLock()
            } catch (_: OverlappingFileLockException) {
                null
            }
            if (directoryLock == null) {
                cleanup()
                return NativeOpenResult(error(SegmentedFactStoreResultCode.BUSY, "store is already open for writing"), 0)
            }
            val manifestResult = openManifest(root, segmentSizeBytes, partitionQuotas, create)
            if (!manifestResult.isSuccess) {
                cleanup()
                return NativeOpenResult(manifestResult, 0)
            }
            for (partition in partitions) {
                if (!partition.enabled) continue
                val result = loadPartition(partition, create)
                if (!result.isSuccess) {
                    cleanup()
                    return NativeOpenResult(result, 0)
                }
            }
            val saved = saveManifest()
            if (!saved.isSuccess) {
                cleanup()
                return NativeOpenResult(saved, 0)
            }
            opened = true
            NativeOpenResult(ok(), HANDLE)
        } catch (exception: Exception) {
            cleanup()
            NativeOpenResult(ioError("cannot open fact store", exception), 0)
        }
    }

    override fun append(
        handle: Long,
        partitionId: Int,
        payload: ByteArray,
        durability: Int,
    ): NativeAppendResult {
        val valid = validateHandle(handle)
        if (valid != null) return NativeAppendResult(valid, 0)
        if (partitionId !in 0 until MAX_PARTITIONS || durability !in 0..1) {
            return NativeAppendResult(error(SegmentedFactStoreResultCode.INVALID_ARGUMENT, "invalid append arguments"), 0)
        }
        val partition = partitions[partitionId]
        if (!partition.enabled) {
            return NativeAppendResult(error(SegmentedFactStoreResultCode.PARTITION_DISABLED, "partition $partitionId is disabled"), 0)
        }
        val frameLength = alignEight(FRAME_PREFIX_SIZE.toLong() + payload.size) + FRAME_COMMIT_SIZE
        if (frameLength > segmentSize - SEGMENT_HEADER_SIZE) {
            return NativeAppendResult(error(SegmentedFactStoreResultCode.FULL, "record does not fit in an empty segment"), 0)
        }
        if (nextSequence == Long.MAX_VALUE) {
            return NativeAppendResult(error(SegmentedFactStoreResultCode.FULL, "global sequence is exhausted"), 0)
        }
        return try {
            if (partition.activeWriteOffset + frameLength > segmentSize) {
                val rotated = rotatePartition(partition)
                if (!rotated.isSuccess) return NativeAppendResult(rotated, 0)
            }
            val map = partition.activeMap
                ?: return NativeAppendResult(error(SegmentedFactStoreResultCode.CORRUPT, "active segment is absent"), 0)
            val sequence = nextSequence
            val offset = partition.activeWriteOffset.toInt()
            val totalLength = frameLength.toInt()
            zero(map, offset, totalLength)
            map.putInt(offset, totalLength)
            map.putInt(offset + 4, payload.size)
            map.putLong(offset + 8, sequence)
            map.putInt(offset + 16, Crc32c.compute(payload))
            map.putInt(offset + 20, Crc32c.compute(map, offset, 20))
            putBytes(map, offset + FRAME_PREFIX_SIZE, payload)
            map.putLong(offset + totalLength - FRAME_COMMIT_SIZE, FRAME_COMMIT_MARKER)

            partition.activeWriteOffset += frameLength
            val meta = partition.segments.last()
            meta.writeOffset = partition.activeWriteOffset
            if (meta.recordCount == 0L) meta.firstSequence = sequence
            meta.lastSequence = sequence
            meta.recordCount += 1
            meta.payloadBytes += payload.size
            val location = RecordLocation(
                partitionId = partitionId,
                segmentId = meta.id,
                frameOffset = offset.toLong(),
                totalLength = totalLength,
                payloadLength = payload.size,
                sequence = sequence,
            )
            partition.records += location
            if (partition.recordCount == 0L) partition.firstSequence = sequence
            partition.lastSequence = sequence
            partition.recordCount += 1
            partition.payloadBytes += payload.size
            nextSequence += 1
            if (durability == SegmentedFactStoreDurability.SYNC.nativeValue) {
                val flushed = flushAll()
                if (!flushed.isSuccess) return NativeAppendResult(flushed, 0)
            }
            NativeAppendResult(
                operation = ok(),
                sequence = sequence,
                partitionId = partitionId,
                segmentId = meta.id,
                frameOffset = offset.toLong(),
                payloadLength = payload.size,
            )
        } catch (exception: Exception) {
            NativeAppendResult(ioError("cannot append fact", exception), 0)
        }
    }

    // Record locations are already maintained in ascending global sequence order by this engine.
    // Seek within that existing metadata instead of rescanning every retained record for each row.
    private fun firstIndexAfterSequence(records: List<RecordLocation>, sequence: Long): Int {
        var low = 0
        var high = records.size
        while (low < high) {
            val middle = low + (high - low) / 2
            if (records[middle].sequence <= sequence) low = middle + 1 else high = middle
        }
        return low
    }

    override fun scan(
        handle: Long,
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int,
    ): SegmentedFactStoreReadResult {
        val valid = validateHandle(handle)
        if (valid != null) return readError(valid, cursor)
        if (cursor.flags != 0 || (cursor.partitionId != -1 && cursor.partitionId !in 0 until MAX_PARTITIONS)) {
            return readError(error(SegmentedFactStoreResultCode.INVALID_ARGUMENT, "invalid scan arguments"), cursor)
        }
        var partitionCursorEvicted = false
        val candidate = if (cursor.partitionId == -1) {
            partitions.asSequence()
                .filter { it.enabled }
                .mapNotNull { partition ->
                    partition.records.getOrNull(firstIndexAfterSequence(partition.records, cursor.afterSequence))
                }
                .minByOrNullCompat { it.sequence }
        } else {
            val partition = partitions[cursor.partitionId]
            if (!partition.enabled) {
                return readError(
                    error(SegmentedFactStoreResultCode.PARTITION_DISABLED, "partition ${cursor.partitionId} is disabled"),
                    cursor,
                )
            }
            partitionCursorEvicted = if (cursor.segmentId == 0L) {
                partition.evictedRecords > 0L && cursor.afterSequence < partition.firstSequence
            } else {
                partition.segments.none { it.id == cursor.segmentId } &&
                    (partition.segments.firstOrNull()?.id ?: 0L) > cursor.segmentId
            }
            partition.records.listIterator(firstIndexAfterSequence(partition.records, cursor.afterSequence)).asSequence().firstOrNull { location ->
                when {
                    cursor.segmentId == 0L -> true
                    location.segmentId > cursor.segmentId -> true
                    location.segmentId < cursor.segmentId -> false
                    else -> location.frameOffset >= (if (cursor.offset == 0L) SEGMENT_HEADER_SIZE.toLong() else cursor.offset)
                }
            }
        }
        if (candidate == null) {
            return SegmentedFactStoreReadResult(
                operation = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.END),
                cursor = cursor,
            )
        }
        if (bufferCapacity < candidate.payloadLength) {
            return SegmentedFactStoreReadResult(
                operation = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.BUFFER_TOO_SMALL),
                cursor = cursor,
                requiredCapacity = candidate.payloadLength,
            )
        }
        return try {
            val payload = readPayload(candidate)
            val isGlobal = cursor.partitionId == -1
            val expected = if (cursor.afterSequence == Long.MAX_VALUE) Long.MAX_VALUE else cursor.afterSequence + 1
            val gap = (isGlobal || partitionCursorEvicted) && candidate.sequence > expected
            val nextCursor = cursor.copy(
                afterSequence = candidate.sequence,
                segmentId = candidate.segmentId,
                offset = candidate.frameOffset + candidate.totalLength,
            )
            SegmentedFactStoreReadResult(
                operation = ok(),
                cursor = nextCursor,
                record = SegmentedFactStoreRecord(
                    payload = payload,
                    payloadLength = payload.size,
                    partitionId = candidate.partitionId,
                    flags = if (gap) RECORD_GAP_BEFORE else 0,
                    sequence = candidate.sequence,
                    segmentId = candidate.segmentId,
                    frameOffset = candidate.frameOffset,
                    gapFirstSequence = if (gap) expected else 0,
                    gapLastSequence = if (gap) candidate.sequence - 1 else 0,
                ),
            )
        } catch (exception: Exception) {
            readError(ioError("cannot read fact", exception), cursor)
        }
    }

    override fun status(handle: Long): SegmentedFactStoreStatus {
        val valid = validateHandle(handle)
        if (valid != null) return nativeStatus(valid)
        val enabled = partitions.filter { it.enabled }
        val segments = enabled.flatMap { it.segments }
        return SegmentedFactStoreStatus(
            operation = ok(),
            state = SegmentedFactStoreState.OPEN,
            enabled = true,
            queuedRecords = 0,
            acceptedRecords = 0,
            writtenRecords = 0,
            droppedRecords = 0,
            formatVersion = FORMAT_VERSION,
            recoveredTail = recoveredTail,
            segmentSizeBytes = segmentSize,
            segmentCount = segments.size.toLong(),
            firstSegmentId = segments.minOfOrNullCompat { it.id } ?: 0,
            activeSegmentId = segments.maxOfOrNullCompat { it.id } ?: 0,
            activeWriteOffset = enabled.maxOfOrNullCompat { it.activeWriteOffset } ?: 0,
            recordCount = enabled.sumOfLong { it.recordCount },
            payloadBytes = enabled.sumOfLong { it.payloadBytes },
            nextSequence = nextSequence,
            recoveryPartitionId = recoveryPartitionId,
            recoverySegmentId = recoverySegmentId,
            recoveryOffset = recoveryOffset,
            recoveryDiscardedBytes = recoveryDiscardedBytes,
        )
    }

    override fun geometry(handle: Long): NativeStoreGeometry {
        val valid = validateHandle(handle)
        if (valid != null) return NativeStoreGeometry(valid, 0L, longArrayOf())
        return NativeStoreGeometry(
            operation = ok(),
            segmentSizeBytes = segmentSize,
            partitionQuotas = LongArray(MAX_PARTITIONS) { partitions[it].quotaBytes },
        )
    }

    override fun flush(handle: Long): SegmentedFactStoreOperationResult {
        validateHandle(handle)?.let { return it }
        return try {
            flushAll()
        } catch (exception: Exception) {
            ioError("cannot flush fact store", exception)
        }
    }

    override fun close(handle: Long): SegmentedFactStoreOperationResult {
        validateHandle(handle)?.let { return it }
        val result = flush(handle)
        cleanup()
        return result
    }

    private fun openManifest(
        root: File,
        configuredSegmentSize: Long,
        configuredQuotas: LongArray,
        create: Boolean,
    ): SegmentedFactStoreOperationResult {
        val path = File(root, MANIFEST_FILE)
        val existed = path.exists()
        if (!existed && !create) return error(SegmentedFactStoreResultCode.IO, "store does not exist")
        val file = RandomAccessFile(path, "rw")
        manifestFile = file
        val newManifest = file.length() == 0L
        if (!newManifest && file.length() != MANIFEST_SIZE.toLong()) {
            return error(SegmentedFactStoreResultCode.CORRUPT, "manifest size is invalid")
        }
        if (newManifest) {
            if (!create) return error(SegmentedFactStoreResultCode.IO, "store does not exist")
            segmentSize = if (configuredSegmentSize == 0L) DEFAULT_SEGMENT_SIZE else configuredSegmentSize
            if (segmentSize < MIN_SEGMENT_SIZE || segmentSize > Int.MAX_VALUE) {
                return error(SegmentedFactStoreResultCode.INVALID_ARGUMENT, "segment size is outside the Android mmap range")
            }
            nextSequence = 1
            var anyEnabled = false
            partitions.forEach { partition ->
                val quota = configuredQuotas.getOrElse(partition.id) { 0L }
                partition.reset(quota)
                if (partition.enabled) {
                    anyEnabled = true
                    if (quota < segmentSize) {
                        return error(SegmentedFactStoreResultCode.INVALID_ARGUMENT, "partition ${partition.id} quota is smaller than one segment")
                    }
                }
            }
            if (!anyEnabled) {
                return error(SegmentedFactStoreResultCode.INVALID_ARGUMENT, "at least one partition quota must be non-zero")
            }
            file.setLength(MANIFEST_SIZE.toLong())
        }
        manifestMap = file.channel.map(FileChannel.MapMode.READ_WRITE, 0, MANIFEST_SIZE.toLong()).littleEndian()
        if (newManifest) {
            zero(manifestMap!!, 0, MANIFEST_SIZE)
            manifestActiveSlot = -1
            manifestGeneration = 0
            return saveManifest()
        }
        val map = manifestMap!!
        val decoded = arrayOf(decodeManifestSlot(map, 0), decodeManifestSlot(map, MANIFEST_SLOT_SIZE))
        val selected = when {
            decoded[0] != null && decoded[1] != null -> if (decoded[1]!!.generation > decoded[0]!!.generation) 1 else 0
            decoded[0] != null -> 0
            decoded[1] != null -> 1
            else -> {
                val version0 = map.getInt(8)
                val version1 = map.getInt(MANIFEST_SLOT_SIZE + 8)
                val code = if ((version0 != 0 && version0 != FORMAT_VERSION) ||
                    (version1 != 0 && version1 != FORMAT_VERSION)) {
                    SegmentedFactStoreResultCode.FORMAT_VERSION
                } else {
                    SegmentedFactStoreResultCode.CORRUPT
                }
                return error(code, "manifest has no valid committed slot")
            }
        }
        val manifest = decoded[selected]!!
        manifestActiveSlot = selected
        manifestGeneration = manifest.generation
        segmentSize = manifest.segmentSize
        nextSequence = manifest.nextSequence
        if ((configuredSegmentSize != 0L && configuredSegmentSize != segmentSize) ||
            segmentSize < MIN_SEGMENT_SIZE || segmentSize > Int.MAX_VALUE) {
            return error(SegmentedFactStoreResultCode.INVALID_ARGUMENT, "configured segment size does not match the store")
        }
        partitions.forEach { partition ->
            val persisted = manifest.partitions[partition.id]
            val configured = configuredQuotas.getOrElse(partition.id) { 0L }
            if (configured != 0L && configured != persisted.quotaBytes) {
                return error(SegmentedFactStoreResultCode.INVALID_ARGUMENT, "partition ${partition.id} quota does not match the store")
            }
            partition.reset(persisted.quotaBytes)
            partition.nextSegmentId = persisted.nextSegmentId
            partition.firstRetainedSegmentId = persisted.firstRetainedSegmentId
            partition.evictedSegments = persisted.evictedSegments
            partition.evictedRecords = persisted.evictedRecords
            partition.evictedPayloadBytes = persisted.evictedPayloadBytes
        }
        return ok()
    }

    private fun decodeManifestSlot(map: ByteBuffer, offset: Int): Manifest? {
        if (!matches(map, offset, MANIFEST_MAGIC) ||
            map.getInt(offset + 8) != FORMAT_VERSION ||
            map.getInt(offset + 12) != MANIFEST_SLOT_SIZE ||
            map.getInt(offset + 40) != MAX_PARTITIONS ||
            map.getLong(offset + MANIFEST_COMMIT_OFFSET) != MANIFEST_COMMIT_MARKER ||
            map.getInt(offset + MANIFEST_CRC_OFFSET) != Crc32c.compute(map, offset, MANIFEST_CRC_OFFSET)) {
            return null
        }
        val generation = map.getLong(offset + 16)
        val next = map.getLong(offset + 24)
        if (generation <= 0 || next <= 0) return null
        val values = Array(MAX_PARTITIONS) { id ->
            val entry = offset + MANIFEST_PARTITIONS_OFFSET + id * MANIFEST_PARTITION_SIZE
            ManifestPartition(
                quotaBytes = map.getLong(entry),
                nextSegmentId = map.getLong(entry + 8),
                firstRetainedSegmentId = map.getLong(entry + 16),
                evictedSegments = map.getLong(entry + 24),
                evictedRecords = map.getLong(entry + 32),
                evictedPayloadBytes = map.getLong(entry + 40),
            )
        }
        if (values.any { it.quotaBytes != 0L && (it.nextSegmentId <= 0 || it.firstRetainedSegmentId <= 0) }) {
            return null
        }
        return Manifest(generation, next, map.getLong(offset + 32), values)
    }

    private fun saveManifest(): SegmentedFactStoreOperationResult {
        val map = manifestMap ?: return error(SegmentedFactStoreResultCode.CLOSED, "manifest is closed")
        val file = manifestFile ?: return error(SegmentedFactStoreResultCode.CLOSED, "manifest is closed")
        if (manifestGeneration == Long.MAX_VALUE) return error(SegmentedFactStoreResultCode.FULL, "manifest generation is exhausted")
        val targetSlot = if (manifestActiveSlot < 0) 0 else (manifestActiveSlot + 1) % 2
        val offset = targetSlot * MANIFEST_SLOT_SIZE
        zero(map, offset, MANIFEST_SLOT_SIZE)
        putBytes(map, offset, MANIFEST_MAGIC)
        map.putInt(offset + 8, FORMAT_VERSION)
        map.putInt(offset + 12, MANIFEST_SLOT_SIZE)
        map.putLong(offset + 16, manifestGeneration + 1)
        map.putLong(offset + 24, nextSequence)
        map.putLong(offset + 32, segmentSize)
        map.putInt(offset + 40, MAX_PARTITIONS)
        partitions.forEach { partition ->
            val entry = offset + MANIFEST_PARTITIONS_OFFSET + partition.id * MANIFEST_PARTITION_SIZE
            map.putLong(entry, partition.quotaBytes)
            map.putLong(entry + 8, partition.nextSegmentId)
            map.putLong(entry + 16, partition.firstRetainedSegmentId)
            map.putLong(entry + 24, partition.evictedSegments)
            map.putLong(entry + 32, partition.evictedRecords)
            map.putLong(entry + 40, partition.evictedPayloadBytes)
        }
        map.putInt(offset + MANIFEST_CRC_OFFSET, Crc32c.compute(map, offset, MANIFEST_CRC_OFFSET))
        map.force()
        map.putLong(offset + MANIFEST_COMMIT_OFFSET, MANIFEST_COMMIT_MARKER)
        map.force()
        manifestFileForce(file)
        manifestActiveSlot = targetSlot
        manifestGeneration += 1
        return ok()
    }

    private fun loadPartition(partition: Partition, create: Boolean): SegmentedFactStoreOperationResult {
        val root = directory ?: return error(SegmentedFactStoreResultCode.CLOSED, "store is closed")
        val partitionDirectory = File(root, "partition-${partition.id}")
        if (!partitionDirectory.exists()) {
            if (!create || !partitionDirectory.mkdirs()) {
                return error(SegmentedFactStoreResultCode.IO, "partition directory is missing")
            }
        }
        partition.directory = partitionDirectory
        var removedTemporary = false
        partitionDirectory.listFiles()
            .orEmpty()
            .filter { isTemporarySegmentName(it.name) }
            .forEach { temporary ->
                if (!temporary.delete()) {
                    return error(
                        SegmentedFactStoreResultCode.IO,
                        "cannot remove interrupted segment creation ${temporary.name}",
                    )
                }
                removedTemporary = true
            }
        if (removedTemporary) syncDirectory(partitionDirectory)
        val ids = partitionDirectory.listFiles()
            .orEmpty()
            .mapNotNull { parseSegmentId(it.name) }
            .sorted()
            .toMutableList()
        val obsolete = ids.filter { it < partition.firstRetainedSegmentId }
        obsolete.forEach { id ->
            if (!segmentFile(partition, id).delete()) {
                return error(SegmentedFactStoreResultCode.IO, "cannot finish eviction of segment $id")
            }
            ids.remove(id)
        }
        if (obsolete.isNotEmpty()) syncDirectory(partitionDirectory)
        if (ids.isEmpty()) return createSegment(partition)
        if (ids.first() != partition.firstRetainedSegmentId) {
            return error(SegmentedFactStoreResultCode.CORRUPT, "partition ${partition.id} is missing retained segment")
        }
        for (index in 1 until ids.size) {
            if (ids[index] != ids[index - 1] + 1) {
                return error(SegmentedFactStoreResultCode.CORRUPT, "partition ${partition.id} has a segment id gap")
            }
        }
        if (ids.size.toLong() > partition.quotaBytes / segmentSize) {
            return error(SegmentedFactStoreResultCode.CORRUPT, "partition ${partition.id} exceeds its hard quota")
        }
        ids.forEachIndexed { index, id ->
            val result = scanSegment(partition, id, active = index == ids.lastIndex)
            if (!result.isSuccess) return result
        }
        if (ids.last() >= partition.nextSegmentId) {
            if (ids.last() == Long.MAX_VALUE) return error(SegmentedFactStoreResultCode.FULL, "segment id is exhausted")
            partition.nextSegmentId = ids.last() + 1
        }
        return ok()
    }

    private fun createSegment(partition: Partition): SegmentedFactStoreOperationResult {
        val id = partition.nextSegmentId
        if (id <= 0 || id == Long.MAX_VALUE) return error(SegmentedFactStoreResultCode.FULL, "segment ids are exhausted")
        val path = segmentFile(partition, id)
        val temporaryPath = temporarySegmentFile(partition, id)
        if (path.exists()) return error(SegmentedFactStoreResultCode.IO, "segment $id already exists")
        if (temporaryPath.exists() && !temporaryPath.delete()) {
            return error(SegmentedFactStoreResultCode.IO, "cannot clear interrupted segment creation $id")
        }
        RandomAccessFile(temporaryPath, "rw").use { temporaryFile ->
            temporaryFile.setLength(segmentSize)
            val temporaryMap = temporaryFile.channel
                .map(FileChannel.MapMode.READ_WRITE, 0, segmentSize)
                .littleEndian()
            encodeSegmentHeader(temporaryMap, partition.id, id, nextSequence)
            temporaryMap.force()
            temporaryFile.channel.force(true)
        }
        if (!temporaryPath.renameTo(path)) {
            temporaryPath.delete()
            return error(SegmentedFactStoreResultCode.IO, "cannot publish initialized segment $id")
        }
        syncDirectory(requireNotNull(partition.directory))
        val file = RandomAccessFile(path, "rw")
        val map = file.channel.map(FileChannel.MapMode.READ_WRITE, 0, segmentSize).littleEndian()
        val meta = SegmentMeta(id = id, writeOffset = SEGMENT_HEADER_SIZE.toLong())
        partition.segments += meta
        partition.activeFile = file
        partition.activeMap = map
        partition.activeWriteOffset = SEGMENT_HEADER_SIZE.toLong()
        partition.durableOffset = SEGMENT_HEADER_SIZE.toLong()
        partition.nextSegmentId += 1
        if (partition.segments.size == 1) partition.firstRetainedSegmentId = id
        return saveManifest()
    }

    private fun scanSegment(partition: Partition, id: Long, active: Boolean): SegmentedFactStoreOperationResult {
        val file = RandomAccessFile(segmentFile(partition, id), "rw")
        var fileSize = file.length()
        if (fileSize < SEGMENT_HEADER_SIZE || fileSize > segmentSize || (!active && fileSize != segmentSize)) {
            file.close()
            return error(SegmentedFactStoreResultCode.CORRUPT, "segment $id has invalid file size")
        }
        var map = file.channel.map(FileChannel.MapMode.READ_WRITE, 0, fileSize).littleEndian()
        val header = validateSegmentHeader(map, partition.id, id)
        if (header.first == null) {
            file.close()
            return header.second!!
        }
        val meta = SegmentMeta(id = id, writeOffset = SEGMENT_HEADER_SIZE.toLong())
        var offset = SEGMENT_HEADER_SIZE
        var previous = 0L
        var ending: FrameEnding
        while (true) {
            val decoded = decodeFrame(map, fileSize.toInt(), offset)
            if (decoded.frame == null) {
                if (decoded.error != null) {
                    file.close()
                    return decoded.error
                }
                ending = decoded.ending
                break
            }
            val frame = decoded.frame
            if (previous != 0L && frame.sequence <= previous) {
                file.close()
                return error(SegmentedFactStoreResultCode.CORRUPT, "segment $id sequence order is corrupt")
            }
            if (meta.recordCount == 0L) meta.firstSequence = frame.sequence
            meta.lastSequence = frame.sequence
            meta.recordCount += 1
            meta.payloadBytes += frame.payloadLength
            val location = RecordLocation(
                partitionId = partition.id,
                segmentId = id,
                frameOffset = offset.toLong(),
                totalLength = frame.totalLength,
                payloadLength = frame.payloadLength,
                sequence = frame.sequence,
            )
            partition.records += location
            previous = frame.sequence
            offset += frame.totalLength
        }
        meta.writeOffset = offset.toLong()
        if (ending == FrameEnding.TORN && !active) {
            file.close()
            return error(SegmentedFactStoreResultCode.CORRUPT, "sealed segment $id has a torn tail")
        }
        if (active && (ending == FrameEnding.TORN || fileSize != segmentSize)) {
            val discarded = if (fileSize > offset) fileSize - offset else 0
            file.setLength(segmentSize)
            map = file.channel.map(FileChannel.MapMode.READ_WRITE, 0, segmentSize).littleEndian()
            zero(map, offset, (segmentSize - offset).toInt())
            map.force()
            file.channel.force(true)
            recoveredTail = true
            recoveryPartitionId = partition.id
            recoverySegmentId = id
            recoveryOffset = offset.toLong()
            recoveryDiscardedBytes += discarded
        }
        partition.segments += meta
        partition.recordCount += meta.recordCount
        partition.payloadBytes += meta.payloadBytes
        if (meta.recordCount != 0L) {
            if (partition.firstSequence == 0L) partition.firstSequence = meta.firstSequence
            partition.lastSequence = meta.lastSequence
            if (meta.lastSequence >= nextSequence) {
                if (meta.lastSequence == Long.MAX_VALUE) {
                    file.close()
                    return error(SegmentedFactStoreResultCode.FULL, "global sequence is exhausted")
                }
                nextSequence = meta.lastSequence + 1
            }
        }
        if (active) {
            partition.activeFile = file
            partition.activeMap = map
            partition.activeWriteOffset = offset.toLong()
            partition.durableOffset = offset.toLong()
        } else {
            file.close()
        }
        return ok()
    }

    private fun encodeSegmentHeader(map: ByteBuffer, partitionId: Int, segmentId: Long, firstSequence: Long) {
        zero(map, 0, SEGMENT_HEADER_SIZE)
        putBytes(map, 0, SEGMENT_MAGIC)
        map.putInt(8, FORMAT_VERSION)
        map.putInt(12, SEGMENT_HEADER_SIZE)
        map.putLong(16, segmentId)
        map.putLong(24, segmentSize)
        map.putInt(32, partitionId)
        map.putLong(40, firstSequence)
        map.putInt(48, Crc32c.compute(map, 0, 48))
    }

    private fun validateSegmentHeader(
        map: ByteBuffer,
        partitionId: Int,
        segmentId: Long,
    ): Pair<Long?, SegmentedFactStoreOperationResult?> {
        if (!matches(map, 0, SEGMENT_MAGIC)) {
            return null to error(SegmentedFactStoreResultCode.CORRUPT, "segment $segmentId has invalid magic")
        }
        if (map.getInt(8) != FORMAT_VERSION) {
            return null to error(SegmentedFactStoreResultCode.FORMAT_VERSION, "segment $segmentId has unsupported version")
        }
        if (map.getInt(12) != SEGMENT_HEADER_SIZE || map.getLong(16) != segmentId ||
            map.getLong(24) != segmentSize || map.getInt(32) != partitionId ||
            map.getInt(48) != Crc32c.compute(map, 0, 48)) {
            return null to error(SegmentedFactStoreResultCode.CORRUPT, "segment $segmentId header is corrupt")
        }
        val firstSequence = map.getLong(40)
        if (firstSequence <= 0) {
            return null to error(SegmentedFactStoreResultCode.CORRUPT, "segment $segmentId has invalid first sequence")
        }
        return firstSequence to null
    }

    private fun decodeFrame(map: ByteBuffer, fileSize: Int, offset: Int): DecodedFrame {
        if (offset == fileSize) return DecodedFrame(ending = FrameEnding.END)
        if (offset > fileSize) return DecodedFrame(ending = FrameEnding.TORN)
        if (fileSize - offset < FRAME_PREFIX_SIZE) {
            // Portable v1 segments may end with less than a frame prefix of zero padding.
            // Match the C reader: only a nonzero short tail represents an incomplete frame.
            val ending = if ((offset until fileSize).all { map.get(it).toInt() == 0 }) FrameEnding.END else FrameEnding.TORN
            return DecodedFrame(ending = ending)
        }
        var zero = true
        for (index in 0 until FRAME_PREFIX_SIZE) {
            if (map.get(offset + index).toInt() != 0) {
                zero = false
                break
            }
        }
        if (zero) {
            return if (committedMarkerFollows(map, fileSize, offset)) {
                DecodedFrame(error = error(
                    SegmentedFactStoreResultCode.CORRUPT,
                    "committed frame header at offset $offset was cleared",
                ))
            } else {
                DecodedFrame(ending = FrameEnding.END)
            }
        }
        val total = map.getInt(offset)
        val payloadLength = map.getInt(offset + 4)
        val sequence = map.getLong(offset + 8)
        if (map.getInt(offset + 20) != Crc32c.compute(map, offset, 20)) {
            return if (committedMarkerFollows(map, fileSize, offset)) {
                DecodedFrame(error = error(
                    SegmentedFactStoreResultCode.CORRUPT,
                    "committed frame header at offset $offset failed CRC32C",
                ))
            } else {
                DecodedFrame(ending = FrameEnding.TORN)
            }
        }
        if (payloadLength < 0) {
            return if (committedMarkerFollows(map, fileSize, offset)) {
                DecodedFrame(error = error(
                    SegmentedFactStoreResultCode.CORRUPT,
                    "committed frame length at offset $offset is corrupt",
                ))
            } else {
                DecodedFrame(ending = FrameEnding.TORN)
            }
        }
        val expected = alignEight(FRAME_PREFIX_SIZE.toLong() + payloadLength) + FRAME_COMMIT_SIZE
        if (total.toLong() != expected || total < MIN_FRAME_SIZE || total and 7 != 0 ||
            total > segmentSize - offset) {
            return if (committedMarkerFollows(map, fileSize, offset)) {
                DecodedFrame(error = error(
                    SegmentedFactStoreResultCode.CORRUPT,
                    "committed frame length at offset $offset is corrupt",
                ))
            } else {
                DecodedFrame(ending = FrameEnding.TORN)
            }
        }
        if (offset.toLong() + total > fileSize) {
            return DecodedFrame(ending = FrameEnding.TORN)
        }
        val commitOffset = offset + total - FRAME_COMMIT_SIZE
        if (map.getLong(commitOffset) != FRAME_COMMIT_MARKER) {
            return DecodedFrame(ending = FrameEnding.TORN)
        }
        if (sequence <= 0 || map.getInt(offset + 16) != Crc32c.compute(map, offset + FRAME_PREFIX_SIZE, payloadLength)) {
            return DecodedFrame(error = error(SegmentedFactStoreResultCode.CORRUPT, "committed frame payload failed CRC32C"))
        }
        for (index in offset + FRAME_PREFIX_SIZE + payloadLength until commitOffset) {
            if (map.get(index).toInt() != 0) {
                return DecodedFrame(error = error(SegmentedFactStoreResultCode.CORRUPT, "committed frame padding is non-zero"))
            }
        }
        return DecodedFrame(frame = Frame(total, payloadLength, sequence))
    }

    private fun committedMarkerFollows(map: ByteBuffer, fileSize: Int, frameOffset: Int): Boolean {
        val limit = minOf(fileSize.toLong(), segmentSize)
        var markerOffset = frameOffset.toLong() + FRAME_PREFIX_SIZE
        while (markerOffset <= limit && limit - markerOffset >= FRAME_COMMIT_SIZE) {
            if (map.getLong(markerOffset.toInt()) == FRAME_COMMIT_MARKER) return true
            markerOffset += 8
        }
        return false
    }

    private fun rotatePartition(partition: Partition): SegmentedFactStoreOperationResult {
        val flushed = flushPartition(partition)
        if (!flushed.isSuccess) return flushed
        closeActive(partition)
        while ((partition.segments.size + 1L) * segmentSize > partition.quotaBytes) {
            val evicted = evictOldest(partition)
            if (!evicted.isSuccess) return evicted
        }
        return createSegment(partition)
    }

    private fun evictOldest(partition: Partition): SegmentedFactStoreOperationResult {
        val victim = partition.segments.firstOrNull()
            ?: return error(SegmentedFactStoreResultCode.CORRUPT, "no segment is available to evict")
        val previousEvictedSegments = partition.evictedSegments
        val previousEvictedRecords = partition.evictedRecords
        val previousEvictedPayloadBytes = partition.evictedPayloadBytes
        val previousFirstRetainedSegmentId = partition.firstRetainedSegmentId
        fun rollbackRetentionDecision() {
            partition.evictedSegments = previousEvictedSegments
            partition.evictedRecords = previousEvictedRecords
            partition.evictedPayloadBytes = previousEvictedPayloadBytes
            partition.firstRetainedSegmentId = previousFirstRetainedSegmentId
        }
        partition.evictedSegments += 1
        partition.evictedRecords += victim.recordCount
        partition.evictedPayloadBytes += victim.payloadBytes
        partition.firstRetainedSegmentId = victim.id + 1
        val saved = try {
            saveManifest()
        } catch (exception: Exception) {
            rollbackRetentionDecision()
            throw exception
        }
        if (!saved.isSuccess) {
            rollbackRetentionDecision()
            return saved
        }
        if (!segmentFile(partition, victim.id).delete()) {
            return error(SegmentedFactStoreResultCode.IO, "cannot evict segment ${victim.id}")
        }
        syncDirectory(requireNotNull(partition.directory))
        partition.recordCount -= victim.recordCount
        partition.payloadBytes -= victim.payloadBytes
        partition.segments.removeAt(0)
        partition.records.removeAll { it.segmentId == victim.id }
        partition.firstSequence = partition.segments.firstOrNull()?.firstSequence ?: 0
        partition.lastSequence = partition.segments.lastOrNull()?.lastSequence ?: 0
        return ok()
    }

    private fun flushAll(): SegmentedFactStoreOperationResult {
        partitions.filter { it.enabled }.forEach { partition ->
            val result = flushPartition(partition)
            if (!result.isSuccess) return result
        }
        return saveManifest()
    }

    private fun flushPartition(partition: Partition): SegmentedFactStoreOperationResult {
        val map = partition.activeMap ?: return ok()
        val file = partition.activeFile ?: return ok()
        if (partition.durableOffset >= partition.activeWriteOffset) return ok()
        var offset = partition.durableOffset.toInt()
        while (offset < partition.activeWriteOffset) {
            val total = map.getInt(offset)
            if (total < MIN_FRAME_SIZE || total and 7 != 0 || total > partition.activeWriteOffset - offset) {
                return error(SegmentedFactStoreResultCode.CORRUPT, "active frame layout is corrupt during flush")
            }
            map.putLong(offset + total - FRAME_COMMIT_SIZE, 0)
            offset += total
        }
        map.force()
        offset = partition.durableOffset.toInt()
        while (offset < partition.activeWriteOffset) {
            val total = map.getInt(offset)
            map.putLong(offset + total - FRAME_COMMIT_SIZE, FRAME_COMMIT_MARKER)
            offset += total
        }
        map.force()
        file.channel.force(true)
        partition.durableOffset = partition.activeWriteOffset
        return ok()
    }

    private fun readPayload(location: RecordLocation): ByteArray {
        val partition = partitions[location.partitionId]
        val active = partition.segments.lastOrNull()?.id == location.segmentId
        val map = if (active) {
            partition.activeMap!!.duplicate().littleEndian()
        } else {
            RandomAccessFile(segmentFile(partition, location.segmentId), "r").use { file ->
                file.channel.map(FileChannel.MapMode.READ_ONLY, 0, segmentSize).littleEndian()
            }
        }
        return ByteArray(location.payloadLength).also { payload ->
            for (index in payload.indices) {
                payload[index] = map.get(location.frameOffset.toInt() + FRAME_PREFIX_SIZE + index)
            }
        }
    }

    private fun cleanup() {
        partitions.forEach { partition ->
            closeActive(partition)
            partition.clearRuntime()
        }
        try { manifestFile?.close() } catch (_: Exception) { }
        try { directoryLock?.release() } catch (_: Exception) { }
        try { lockFile?.close() } catch (_: Exception) { }
        manifestFile = null
        manifestMap = null
        directoryLock = null
        lockFile = null
        directory = null
        opened = false
    }

    private fun syncDirectory(directory: File) {
        try {
            directorySync(directory)
        } catch (_: Throwable) {
            // Directory fsync is a durability barrier, not an availability requirement. This
            // mirrors the portable C implementation's best-effort behavior on filesystems that
            // reject directory descriptors or fsync.
        }
    }

    private fun closeActive(partition: Partition) {
        try { partition.activeFile?.close() } catch (_: Exception) { }
        partition.activeFile = null
        partition.activeMap = null
    }

    private fun validateHandle(handle: Long): SegmentedFactStoreOperationResult? {
        return if (!opened || handle != HANDLE) error(SegmentedFactStoreResultCode.CLOSED, "fact store is closed") else null
    }

    private fun nativeStatus(operation: SegmentedFactStoreOperationResult) = SegmentedFactStoreStatus(
        operation = operation,
        state = SegmentedFactStoreState.CLOSED,
        enabled = false,
        queuedRecords = 0,
        acceptedRecords = 0,
        writtenRecords = 0,
        droppedRecords = 0,
    )

    private fun readError(operation: SegmentedFactStoreOperationResult, cursor: SegmentedFactStoreCursor) =
        SegmentedFactStoreReadResult(operation = operation, cursor = cursor)

    private fun ok() = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK)

    private fun error(code: Int, message: String) = SegmentedFactStoreOperationResult(code, message = message)

    private fun ioError(message: String, exception: Exception) = error(
        SegmentedFactStoreResultCode.IO,
        "$message: ${exception.message ?: exception.javaClass.simpleName}",
    )

    private fun segmentFile(partition: Partition, id: Long): File {
        return File(partition.directory, "segment-${String.format(Locale.US, "%020d", id)}.sfs")
    }

    private fun temporarySegmentFile(partition: Partition, id: Long): File {
        return File(partition.directory, ".segment-${String.format(Locale.US, "%020d", id)}.creating")
    }

    private fun isTemporarySegmentName(name: String): Boolean {
        if (!name.startsWith(".segment-") || !name.endsWith(".creating") || name.length != 38) return false
        return name.substring(9, 29).all { it in '0'..'9' }
    }

    private fun parseSegmentId(name: String): Long? {
        if (!name.startsWith("segment-") || !name.endsWith(".sfs") || name.length != 32) return null
        val digits = name.substring(8, 28)
        if (digits.any { it !in '0'..'9' }) return null
        return digits.toLongOrNull()?.takeIf { it > 0 }
    }

    private data class Partition(val id: Int) {
        var enabled = false
        var quotaBytes = 0L
        var directory: File? = null
        val segments = mutableListOf<SegmentMeta>()
        val records = mutableListOf<RecordLocation>()
        var activeFile: RandomAccessFile? = null
        var activeMap: MappedByteBuffer? = null
        var activeWriteOffset = SEGMENT_HEADER_SIZE.toLong()
        var durableOffset = SEGMENT_HEADER_SIZE.toLong()
        var nextSegmentId = 1L
        var firstRetainedSegmentId = 1L
        var recordCount = 0L
        var payloadBytes = 0L
        var firstSequence = 0L
        var lastSequence = 0L
        var evictedSegments = 0L
        var evictedRecords = 0L
        var evictedPayloadBytes = 0L

        fun reset(quota: Long) {
            clearRuntime()
            quotaBytes = quota
            enabled = quota != 0L
            nextSegmentId = 1
            firstRetainedSegmentId = 1
            evictedSegments = 0
            evictedRecords = 0
            evictedPayloadBytes = 0
        }

        fun clearRuntime() {
            segments.clear()
            records.clear()
            directory = null
            activeFile = null
            activeMap = null
            activeWriteOffset = SEGMENT_HEADER_SIZE.toLong()
            durableOffset = SEGMENT_HEADER_SIZE.toLong()
            recordCount = 0
            payloadBytes = 0
            firstSequence = 0
            lastSequence = 0
        }
    }

    private data class SegmentMeta(
        val id: Long,
        var writeOffset: Long,
        var recordCount: Long = 0,
        var payloadBytes: Long = 0,
        var firstSequence: Long = 0,
        var lastSequence: Long = 0,
    )

    private data class RecordLocation(
        val partitionId: Int,
        val segmentId: Long,
        val frameOffset: Long,
        val totalLength: Int,
        val payloadLength: Int,
        val sequence: Long,
    )

    private data class Frame(val totalLength: Int, val payloadLength: Int, val sequence: Long)

    private enum class FrameEnding { END, TORN }

    private data class DecodedFrame(
        val frame: Frame? = null,
        val ending: FrameEnding = FrameEnding.END,
        val error: SegmentedFactStoreOperationResult? = null,
    )

    private data class Manifest(
        val generation: Long,
        val nextSequence: Long,
        val segmentSize: Long,
        val partitions: Array<ManifestPartition>,
    )

    private data class ManifestPartition(
        val quotaBytes: Long,
        val nextSegmentId: Long,
        val firstRetainedSegmentId: Long,
        val evictedSegments: Long,
        val evictedRecords: Long,
        val evictedPayloadBytes: Long,
    )

    companion object {
        private const val HANDLE = 1L
        private const val FORMAT_VERSION = 1
        private const val OPEN_CREATE = 1
        private const val MAX_PARTITIONS = 8
        private const val DEFAULT_SEGMENT_SIZE = 1024L * 1024L
        private const val MIN_SEGMENT_SIZE = 128L
        private const val SEGMENT_HEADER_SIZE = 64
        private const val FRAME_PREFIX_SIZE = 24
        private const val FRAME_COMMIT_SIZE = 8
        private const val MIN_FRAME_SIZE = 32
        private const val MANIFEST_SIZE = 4096
        private const val MANIFEST_SLOT_SIZE = 512
        private const val MANIFEST_PARTITIONS_OFFSET = 48
        private const val MANIFEST_PARTITION_SIZE = 48
        private const val MANIFEST_CRC_OFFSET = 432
        private const val MANIFEST_COMMIT_OFFSET = 504
        private const val MANIFEST_FILE = ".sfs-manifest"
        private const val LOCK_FILE = ".sfs-lock"
        private const val MANIFEST_COMMIT_MARKER = 0x314D4F434D534653L
        private const val FRAME_COMMIT_MARKER = 0x314D4F4346534653L
        private const val RECORD_GAP_BEFORE = 1
        private val MANIFEST_MAGIC = "SFSMAN01".toByteArray(Charsets.US_ASCII)
        private val SEGMENT_MAGIC = "SFSSEG01".toByteArray(Charsets.US_ASCII)

        private fun alignEight(value: Long): Long = (value + 7L) and 7L.inv()

        private fun MappedByteBuffer.littleEndian(): MappedByteBuffer {
            order(ByteOrder.LITTLE_ENDIAN)
            return this
        }

        private fun ByteBuffer.littleEndian(): ByteBuffer {
            order(ByteOrder.LITTLE_ENDIAN)
            return this
        }

        private fun zero(buffer: ByteBuffer, offset: Int, length: Int) {
            for (index in offset until offset + length) buffer.put(index, 0)
        }

        private fun putBytes(buffer: ByteBuffer, offset: Int, bytes: ByteArray) {
            for (index in bytes.indices) buffer.put(offset + index, bytes[index])
        }

        private fun matches(buffer: ByteBuffer, offset: Int, bytes: ByteArray): Boolean {
            return bytes.indices.all { buffer.get(offset + it) == bytes[it] }
        }

        private fun <T> Sequence<T>.minByOrNullCompat(selector: (T) -> Long): T? {
            var best: T? = null
            var bestValue = Long.MAX_VALUE
            for (item in this) {
                val value = selector(item)
                if (best == null || value < bestValue) {
                    best = item
                    bestValue = value
                }
            }
            return best
        }

        private fun <T> Iterable<T>.minOfOrNullCompat(selector: (T) -> Long): Long? {
            var found = false
            var value = Long.MAX_VALUE
            for (item in this) {
                val next = selector(item)
                if (!found || next < value) value = next
                found = true
            }
            return if (found) value else null
        }

        private fun <T> Iterable<T>.maxOfOrNullCompat(selector: (T) -> Long): Long? {
            var found = false
            var value = Long.MIN_VALUE
            for (item in this) {
                val next = selector(item)
                if (!found || next > value) value = next
                found = true
            }
            return if (found) value else null
        }

        private fun <T> Iterable<T>.sumOfLong(selector: (T) -> Long): Long {
            var total = 0L
            for (item in this) total += selector(item)
            return total
        }
    }
}

private fun syncDirectoryBestEffort(directory: File) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return
    var descriptor: FileDescriptor? = null
    try {
        // android.system.Os starts at API 21. Reflection keeps this class verifiable on API 19
        // while still issuing the same open(O_DIRECTORY) + fsync barrier as the C/iOS store.
        val os = Class.forName("android.system.Os")
        val constants = Class.forName("android.system.OsConstants")
        val flags = constants.getField("O_RDONLY").getInt(null) or
            constants.getField("O_DIRECTORY").getInt(null)
        descriptor = os.getMethod(
            "open",
            String::class.java,
            Integer.TYPE,
            Integer.TYPE,
        ).invoke(null, directory.absolutePath, flags, 0) as FileDescriptor
        os.getMethod("fsync", FileDescriptor::class.java).invoke(null, descriptor)
    } catch (_: Throwable) {
        // Best effort: some Android filesystems and vendor kernels reject directory fsync.
    } finally {
        if (descriptor != null) {
            try {
                Class.forName("android.system.Os")
                    .getMethod("close", FileDescriptor::class.java)
                    .invoke(null, descriptor)
            } catch (_: Throwable) {
                // Best effort.
            }
        }
    }
}

internal object Crc32c {
    private val table = IntArray(256) { seed ->
        var value = seed
        repeat(8) {
            value = (value ushr 1) xor if (value and 1 != 0) 0x82F63B78.toInt() else 0
        }
        value
    }

    fun compute(bytes: ByteArray): Int {
        var crc = -1
        bytes.forEach { byte ->
            crc = table[(crc xor (byte.toInt() and 0xFF)) and 0xFF] xor (crc ushr 8)
        }
        return crc.inv()
    }

    fun compute(buffer: ByteBuffer, offset: Int, length: Int): Int {
        var crc = -1
        for (index in offset until offset + length) {
            crc = table[(crc xor (buffer.get(index).toInt() and 0xFF)) and 0xFF] xor (crc ushr 8)
        }
        return crc.inv()
    }
}
