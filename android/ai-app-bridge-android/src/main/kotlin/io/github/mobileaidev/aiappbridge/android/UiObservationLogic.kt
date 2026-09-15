package io.github.mobileaidev.aiappbridge.android

import java.nio.charset.StandardCharsets
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.roundToInt

internal object CaptureActionContext {
    private val current = ThreadLocal<String?>()
    private val deferredLease = ThreadLocal<Long?>()
    private val leaseSequence = AtomicLong(0L)

    fun currentActionId(): String? = current.get()

    fun <T> withActionId(actionId: String?, block: () -> T): T {
        val previous = current.get()
        val normalized = actionId?.takeIf { it.isNotBlank() }
        if (normalized == null) {
            current.remove()
        } else {
            current.set(normalized)
        }
        return try {
            block()
        } finally {
            if (previous == null) {
                current.remove()
            } else {
                current.set(previous)
            }
        }
    }

    fun deferActionId(actionId: String?, schedule: ((() -> Unit) -> Boolean)): Boolean {
        val normalized = actionId?.takeIf { it.isNotBlank() } ?: return false
        val lease = leaseSequence.incrementAndGet()
        current.set(normalized)
        deferredLease.set(lease)
        val clear = {
            if (deferredLease.get() == lease) {
                current.remove()
                deferredLease.remove()
            }
        }
        return try {
            schedule(clear).also { scheduled ->
                if (!scheduled) clear()
            }
        } catch (error: Throwable) {
            clear()
            throw error
        }
    }
}

internal data class UiBounds(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
)

internal data class UiFocusSummary(
    val windowType: String,
    val className: String,
    val resourceName: String,
    val bounds: UiBounds,
)

internal data class UiSemanticTextFingerprint(
    val digest: String,
    val length: Int,
)

/**
 * Creates a process-local, salted fingerprint for non-editable UI labels.
 * The digest is only used for in-memory comparison; callers expose length only.
 */
private val semanticDigests = object : ThreadLocal<MessageDigest>() {
    override fun initialValue(): MessageDigest = MessageDigest.getInstance("SHA-256")
}

internal fun semanticTextFingerprint(
    salt: ByteArray,
    text: CharSequence?,
    contentDescription: CharSequence?,
): UiSemanticTextFingerprint? {
    require(salt.isNotEmpty()) { "semantic text salt must not be empty" }
    val values = listOfNotNull(
        text?.takeIf { it.isNotEmpty() }?.let { "text" to it },
        contentDescription?.takeIf { it.isNotEmpty() }?.let { "contentDescription" to it },
    )
    if (values.isEmpty()) return null
    val encoded = ByteArrayOutputStream(256)
    encoded.write(salt)
    var length = 0L
    for ((kind, value) in values) {
        encoded.writeLengthPrefixed(kind)
        encoded.writeLengthPrefixed(value.toString())
        length = (length + value.length).coerceAtMost(Int.MAX_VALUE.toLong())
    }
    return UiSemanticTextFingerprint(semanticDigests.get()!!.digest(encoded.toByteArray()).toHex(), length.toInt())
}

internal data class UiNodeState(
    val key: String,
    val path: String,
    val windowType: String,
    val className: String,
    val resourceName: String,
    val bounds: UiBounds,
    val visible: Boolean,
    val enabled: Boolean,
    val focused: Boolean,
    val selected: Boolean,
    val checked: Boolean?,
    val alpha: Float,
    val translationX: Float,
    val translationY: Float,
    val rotation: Float,
    val inputLength: Int?,
    val semanticTextDigest: String?,
    val semanticTextLength: Int?,
)

internal data class UiFingerprint(
    val hash: String,
    val activityClassName: String,
    val renderVersion: Long,
    val nodeCount: Int,
    val windowCount: Int,
    val dialogCount: Int,
    val popupCount: Int,
    val focusedNode: UiFocusSummary?,
    val truncated: Boolean,
    val windowTypes: List<String>,
    val nodes: List<UiNodeState>,
)

internal data class UiNodeChange(
    val kind: String,
    val node: UiNodeState,
    val fields: List<String>,
)

internal data class UiFingerprintDiffResult(
    val addedCount: Int,
    val removedCount: Int,
    val updatedCount: Int,
    val changes: List<UiNodeChange>,
    val truncated: Boolean,
    val semanticChanged: Boolean,
    val renderChanged: Boolean,
)

internal object UiFingerprintDiff {
    private val renderFields = setOf(
        "bounds",
        "alpha",
        "translationX",
        "translationY",
        "rotation",
    )

    fun between(previous: UiFingerprint, current: UiFingerprint, maxChanges: Int): UiFingerprintDiffResult {
        require(maxChanges > 0) { "maxChanges must be positive" }
        val previousByKey = previous.nodes.associateBy { it.key }
        val currentByKey = current.nodes.associateBy { it.key }
        var addedCount = 0
        var removedCount = 0
        var updatedCount = 0
        var semanticChanged = false
        var renderChanged = previous.renderVersion != current.renderVersion
        val changes = mutableListOf<UiNodeChange>()

        current.nodes.forEach { node ->
            val before = previousByKey[node.key]
            if (before == null) {
                addedCount += 1
                if (changes.size < maxChanges) {
                    changes.add(UiNodeChange("added", node, emptyList()))
                }
                return@forEach
            }
            val fields = changedFields(before, node)
            if (fields.isNotEmpty()) {
                updatedCount += 1
                if (fields.any { it in renderFields }) renderChanged = true
                // Unknown future fields default to semantic so feedback never
                // claims a meaningful state change was animation-only.
                if (fields.any { it !in renderFields }) semanticChanged = true
                if (changes.size < maxChanges) {
                    changes.add(UiNodeChange("updated", node, fields))
                }
            }
        }
        previous.nodes.forEach { node ->
            if (!currentByKey.containsKey(node.key)) {
                removedCount += 1
                semanticChanged = true
                if (changes.size < maxChanges) {
                    changes.add(UiNodeChange("removed", node, emptyList()))
                }
            }
        }

        return UiFingerprintDiffResult(
            addedCount = addedCount,
            removedCount = removedCount,
            updatedCount = updatedCount,
            changes = changes,
            truncated = addedCount + removedCount + updatedCount > changes.size,
            semanticChanged = semanticChanged || addedCount > 0 || removedCount > 0,
            renderChanged = renderChanged,
        )
    }

    private fun changedFields(before: UiNodeState, after: UiNodeState): List<String> {
        val fields = mutableListOf<String>()
        if (before.bounds != after.bounds) fields.add("bounds")
        if (before.visible != after.visible) fields.add("visible")
        if (before.enabled != after.enabled) fields.add("enabled")
        if (before.focused != after.focused) fields.add("focused")
        if (before.selected != after.selected) fields.add("selected")
        if (before.checked != after.checked) fields.add("checked")
        if (before.alpha != after.alpha) fields.add("alpha")
        if (before.translationX != after.translationX) fields.add("translationX")
        if (before.translationY != after.translationY) fields.add("translationY")
        if (before.rotation != after.rotation) fields.add("rotation")
        if (before.inputLength != after.inputLength) fields.add("inputLength")
        if (before.semanticTextDigest != after.semanticTextDigest) fields.add("semanticText")
        if (before.semanticTextLength != after.semanticTextLength) fields.add("semanticTextLength")
        return fields
    }
}

internal enum class UiObservationSignalKind {
    CHANGED,
    STABLE,
}

internal data class UiObservationSignal(
    val kind: UiObservationSignalKind,
    val current: UiFingerprint,
    val previous: UiFingerprint?,
    val stableForMs: Long,
)

internal class UiStabilityTracker(
    private val stableAfterMs: Long,
) {
    private var current: UiFingerprint? = null
    private var previous: UiFingerprint? = null
    private var lastChangedAtMs: Long? = null
    private var stableEmitted = true

    init {
        require(stableAfterMs > 0L) { "stableAfterMs must be positive" }
    }

    fun observe(fingerprint: UiFingerprint, nowMs: Long): UiObservationSignal? {
        val existing = current
        if (existing == null) {
            current = fingerprint
            return null
        }
        if (existing.hash != fingerprint.hash) {
            previous = existing
            current = fingerprint
            lastChangedAtMs = nowMs
            stableEmitted = false
            return UiObservationSignal(
                kind = UiObservationSignalKind.CHANGED,
                current = fingerprint,
                previous = existing,
                stableForMs = 0L,
            )
        }
        current = fingerprint
        return poll(nowMs)
    }

    fun poll(nowMs: Long): UiObservationSignal? {
        val fingerprint = current ?: return null
        val changedAtMs = lastChangedAtMs ?: return null
        val stableForMs = (nowMs - changedAtMs).coerceAtLeast(0L)
        if (stableEmitted || stableForMs < stableAfterMs) {
            return null
        }
        stableEmitted = true
        return UiObservationSignal(
            kind = UiObservationSignalKind.STABLE,
            current = fingerprint,
            previous = previous,
            stableForMs = stableForMs,
        )
    }
}

/**
 * Builds a deterministic UI fingerprint without retaining a serialized tree or view text.
 */
internal class UiFingerprintAccumulator(
    private val renderVersion: Long,
) {
    // Encode on the managed side and hash once. Updating a native digest once
    // per length byte/field caused over 100,000 JNI calls for a 600-node tree.
    private val encoded = UiDigestEncoder()
    private var finished = false
    private var activityClassName = ""
    private var nodeCount = 0
    private var windowCount = 0
    private var dialogCount = 0
    private var popupCount = 0
    private var focusedNode: UiFocusSummary? = null
    private var truncated = false
    private val windowTypes = mutableListOf<String>()
    private val nodes = mutableListOf<UiNodeState>()

    init {
        addField("renderVersion", renderVersion.toString())
    }

    fun addActivity(className: String) {
        activityClassName = className
        addField("activity", className)
    }

    fun addWindow(
        index: Int,
        type: String,
        className: String,
        bounds: UiBounds,
        visible: Boolean,
    ) {
        windowCount += 1
        windowTypes.add(type)
        when (type) {
            "dialog" -> dialogCount += 1
            "popup" -> popupCount += 1
        }
        addField("window.index", index.toString())
        addField("window.type", type)
        addField("window.class", className)
        addBounds("window.bounds", bounds)
        addField("window.visible", visible.toString())
    }

    @Suppress("LongParameterList")
    fun addNode(
        path: String,
        windowType: String,
        className: String,
        resourceName: String,
        bounds: UiBounds,
        visible: Boolean,
        enabled: Boolean,
        focused: Boolean,
        selected: Boolean,
        checked: Boolean?,
        alpha: Float,
        translationX: Float,
        translationY: Float,
        rotation: Float,
        inputLength: Int?,
        semanticTextDigest: String?,
        semanticTextLength: Int?,
    ) {
        nodeCount += 1
        val normalizedAlpha = normalize(alpha, 100)
        val normalizedTranslationX = normalize(translationX, 10)
        val normalizedTranslationY = normalize(translationY, 10)
        val normalizedRotation = normalize(rotation, 10)
        val node = UiNodeState(
            key = "$windowType|$path|$className|$resourceName",
            path = path,
            windowType = windowType,
            className = className,
            resourceName = resourceName,
            bounds = bounds,
            visible = visible,
            enabled = enabled,
            focused = focused,
            selected = selected,
            checked = checked,
            alpha = normalizedAlpha,
            translationX = normalizedTranslationX,
            translationY = normalizedTranslationY,
            rotation = normalizedRotation,
            inputLength = inputLength,
            semanticTextDigest = semanticTextDigest,
            semanticTextLength = semanticTextLength,
        )
        nodes.add(node)
        addField("node.path", path)
        addField("node.window", windowType)
        addField("node.class", className)
        addField("node.resource", resourceName)
        addBounds("node.bounds", bounds)
        addField("node.visible", visible.toString())
        addField("node.enabled", enabled.toString())
        addField("node.focused", focused.toString())
        addField("node.selected", selected.toString())
        addField("node.checked", checked?.toString() ?: "na")
        addField("node.alpha", normalizedAlpha.toString())
        addField("node.translationX", normalizedTranslationX.toString())
        addField("node.translationY", normalizedTranslationY.toString())
        addField("node.rotation", normalizedRotation.toString())
        addField("node.inputLength", inputLength?.toString() ?: "na")
        addField("node.semanticTextDigest", semanticTextDigest ?: "na")
        addField("node.semanticTextLength", semanticTextLength?.toString() ?: "na")
        if (focused) {
            focusedNode = UiFocusSummary(windowType, className, resourceName, bounds)
        }
    }

    fun markTruncated() {
        if (truncated) {
            return
        }
        truncated = true
        addField("truncated", "true")
    }

    fun finish(): UiFingerprint {
        check(!finished) { "UI fingerprint accumulator already finished" }
        finished = true
        return UiFingerprint(
            hash = encoded.finish(),
            activityClassName = activityClassName,
            renderVersion = renderVersion,
            nodeCount = nodeCount,
            windowCount = windowCount,
            dialogCount = dialogCount,
            popupCount = popupCount,
            focusedNode = focusedNode,
            truncated = truncated,
            windowTypes = windowTypes.toList(),
            nodes = nodes.toList(),
        )
    }

    private fun addBounds(prefix: String, bounds: UiBounds) {
        addField(prefix, "${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}")
    }

    private fun addField(name: String, value: String) {
        check(!finished) { "UI fingerprint accumulator already finished" }
        encoded.field(name, value)
    }

    private fun quantize(value: Float, scale: Int): Int {
        return if (value.isFinite()) (value * scale).roundToInt() else 0
    }

    private fun normalize(value: Float, scale: Int): Float {
        return quantize(value, scale).toFloat() / scale.toFloat()
    }
}

private fun ByteArray.toHex(): String {
    val alphabet = "0123456789abcdef"
    val output = CharArray(size * 2)
    forEachIndexed { index, byte ->
        val value = byte.toInt() and 0xff
        output[index * 2] = alphabet[value ushr 4]
        output[(index * 2) + 1] = alphabet[value and 0x0f]
    }
    return String(output)
}

private fun ByteArrayOutputStream.writeLengthPrefixed(value: String) {
    val bytes = value.toByteArray(StandardCharsets.UTF_8)
    write(bytes.size ushr 24)
    write(bytes.size ushr 16)
    write(bytes.size ushr 8)
    write(bytes.size)
    write(bytes)
}

/** Small bounded staging buffer; field names are fixed and encoded once. */
private class UiDigestEncoder {
    private val digest = MessageDigest.getInstance("SHA-256")
    private val buffer = ByteArray(8192)
    private var used = 0

    fun field(name: String, value: String) {
        write(requireNotNull(names[name]))
        write(value.toByteArray(StandardCharsets.UTF_8))
    }

    private fun write(bytes: ByteArray) {
        if (used + 4 > buffer.size) flush()
        buffer[used++] = (bytes.size ushr 24).toByte()
        buffer[used++] = (bytes.size ushr 16).toByte()
        buffer[used++] = (bytes.size ushr 8).toByte()
        buffer[used++] = bytes.size.toByte()
        var offset = 0
        while (offset < bytes.size) {
            val count = minOf(bytes.size - offset, buffer.size - used)
            System.arraycopy(bytes, offset, buffer, used, count)
            used += count
            offset += count
            if (used == buffer.size) flush()
        }
    }

    private fun flush() { digest.update(buffer, 0, used); used = 0 }
    fun finish(): String { flush(); return digest.digest().toHex() }

    companion object {
        private val names = listOf(
            "renderVersion", "activity", "window.index", "window.type", "window.class", "window.bounds", "window.visible",
            "node.path", "node.window", "node.class", "node.resource", "node.bounds", "node.visible", "node.enabled",
            "node.focused", "node.selected", "node.checked", "node.alpha", "node.translationX", "node.translationY",
            "node.rotation", "node.inputLength", "node.semanticTextDigest", "node.semanticTextLength", "truncated",
        ).associateWith { it.toByteArray(StandardCharsets.UTF_8) }
    }
}
