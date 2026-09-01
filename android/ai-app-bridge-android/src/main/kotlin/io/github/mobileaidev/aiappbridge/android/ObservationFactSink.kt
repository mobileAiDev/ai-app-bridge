package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Locale

internal enum class MobileFactPartition(val id: Int, val wireName: String) {
    NETWORK(0, "network"),
    UI(1, "ui"),
    APP_LOG(2, "app-log"),
    DEVICE_LOG(3, "device-log"),
    STATE_EVENT(4, "state-event"),
    ACTION(5, "action"),
    NOTE(6, "note"),
    INDEX(7, "index"),
}

internal data class MobileFactEnvelopeContext(
    val platform: String,
    val packageName: String?,
    val bundleId: String?,
    val model: String,
    val deviceIdentity: String,
    val runtimeEpoch: String,
    val actionId: String?,
    val occurredAtMs: Long,
    val observedAtMs: Long,
)

/** A payload ready to write to the segmented fact store. */
internal class SanitizedFactPayload private constructor(
    val bytes: ByteArray,
    val partitionId: Int,
) {
    companion object {
        fun log(context: MobileFactEnvelopeContext, record: JSONObject): SanitizedFactPayload =
            capture(context, MobileFactPartition.APP_LOG, "logs", record)

        fun deviceLog(context: MobileFactEnvelopeContext, record: JSONObject): SanitizedFactPayload =
            capture(context, MobileFactPartition.DEVICE_LOG, "logcat", record)

        fun network(context: MobileFactEnvelopeContext, record: JSONObject): SanitizedFactPayload =
            capture(context, MobileFactPartition.NETWORK, "network", record)

        fun state(context: MobileFactEnvelopeContext, record: JSONObject): SanitizedFactPayload =
            capture(context, MobileFactPartition.STATE_EVENT, "state", record)

        fun event(
            context: MobileFactEnvelopeContext,
            category: String,
            name: String,
            data: JSONObject,
        ): SanitizedFactPayload {
            val partition = if (isUiEvent(category, name)) {
                MobileFactPartition.UI
            } else {
                MobileFactPartition.STATE_EVENT
            }
            return capture(
                context,
                partition,
                "events",
                JSONObject()
                    .put("category", category)
                    .put("name", name)
                    .put("data", data),
            )
        }

        fun event(context: MobileFactEnvelopeContext, record: JSONObject): SanitizedFactPayload {
            val category = record.optString("category", "app")
            val name = record.optString("name", "event")
            val partition = if (isUiEvent(category, name)) {
                MobileFactPartition.UI
            } else {
                MobileFactPartition.STATE_EVENT
            }
            return capture(context, partition, "events", record)
        }

        fun observation(
            context: MobileFactEnvelopeContext,
            category: String,
            name: String,
            data: JSONObject,
        ): SanitizedFactPayload = capture(
            context,
            MobileFactPartition.UI,
            "events",
            JSONObject()
                .put("category", category)
                .put("name", name)
                .put("data", data),
        )

        fun stableDeviceIdentity(
            platform: String,
            appIdentifier: String,
            rawIdentity: String,
        ): String {
            val input = "aiappbridge-device-v1\u0000$platform\u0000$appIdentifier\u0000$rawIdentity"
                .toByteArray(StandardCharsets.UTF_8)
            return "sha256:${sha256(input)}"
        }

        private fun capture(
            context: MobileFactEnvelopeContext,
            partition: MobileFactPartition,
            stream: String,
            record: JSONObject,
        ): SanitizedFactPayload {
            val appIdentifier = context.packageName ?: context.bundleId ?: "unknown"
            val app = JSONObject()
                .put("platform", context.platform)
                .put("model", context.model)
                .put("deviceIdentity", context.deviceIdentity)
            context.packageName?.let { app.put("packageName", it) }
            context.bundleId?.let { app.put("bundleId", it) }
            val envelope = JSONObject()
                .put("schema", "aiappbridge.fact.v1")
                .put("partition", partition.wireName)
                .put("platform", context.platform)
                .put("targetKey", "${context.platform}:${context.deviceIdentity}:$appIdentifier")
                .put("app", app)
                .put("runtimeEpoch", context.runtimeEpoch)
                .put("actionId", context.actionId ?: JSONObject.NULL)
                .put("dedupeKey", JSONObject.NULL)
                .put(
                    "timestamps",
                    JSONObject()
                        .put("occurredAtMs", context.occurredAtMs)
                        .put("observedAtMs", context.observedAtMs)
                        .put("ingestedAtMs", context.observedAtMs),
                )
                .put(
                    "payload",
                    JSONObject()
                        .put("kind", "evidence")
                        .put("stream", stream)
                        .put("record", record),
                )
            return SanitizedFactPayload(
                envelope.toString().toByteArray(StandardCharsets.UTF_8),
                partition.id,
            )
        }

        private fun sha256(bytes: ByteArray): String {
            return MessageDigest.getInstance("SHA-256")
                .digest(bytes)
                .joinToString(separator = "") { byte -> "%02x".format(byte) }
        }

        private fun isUiEvent(category: String, name: String): Boolean {
            val normalizedCategory = category.lowercase(Locale.US)
            val normalizedName = name.lowercase(Locale.US)
            return normalizedCategory == "ui" ||
                normalizedCategory.startsWith("ui.") ||
                normalizedCategory == "interaction" ||
                normalizedCategory == "lifecycle" ||
                normalizedName.startsWith("ui.") ||
                normalizedName.startsWith("lifecycle.")
        }

    }
}

internal fun interface AndroidUiFactSink {
    fun enqueue(payload: SanitizedFactPayload)

    companion object {
        val NONE = AndroidUiFactSink { }
    }
}

internal object AndroidObservationFactStoreRegistry : AndroidUiFactSink {
    private val lock = Any()
    private var store: SegmentedFactStore? = null

    fun attach(store: SegmentedFactStore) {
        synchronized(lock) { this.store = store }
    }

    fun detach(store: SegmentedFactStore) {
        synchronized(lock) {
            if (this.store === store) {
                this.store = null
            }
        }
    }

    override fun enqueue(payload: SanitizedFactPayload) {
        val target = synchronized(lock) { store } ?: return
        target.record(payload.bytes, partitionId = payload.partitionId)
    }
}
