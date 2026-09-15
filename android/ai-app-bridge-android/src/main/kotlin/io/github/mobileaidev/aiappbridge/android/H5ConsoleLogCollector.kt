package io.github.mobileaidev.aiappbridge.android

import android.app.Activity
import android.os.Handler
import android.view.View
import android.view.ViewGroup
import org.json.JSONArray
import org.json.JSONTokener
import java.util.IdentityHashMap

internal data class H5ConsoleLine(
    val method: String,
    val message: String,
    val atMs: Long,
)

internal class H5ConsolePage(
    val identity: Any? = null,
    val evaluate: (script: String, callback: (String?) -> Unit) -> Unit,
)

internal object H5ConsoleScripts {
    const val INSTALL =
        "(function(){if(window.__aabConsoleHook)return 0;window.__aabConsoleHook={};" +
            "window.__aabConsoleBuf=[];var names=['log','info','warn','error','debug'];" +
            "names.forEach(function(name){var original=console[name];var wrapped=console[name]=function(){" +
            "var args=Array.prototype.slice.call(arguments);var buf=window.__aabConsoleBuf;" +
            "buf.push({method:name,message:args.map(function(value){return value==null?'':String(value);}).join(' '),atMs:Date.now()});" +
            "if(buf.length>1000)buf.shift();if(original)return original.apply(console,arguments);};" +
            "window.__aabConsoleHook[name]={original:original,wrapped:wrapped};});return 1;})()"

    const val UNINSTALL =
        "(function(){var hooks=window.__aabConsoleHook;if(!hooks)return;Object.keys(hooks).forEach(function(name){" +
            "if(console[name]===hooks[name].wrapped)console[name]=hooks[name].original;});" +
            "delete window.__aabConsoleHook;delete window.__aabConsoleBuf;})()"

    const val DRAIN =
        "(function(){var buf=window.__aabConsoleBuf||[];window.__aabConsoleBuf=[];return JSON.stringify(buf);})()"
}

internal object H5ConsoleDrainParser {
    fun parse(raw: String?): List<H5ConsoleLine> {
        if (raw.isNullOrBlank() || raw == "null" || raw == "undefined") {
            return emptyList()
        }
        val array = try {
            val token = JSONTokener(raw.trim()).nextValue()
            when (token) {
                is JSONArray -> token
                is String -> JSONArray(token)
                else -> return emptyList()
            }
        } catch (_: Throwable) {
            return emptyList()
        }
        val lines = ArrayList<H5ConsoleLine>(array.length())
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            lines.add(
                H5ConsoleLine(
                    method = item.optString("method", "log"),
                    message = item.optString("message", ""),
                    atMs = item.optLong("atMs", 0L),
                ),
            )
        }
        return lines
    }
}

internal fun drainH5Pages(pages: List<H5ConsolePage>, persist: (H5ConsoleLine) -> Unit) {
    pages.forEach { page ->
        page.evaluate(H5ConsoleScripts.INSTALL) {
            page.evaluate(H5ConsoleScripts.DRAIN) { raw ->
                H5ConsoleDrainParser.parse(raw).forEach(persist)
            }
        }
    }
}

internal object AndroidWebViewPages {
    fun activityRoots(activity: Activity): List<View> {
        val activityRoot = activity.window?.decorView
        val reflected = reflectWindowViews()
        if (reflected.isEmpty()) {
            return listOfNotNull(activityRoot)
        }
        return reflected
    }

    fun discover(
        roots: List<View>,
        adapters: List<AiAppBridge.WebViewAdapter>,
    ): List<H5ConsolePage> {
        val pages = ArrayList<H5ConsolePage>()
        val seen = IdentityHashMap<View, Boolean>()
        roots.forEach { root -> collect(root, adapters, pages, seen) }
        return pages
    }

    private fun collect(
        view: View,
        adapters: List<AiAppBridge.WebViewAdapter>,
        pages: MutableList<H5ConsolePage>,
        seen: IdentityHashMap<View, Boolean>,
    ) {
        if (seen.put(view, true) != null) {
            return
        }
        val adapter = adapters.firstOrNull { candidate ->
            try {
                candidate.matches(view)
            } catch (_: Throwable) {
                false
            }
        }
        if (adapter != null) {
            pages.add(
                H5ConsolePage(identity = view) { script, callback ->
                    adapter.evaluateJavascript(view, script, callback)
                },
            )
            return
        }
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                collect(view.getChildAt(index), adapters, pages, seen)
            }
        }
    }

    private fun reflectWindowViews(): List<View> {
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
}

internal class H5ConsoleLogCollector(
    private val mainHandler: Handler,
    private val intervalMs: Long,
    private val discover: () -> List<H5ConsolePage>,
    private val persist: (H5ConsoleLine) -> Unit,
) {
    @Volatile
    private var started = false
    private var generation = 0
    private var inFlight = false
    private val installed = IdentityHashMap<Any, H5ConsolePage>()
    private val expiry = Runnable { stop() }

    private val tick = object : Runnable {
        override fun run() {
            if (!started) {
                return
            }
            try {
                if (!inFlight) {
                    val pages = discover()
                    val owner = generation
                    var remaining = pages.size
                    inFlight = pages.isNotEmpty()
                    pages.forEach { page ->
                        installed[page.identity ?: page] = page
                        page.evaluate(H5ConsoleScripts.INSTALL) {
                            if (started && generation == owner) page.evaluate(H5ConsoleScripts.DRAIN) { raw ->
                                if (started && generation == owner) {
                                    H5ConsoleDrainParser.parse(raw).forEach(persist)
                                    remaining--
                                    if (remaining == 0) inFlight = false
                                }
                            }
                        }
                    }
                }
            } catch (_: Throwable) {
                inFlight = false
            }
            mainHandler.postDelayed(this, intervalMs)
        }
    }

    fun start(durationMs: Long) {
        require(durationMs in 1..5000)
        stop()
        started = true
        mainHandler.postDelayed(expiry, durationMs)
        mainHandler.post(tick)
    }

    fun stop() {
        started = false
        generation++
        inFlight = false
        mainHandler.removeCallbacks(tick)
        mainHandler.removeCallbacks(expiry)
        installed.values.forEach { page ->
            try { page.evaluate(H5ConsoleScripts.UNINSTALL) {} } catch (_: RuntimeException) { }
        }
        installed.clear()
    }
}
