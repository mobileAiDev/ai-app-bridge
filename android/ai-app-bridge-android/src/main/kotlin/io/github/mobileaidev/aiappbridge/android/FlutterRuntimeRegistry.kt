package io.github.mobileaidev.aiappbridge.android

import java.lang.ref.WeakReference
import org.json.JSONObject

/** Handler and snapshot are one Activity-owned runtime, never independent globals. */
internal class FlutterRuntimeRegistry<A : Any, H : Any>(private val foreground: () -> A?) {
    data class Snapshot(val full: String = "{}", val status: String = "{}", val epoch: String? = null) {
        companion object {
            fun parse(json: String): Snapshot {
                val value = JSONObject(json)
                val epoch = value.optJSONObject("layout")?.optJSONObject("operable")?.optString("runtimeEpoch")
                val full = value.toString()
                value.remove("layout"); value.remove("uiObservation")
                return Snapshot(full, value.toString(), epoch)
            }
        }
    }
    data class Selection<H>(val handler: H, val snapshot: Snapshot, val identity: Any)
    private class Binding<A : Any, H>(val owner: WeakReference<A>?, val handler: H, var snapshot: Snapshot)
    private data class Identity(val binding: Any, val generation: Long)
    private val bindings = mutableListOf<Binding<A, H>>()
    private var legacy: Binding<A, H>? = null
    private var legacySnapshot = Snapshot()
    private var activityBindingsUsed = false
    private var selected: Binding<A, H>? = null
    private var selectedOwner: WeakReference<A>? = null
    private var generation = 0L

    @Synchronized fun register(owner: A, handler: H) {
        activityBindingsUsed = true
        bindings.removeAll { it.owner?.get() == null || it.owner?.get() === owner || it.handler === handler }
        bindings.add(Binding(WeakReference(owner), handler, Snapshot()))
        refreshSelection()
    }

    // Existing unscoped API remains available for existing clients. It cannot
    // overwrite any Activity-bound runtime, even after its Activity detaches.
    @Synchronized fun setLegacyHandler(handler: H?) {
        legacy = handler?.let { Binding(null, it, legacySnapshot) }
        refreshSelection()
    }
    @Synchronized fun updateLegacySnapshot(snapshot: Snapshot) {
        legacySnapshot = snapshot
        legacy?.snapshot = snapshot
    }
    @Synchronized fun updateSnapshot(handler: H, snapshot: Snapshot): Boolean {
        val binding = bindings.firstOrNull { it.handler === handler } ?: return false
        binding.snapshot = snapshot
        return true
    }
    @Synchronized fun remove(handler: H): Boolean {
        val removed = bindings.removeAll { it.handler === handler }
        val wasLegacy = legacy?.handler === handler
        if (wasLegacy) legacy = null
        refreshSelection()
        return removed || wasLegacy
    }
    @Synchronized fun removeActivity(owner: A) {
        bindings.removeAll { it.owner?.get() == null || it.owner?.get() === owner }
        refreshSelection()
    }

    // Called after lifecycle transitions as well as reads, so A -> B -> A
    // invalidates an outstanding A observation even if no read occurred at B.
    @Synchronized fun refreshSelection() {
        val owner = foreground()
        val binding = if (activityBindingsUsed) bindings.firstOrNull { it.owner?.get() === owner && owner != null } else legacy
        if (selected !== binding || selectedOwner?.get() !== owner) {
            selected = binding
            selectedOwner = owner?.let(::WeakReference)
            generation++
        }
    }
    @Synchronized fun current(): Selection<H>? {
        refreshSelection()
        return selected?.let { Selection(it.handler, it.snapshot, Identity(it, generation)) }
    }
    @Synchronized fun snapshot(): Snapshot = current()?.snapshot ?: if (activityBindingsUsed) Snapshot() else legacySnapshot
    @Synchronized fun isCurrent(selection: Selection<H>): Boolean = current()?.identity == selection.identity
    @Synchronized fun acceptObservation(selection: Selection<H>, snapshot: Snapshot): Boolean {
        if (!isCurrent(selection)) return false
        selected!!.snapshot = snapshot
        return true
    }
}
