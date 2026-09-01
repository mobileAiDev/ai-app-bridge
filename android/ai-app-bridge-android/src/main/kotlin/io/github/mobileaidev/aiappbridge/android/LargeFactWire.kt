package io.github.mobileaidev.aiappbridge.android

import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

/** Cross-platform adapter envelope defined by native/segmented-fact-store/FORMAT.md. */
internal object LargeFactWire {
    const val HEADER_BYTES = 72
    const val MANIFEST_MARKER = "ai-app-bridge.large-fact-manifest.v1"
    private const val VERSION = 1
    private val MAGIC = "AIBCHN01".toByteArray(Charsets.US_ASCII)

    data class IndexMetadata(
        val partition: String,
        val targetKey: String,
        val runtimeEpoch: String,
        val actionId: String?,
        val dedupeKey: String?,
        val occurredAtMs: Long,
        val observedAtMs: Long,
        val ingestedAtMs: Long,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("partition", partition)
            .put("targetKey", targetKey)
            .put("runtimeEpoch", runtimeEpoch)
            .put("actionId", actionId ?: JSONObject.NULL)
            .put("dedupeKey", dedupeKey ?: JSONObject.NULL)
            .put(
                "timestamps",
                JSONObject()
                    .put("occurredAtMs", occurredAtMs)
                    .put("observedAtMs", observedAtMs)
                    .put("ingestedAtMs", ingestedAtMs),
            )
    }

    data class ChunkLocation(
        val ordinal: Int,
        val sequence: Long,
        val segmentId: Long,
        val frameOffset: Long,
        val payloadLength: Int,
        val byteLength: Int,
    )

    data class DecodedChunk(
        val digest: ByteArray,
        val ordinal: Int,
        val chunkCount: Int,
        val totalLength: Int,
        val bytes: ByteArray,
    )

    data class Manifest(
        val index: IndexMetadata,
        val digest: ByteArray,
        val byteLength: Int,
        val chunks: List<ChunkLocation>,
    )

    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    fun hex(bytes: ByteArray): String = buildString(bytes.size * 2) {
        bytes.forEach { byte -> append(String.format("%02x", byte.toInt() and 0xff)) }
    }

    fun isChunk(payload: ByteArray): Boolean =
        payload.size >= MAGIC.size && MAGIC.indices.all { payload[it] == MAGIC[it] }

    fun encodeChunk(
        digest: ByteArray,
        ordinal: Int,
        chunkCount: Int,
        totalLength: Int,
        bytes: ByteArray,
    ): ByteArray {
        require(digest.size == 32) { "large fact SHA-256 must contain 32 bytes" }
        require(ordinal >= 0 && chunkCount > 0 && ordinal < chunkCount) { "large fact chunk ordinal is invalid" }
        require(totalLength > 0 && bytes.isNotEmpty()) { "large fact chunk lengths are invalid" }
        return ByteBuffer.allocate(HEADER_BYTES + bytes.size)
            .order(ByteOrder.LITTLE_ENDIAN)
            .apply {
                put(MAGIC)
                putInt(VERSION)
                putInt(HEADER_BYTES)
                put(digest)
                putInt(ordinal)
                putInt(chunkCount)
                putLong(totalLength.toLong())
                putInt(bytes.size)
                putInt(0)
                put(bytes)
            }
            .array()
    }

    fun decodeChunk(payload: ByteArray): DecodedChunk {
        require(payload.size >= HEADER_BYTES) { "large fact chunk header is truncated" }
        require(isChunk(payload)) { "large fact chunk magic is invalid" }
        val buffer = ByteBuffer.wrap(payload).order(ByteOrder.LITTLE_ENDIAN)
        buffer.position(8)
        require(buffer.int == VERSION) { "large fact chunk version is unsupported" }
        require(buffer.int == HEADER_BYTES) { "large fact chunk header length is invalid" }
        val digest = ByteArray(32).also(buffer::get)
        val ordinal = buffer.int
        val chunkCount = buffer.int
        val totalLengthLong = buffer.long
        val byteLength = buffer.int
        val reserved = buffer.int
        require(chunkCount > 0 && ordinal >= 0 && ordinal < chunkCount) { "large fact chunk ordinal is invalid" }
        require(totalLengthLong in 1..Int.MAX_VALUE.toLong()) { "large fact total length is invalid" }
        require(byteLength > 0 && byteLength == payload.size - HEADER_BYTES) {
            "large fact chunk byte length does not match its payload"
        }
        require(reserved == 0) { "large fact chunk reserved bytes are non-zero" }
        return DecodedChunk(
            digest = digest,
            ordinal = ordinal,
            chunkCount = chunkCount,
            totalLength = totalLengthLong.toInt(),
            bytes = payload.copyOfRange(HEADER_BYTES, payload.size),
        )
    }

    fun extractIndex(payload: ByteArray): IndexMetadata = parseIndex(
        JSONObject(payload.toString(Charsets.UTF_8)),
    )

    fun encodeManifest(
        index: IndexMetadata,
        digest: ByteArray,
        byteLength: Int,
        chunks: List<ChunkLocation>,
    ): ByteArray {
        require(digest.size == 32 && byteLength > 0 && chunks.isNotEmpty()) { "large fact manifest is invalid" }
        val chunkArray = JSONArray()
        chunks.forEach { chunk ->
            chunkArray.put(
                JSONObject()
                    .put("ordinal", chunk.ordinal)
                    .put("sequence", chunk.sequence)
                    .put("segmentId", chunk.segmentId)
                    .put("frameOffset", chunk.frameOffset)
                    .put("payloadLength", chunk.payloadLength)
                    .put("byteLength", chunk.byteLength),
            )
        }
        return JSONObject()
            .put("__aiAppBridgeInternal", MANIFEST_MARKER)
            .put("index", index.toJson())
            .put(
                "content",
                JSONObject()
                    .put("encoding", "json-utf8")
                    .put("byteLength", byteLength)
                    .put("sha256", hex(digest))
                    .put("chunks", chunkArray),
            )
            .toString()
            .toByteArray(Charsets.UTF_8)
    }

    /** Returns null for an ordinary physical payload and throws for a marked invalid manifest. */
    fun decodeManifest(payload: ByteArray, manifestSequence: Long): Manifest? {
        val value = try {
            JSONObject(payload.toString(Charsets.UTF_8))
        } catch (_: Exception) {
            return null
        }
        if (value.optString("__aiAppBridgeInternal") != MANIFEST_MARKER) return null
        require(manifestSequence > 0) { "large fact manifest sequence is invalid" }
        val index = parseIndex(value.getJSONObject("index"))
        val content = value.getJSONObject("content")
        require(content.getString("encoding") == "json-utf8") { "large fact manifest encoding is invalid" }
        val byteLengthLong = content.getLong("byteLength")
        require(byteLengthLong in 1..Int.MAX_VALUE.toLong()) { "large fact manifest byte length is invalid" }
        val digest = decodeHex(content.getString("sha256"))
        require(digest.size == 32) { "large fact manifest SHA-256 is invalid" }
        val values = content.getJSONArray("chunks")
        require(values.length() > 0) { "large fact manifest chunks are missing" }
        var priorSequence = 0L
        var totalLength = 0L
        val chunks = ArrayList<ChunkLocation>(values.length())
        repeat(values.length()) { ordinal ->
            val item = values.getJSONObject(ordinal)
            val chunk = ChunkLocation(
                ordinal = item.getInt("ordinal"),
                sequence = item.getLong("sequence"),
                segmentId = item.getLong("segmentId"),
                frameOffset = item.getLong("frameOffset"),
                payloadLength = item.getInt("payloadLength"),
                byteLength = item.getInt("byteLength"),
            )
            require(chunk.ordinal == ordinal) { "large fact manifest chunk ordinal is missing" }
            require(chunk.sequence > priorSequence && chunk.sequence < manifestSequence) {
                "large fact manifest chunk sequence is out of order"
            }
            require(chunk.segmentId > 0 && chunk.frameOffset >= 64 && chunk.payloadLength > HEADER_BYTES && chunk.byteLength > 0) {
                "large fact manifest chunk location is invalid"
            }
            require(chunk.payloadLength == HEADER_BYTES + chunk.byteLength) {
                "large fact manifest chunk physical length is invalid"
            }
            priorSequence = chunk.sequence
            totalLength += chunk.byteLength.toLong()
            require(totalLength <= Int.MAX_VALUE) { "large fact manifest chunk lengths overflow" }
            chunks += chunk
        }
        require(totalLength == byteLengthLong) { "large fact manifest chunk lengths do not match its total" }
        return Manifest(index, digest, byteLengthLong.toInt(), chunks)
    }

    private fun parseIndex(value: JSONObject): IndexMetadata {
        val partition = value.getString("partition")
        val targetKey = value.getString("targetKey")
        val runtimeEpoch = value.getString("runtimeEpoch")
        require(partition.isNotEmpty() && targetKey.isNotEmpty() && runtimeEpoch.isNotEmpty()) {
            "large fact index fields are missing"
        }
        val timestamps = value.getJSONObject("timestamps")
        return IndexMetadata(
            partition = partition,
            targetKey = targetKey,
            runtimeEpoch = runtimeEpoch,
            actionId = nullableString(value, "actionId"),
            dedupeKey = nullableString(value, "dedupeKey"),
            occurredAtMs = timestamps.getLong("occurredAtMs"),
            observedAtMs = timestamps.getLong("observedAtMs"),
            ingestedAtMs = timestamps.getLong("ingestedAtMs"),
        )
    }

    private fun nullableString(value: JSONObject, key: String): String? =
        if (!value.has(key) || value.isNull(key)) null else value.getString(key)

    private fun decodeHex(value: String): ByteArray {
        require(value.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' }) {
            "large fact manifest SHA-256 is invalid"
        }
        return ByteArray(value.length / 2) { index ->
            value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
    }
}
