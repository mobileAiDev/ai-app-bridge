package io.github.mobileaidev.aiappbridge.android

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.WindowManager
import android.widget.Checkable
import android.widget.EditText
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.Collections
import java.util.IdentityHashMap
import java.util.LinkedHashSet
import java.util.concurrent.atomic.AtomicLong
import java.security.SecureRandom

/**
 * Observes lightweight Android UI state without retaining text, screenshots, or full trees.
 */
internal class AndroidUiObserver(
    private val mainHandler: Handler,
    private val eventSink: (category: String, name: String, data: JSONObject) -> Unit,
    private val minSampleIntervalMs: Long = 100L,
    private val stableAfterMs: Long = 350L,
    private val discoveryIntervalMs: Long = 500L,
    private val maxNodes: Int = 600,
    private val maxDepth: Int = 32,
    private val maxChangedNodes: Int = 24,
) {
    private val tracker = UiStabilityTracker(stableAfterMs)
    private val renderVersion = AtomicLong(0L)
    private val semanticTextSalt = ByteArray(32).also { SecureRandom().nextBytes(it) }
    private val pendingTriggers = LinkedHashSet<String>()
    private val observedRoots = mutableListOf<ObservedRoot>()
    private var activityRef = WeakReference<Activity>(null)
    private var active = false
    private var samplePending = false
    private var lastSampleAtMs = 0L

    private val sampleRunnable = Runnable {
        samplePending = false
        performSample()
    }
    private val stableRunnable = Runnable {
        if (!active) {
            return@Runnable
        }
        if (samplePending) {
            mainHandler.removeCallbacks(sampleRunnable)
            samplePending = false
        }
        pendingTriggers.add("stability-check")
        performSample()
    }
    private val discoveryRunnable = object : Runnable {
        override fun run() {
            if (!active) {
                return
            }
            requestSample("discovery")
            mainHandler.postDelayed(this, discoveryIntervalMs)
        }
    }

    fun attach(activity: Activity, reason: String) {
        onMain {
            attachOnMain(activity, reason)
        }
    }

    fun onLifecycle(activity: Activity, phase: String) {
        onMain {
            emit(
                category = "lifecycle",
                name = "activity.$phase",
                data = JSONObject()
                    .put("activity", activity.javaClass.name)
                    .put("phase", phase),
            )
            when (phase) {
                "resumed" -> attachOnMain(activity, "lifecycle")
                "stopped", "destroyed" -> detachIfCurrent(activity)
            }
        }
    }

    fun noteTap(
        x: Float,
        y: Float,
        windowType: String,
        target: JSONObject?,
        handledDown: Boolean,
        handledUp: Boolean,
    ) {
        onMain {
            emit(
                category = "ui",
                name = "ui.interaction",
                data = JSONObject()
                    .put("type", "tap")
                    .put("x", x.toDouble())
                    .put("y", y.toDouble())
                    .put("windowType", windowType)
                    .put("target", target ?: JSONObject.NULL)
                    .put("handledDown", handledDown)
                    .put("handledUp", handledUp),
            )
            requestSample("interaction.tap")
        }
    }

    fun noteInput(
        inputLength: Int,
        windowType: String,
        targetClassName: String,
        targetResourceName: String,
    ) {
        onMain {
            emit(
                category = "ui",
                name = "ui.interaction",
                data = JSONObject()
                    .put("type", "input")
                    .put("inputLength", inputLength)
                    .put("windowType", windowType)
                    .put("targetClassName", targetClassName)
                    .put("targetResourceName", targetResourceName),
            )
            requestSample("interaction.input")
        }
    }

    fun stop() {
        onMain {
            stopOnMain()
        }
    }

    private fun attachOnMain(activity: Activity, reason: String) {
        val current = activityRef.get()
        if (active && current === activity) {
            requestSample("attach.$reason")
            return
        }
        stopOnMain()
        activityRef = WeakReference(activity)
        active = true
        lastSampleAtMs = SystemClock.uptimeMillis() - minSampleIntervalMs
        refreshRootListeners(discoverWindowRoots(activity))
        requestSample("attach.$reason")
        mainHandler.postDelayed(discoveryRunnable, discoveryIntervalMs)
    }

    private fun detachIfCurrent(activity: Activity) {
        if (activityRef.get() === activity) {
            stopOnMain()
        }
    }

    private fun stopOnMain() {
        active = false
        samplePending = false
        mainHandler.removeCallbacks(sampleRunnable)
        mainHandler.removeCallbacks(stableRunnable)
        mainHandler.removeCallbacks(discoveryRunnable)
        pendingTriggers.clear()
        observedRoots.forEach { it.detach() }
        observedRoots.clear()
        activityRef.clear()
    }

    private fun requestSample(trigger: String) {
        if (!active) {
            return
        }
        pendingTriggers.add(trigger)
        if (samplePending) {
            return
        }
        val nowMs = SystemClock.uptimeMillis()
        val delayMs = (minSampleIntervalMs - (nowMs - lastSampleAtMs)).coerceAtLeast(0L)
        samplePending = true
        mainHandler.postDelayed(sampleRunnable, delayMs)
    }

    private fun performSample() {
        if (!active) {
            return
        }
        val activity = activityRef.get()
        if (activity == null || activity.isFinishing) {
            stopOnMain()
            return
        }
        val triggers = pendingTriggers.joinToString(",")
        pendingTriggers.clear()
        val nowMs = SystemClock.uptimeMillis()
        lastSampleAtMs = nowMs
        val roots = discoverWindowRoots(activity)
        refreshRootListeners(roots)
        val fingerprint = captureFingerprint(activity, roots)
        val signal = tracker.observe(fingerprint, nowMs) ?: return
        emitSignal(signal, triggers)
        if (signal.kind == UiObservationSignalKind.CHANGED) {
            mainHandler.removeCallbacks(stableRunnable)
            mainHandler.postDelayed(stableRunnable, stableAfterMs)
        }
    }

    private fun emitSignal(signal: UiObservationSignal, triggers: String) {
        val current = signal.current
        val data = JSONObject()
            .put("fingerprint", current.hash)
            .put("activity", current.activityClassName)
            .put("renderVersion", current.renderVersion)
            .put("nodeCount", current.nodeCount)
            .put("windowCount", current.windowCount)
            .put("dialogCount", current.dialogCount)
            .put("popupCount", current.popupCount)
            .put("windowTypes", JSONArray(current.windowTypes))
            .put("truncated", current.truncated)
            .put("trigger", triggers)
        signal.previous?.let {
            data
                .put("previousFingerprint", it.hash)
                .put("previousActivity", it.activityClassName)
        }
        current.focusedNode?.let { data.put("focused", focusJson(it)) }
        if (signal.kind == UiObservationSignalKind.CHANGED && signal.previous != null) {
            val diff = UiFingerprintDiff.between(signal.previous, current, maxChangedNodes)
            data
                .put("addedNodeCount", diff.addedCount)
                .put("removedNodeCount", diff.removedCount)
                .put("updatedNodeCount", diff.updatedCount)
                .put("changesTruncated", diff.truncated)
                .put("semanticChanged", diff.semanticChanged)
                .put("renderChanged", diff.renderChanged)
                .put(
                    "renderOnly",
                    diff.renderChanged && !diff.semanticChanged,
                )
                .put(
                    "changes",
                    JSONArray().apply {
                        diff.changes.forEach { change ->
                            put(
                                JSONObject()
                                    .put("kind", change.kind)
                                    .put("fields", JSONArray(change.fields))
                                    .put("node", nodeJson(change.node)),
                            )
                        }
                    },
                )
        }
        if (signal.kind == UiObservationSignalKind.STABLE) {
            data.put("stableForMs", signal.stableForMs)
        }
        emit(
            category = "ui",
            name = if (signal.kind == UiObservationSignalKind.CHANGED) "ui.changed" else "ui.stable",
            data = data,
        )
    }

    private fun captureFingerprint(activity: Activity, roots: List<ObservedWindow>): UiFingerprint {
        val accumulator = UiFingerprintAccumulator(renderVersion.get())
        accumulator.addActivity(activity.javaClass.name)
        val counter = NodeCounter()
        roots.forEachIndexed { index, window ->
            accumulator.addWindow(
                index = index,
                type = window.type,
                className = window.root.javaClass.name,
                bounds = boundsForView(window.root),
                visible = window.root.isShown,
            )
            addViewState(
                activity = activity,
                view = window.root,
                windowType = window.type,
                path = index.toString(),
                depth = 0,
                counter = counter,
                accumulator = accumulator,
            )
        }
        if (counter.truncated) {
            accumulator.markTruncated()
        }
        return accumulator.finish()
    }

    private fun addViewState(
        activity: Activity,
        view: View,
        windowType: String,
        path: String,
        depth: Int,
        counter: NodeCounter,
        accumulator: UiFingerprintAccumulator,
    ) {
        if (counter.count >= maxNodes) {
            counter.truncated = true
            return
        }
        counter.count += 1
        val editText = view as? EditText
        val semanticText = if (editText == null) {
            semanticTextFingerprint(
                salt = semanticTextSalt,
                text = (view as? TextView)?.text,
                contentDescription = view.contentDescription,
            )
        } else {
            null
        }
        accumulator.addNode(
            path = path,
            windowType = windowType,
            className = view.javaClass.name,
            resourceName = resourceName(activity, view.id),
            bounds = boundsForView(view),
            visible = view.isShown && view.alpha > 0.01f && view.width > 0 && view.height > 0,
            enabled = view.isEnabled,
            focused = view.isFocused,
            selected = view.isSelected,
            checked = (view as? Checkable)?.isChecked,
            alpha = view.alpha,
            translationX = view.translationX,
            translationY = view.translationY,
            rotation = view.rotation,
            inputLength = editText?.text?.length,
            semanticTextDigest = semanticText?.digest,
            semanticTextLength = semanticText?.length,
        )
        if (view !is ViewGroup || depth >= maxDepth) {
            if (view is ViewGroup && view.childCount > 0) {
                counter.truncated = true
            }
            return
        }
        for (index in 0 until view.childCount) {
            addViewState(
                activity = activity,
                view = view.getChildAt(index),
                windowType = windowType,
                path = "$path/$index",
                depth = depth + 1,
                counter = counter,
                accumulator = accumulator,
            )
            if (counter.count >= maxNodes) {
                if (index < view.childCount - 1) {
                    counter.truncated = true
                }
                return
            }
        }
    }

    private fun refreshRootListeners(roots: List<ObservedWindow>) {
        val iterator = observedRoots.iterator()
        while (iterator.hasNext()) {
            val observed = iterator.next()
            val view = observed.rootRef.get()
            if (view == null || roots.none { it.root === view }) {
                observed.detach()
                iterator.remove()
            }
        }
        roots.forEach { window ->
            if (observedRoots.none { it.rootRef.get() === window.root }) {
                ObservedRoot(window.root).also {
                    it.attach()
                    observedRoots.add(it)
                }
            }
        }
    }

    private fun discoverWindowRoots(activity: Activity): List<ObservedWindow> {
        val activityRoot = activity.window?.decorView ?: return emptyList()
        val roots = mutableListOf<ObservedWindow>()
        val seen = Collections.newSetFromMap(IdentityHashMap<View, Boolean>())
        reflectWindowRoots().forEach { root ->
            if (!root.isAttachedToWindow || root.width <= 0 || root.height <= 0 || !seen.add(root)) {
                return@forEach
            }
            roots.add(ObservedWindow(root, windowType(root, root === activityRoot)))
        }
        if (seen.add(activityRoot)) {
            roots.add(ObservedWindow(activityRoot, "activity"))
        }
        return roots
    }

    private fun reflectWindowRoots(): List<View> {
        return try {
            val globalClass = Class.forName("android.view.WindowManagerGlobal")
            val instance = globalClass.getMethod("getInstance").invoke(null)
            val viewsField = globalClass.getDeclaredField("mViews")
            viewsField.isAccessible = true
            when (val rawViews = viewsField.get(instance)) {
                is List<*> -> rawViews.filterIsInstance<View>()
                is Array<*> -> rawViews.filterIsInstance<View>()
                else -> emptyList()
            }
        } catch (_: Throwable) {
            emptyList()
        }
    }

    private fun windowType(root: View, activityDecor: Boolean): String {
        if (activityDecor) {
            return "activity"
        }
        val params = root.layoutParams as? WindowManager.LayoutParams
        val name = root.javaClass.name
        val title = params?.title?.toString().orEmpty()
        return when {
            name.contains("Popup", ignoreCase = true) ||
                title.contains("Popup", ignoreCase = true) ||
                params?.type == WindowManager.LayoutParams.TYPE_APPLICATION_PANEL ||
                params?.type == WindowManager.LayoutParams.TYPE_APPLICATION_SUB_PANEL -> "popup"
            name.contains("Dialog", ignoreCase = true) ||
                title.contains("Dialog", ignoreCase = true) ||
                params?.type == WindowManager.LayoutParams.TYPE_APPLICATION ||
                params?.type == WindowManager.LayoutParams.TYPE_APPLICATION_ATTACHED_DIALOG -> "dialog"
            else -> "window"
        }
    }

    private fun emitFocusChanged(oldFocus: View?, newFocus: View?) {
        val data = JSONObject()
            .put("old", oldFocus?.let(::viewIdentityJson) ?: JSONObject.NULL)
            .put("new", newFocus?.let(::viewIdentityJson) ?: JSONObject.NULL)
        emit("ui", "ui.focus.changed", data)
    }

    private fun viewIdentityJson(view: View): JSONObject {
        val activity = activityRef.get()
        return JSONObject()
            .put("className", view.javaClass.name)
            .put("resourceName", if (activity == null) "" else resourceName(activity, view.id))
            .put("bounds", boundsJson(boundsForView(view)))
    }

    private fun focusJson(focus: UiFocusSummary): JSONObject {
        return JSONObject()
            .put("windowType", focus.windowType)
            .put("className", focus.className)
            .put("resourceName", focus.resourceName)
            .put("bounds", boundsJson(focus.bounds))
    }

    private fun nodeJson(node: UiNodeState): JSONObject {
        return JSONObject()
            .put("path", node.path)
            .put("windowType", node.windowType)
            .put("className", node.className)
            .put("resourceName", node.resourceName)
            .put("bounds", boundsJson(node.bounds))
            .put("visible", node.visible)
            .put("enabled", node.enabled)
            .put("focused", node.focused)
            .put("selected", node.selected)
            .put("checked", node.checked ?: JSONObject.NULL)
            .put("alpha", node.alpha.toDouble())
            .put("translationX", node.translationX.toDouble())
            .put("translationY", node.translationY.toDouble())
            .put("rotation", node.rotation.toDouble())
            .put("inputLength", node.inputLength ?: JSONObject.NULL)
            // Never expose the salted comparison digest or raw label text.
            .put("semanticTextLength", node.semanticTextLength ?: JSONObject.NULL)
    }

    private fun boundsForView(view: View): UiBounds {
        val location = IntArray(2)
        return try {
            view.getLocationOnScreen(location)
            UiBounds(location[0], location[1], location[0] + view.width, location[1] + view.height)
        } catch (_: RuntimeException) {
            UiBounds(0, 0, view.width, view.height)
        }
    }

    private fun boundsJson(bounds: UiBounds): JSONObject {
        return JSONObject()
            .put("left", bounds.left)
            .put("top", bounds.top)
            .put("right", bounds.right)
            .put("bottom", bounds.bottom)
    }

    private fun resourceName(activity: Activity, id: Int): String {
        if (id == View.NO_ID) {
            return ""
        }
        return try {
            activity.resources.getResourceName(id)
        } catch (_: Throwable) {
            ""
        }
    }

    private fun emit(category: String, name: String, data: JSONObject) {
        try {
            eventSink(category, name, data)
        } catch (_: Throwable) {
            // UI observation must never affect the host app.
        }
    }

    private fun onMain(action: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action()
        } else {
            mainHandler.post(action)
        }
    }

    private inner class ObservedRoot(root: View) {
        val rootRef = WeakReference(root)
        private var observerRef = WeakReference<ViewTreeObserver>(null)
        private val drawListener = ViewTreeObserver.OnDrawListener {
            renderVersion.incrementAndGet()
            requestSample("draw")
        }
        private val layoutListener = ViewTreeObserver.OnGlobalLayoutListener {
            requestSample("layout")
        }
        private val focusListener = ViewTreeObserver.OnGlobalFocusChangeListener { oldFocus, newFocus ->
            emitFocusChanged(oldFocus, newFocus)
            requestSample("focus")
        }
        private val touchModeListener = ViewTreeObserver.OnTouchModeChangeListener { inTouchMode ->
            emit(
                "ui",
                "ui.interaction",
                JSONObject().put("type", "touch_mode").put("inTouchMode", inTouchMode),
            )
            requestSample("touch-mode")
        }

        fun attach() {
            val observer = rootRef.get()?.viewTreeObserver ?: return
            if (!observer.isAlive) {
                return
            }
            observer.addOnDrawListener(drawListener)
            observer.addOnGlobalLayoutListener(layoutListener)
            observer.addOnGlobalFocusChangeListener(focusListener)
            observer.addOnTouchModeChangeListener(touchModeListener)
            observerRef = WeakReference(observer)
        }

        fun detach() {
            val observer = observerRef.get()
            if (observer != null && observer.isAlive) {
                observer.removeOnDrawListener(drawListener)
                observer.removeOnGlobalLayoutListener(layoutListener)
                observer.removeOnGlobalFocusChangeListener(focusListener)
                observer.removeOnTouchModeChangeListener(touchModeListener)
            }
            observerRef.clear()
            rootRef.clear()
        }
    }

    private data class ObservedWindow(
        val root: View,
        val type: String,
    )

    private data class NodeCounter(
        var count: Int = 0,
        var truncated: Boolean = false,
    )
}
