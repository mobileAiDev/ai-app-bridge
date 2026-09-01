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
    val evaluate: (script: String, callback: (String?) -> Unit) -> Unit,
)

internal object H5ConsoleScripts {
    const val INSTALL =
        "(function(){if(window.__aabConsoleHook)return 0;window.__aabConsoleHook=true;" +
            "window.__aabConsoleBuf=[];var names=['log','info','warn','error','debug'];" +
            "names.forEach(function(name){var original=console[name];console[name]=function(){" +
            "var args=Array.prototype.slice.call(arguments);var buf=window.__aabConsoleBuf;" +
            "buf.push({method:name,message:args.map(function(value){return value==null?'':String(value);}).join(' '),atMs:Date.now()});" +
            "if(buf.length>1000)buf.shift();if(original)return original.apply(console,arguments);};});return 1;})()"

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
                H5ConsolePage { script, callback ->
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

    private val tick = object : Runnable {
        override fun run() {
            if (!started) {
                return
            }
            try {
                drainH5Pages(discover(), persist)
            } catch (_: Throwable) {
            }
            mainHandler.postDelayed(this, intervalMs)
        }
    }

    fun start() {
        if (started) {
            return
        }
        started = true
        mainHandler.post(tick)
    }

    fun stop() {
        started = false
        mainHandler.removeCallbacks(tick)
    }
}
