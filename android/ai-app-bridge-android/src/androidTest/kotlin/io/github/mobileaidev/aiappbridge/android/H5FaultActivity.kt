package io.github.mobileaidev.aiappbridge.android

import android.app.Activity
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

// Fault controls live only in the instrumentation APK, never in the shipped SDK.
class H5FaultActivity : Activity() {
    lateinit var root: LinearLayout
    lateinit var webView: EvaluationWebView
    val ready = CountDownLatch(1)
    val callbackHeld = CountDownLatch(1)
    val writes = AtomicInteger()
    val changedText = AtomicReference<String?>(null)
    var held: (() -> Unit)? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 100, 0, 50) }
        webView = EvaluationWebView(this).apply {
            settings.javaScriptEnabled = true
            addJavascriptInterface(object {
                @JavascriptInterface fun mark(value: Int) { writes.set(value) }
                @JavascriptInterface fun text(value: String) { changedText.set(value) }
            }, "Witness")
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) { ready.countDown() }
            }
        }
        root.addView(webView, LinearLayout.LayoutParams(-1, 0, 1f)); setContentView(root)
        AiAppBridge.start(this)
        webView.loadDataWithBaseURL("https://bridge.test/", """
            <html><head><title>H5 execution fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
            <body><h1>H5 execution fixture</h1><p id="count">0</p>
            <button id="count-button" onclick="window.aabExecutionCount=(window.aabExecutionCount||0)+1;Witness.mark(window.aabExecutionCount);document.getElementById('count').innerText=window.aabExecutionCount">Count</button>
            <input id="editor" aria-label="Editor label" value="initial" onchange="Witness.text(this.value)"></body></html>
        """.trimIndent(), "text/html", "UTF-8", null)
    }
    inner class EvaluationWebView(activity: Activity) : WebView(activity) {
        var holdProbe = false
        var throwAfterActionSubmission = false
        override fun evaluateJavascript(script: String, resultCallback: ValueCallback<String>?) {
            super.evaluateJavascript(script) { raw ->
                if (script.contains("hold_callback") || holdProbe && script.contains("\"operation\":\"prepare\"")) {
                    holdProbe = false
                    held = { resultCallback?.onReceiveValue(raw) }; callbackHeld.countDown()
                } else resultCallback?.onReceiveValue(raw)
            }
            if (throwAfterActionSubmission && script.contains("\"operation\":\"action\"")) {
                throwAfterActionSubmission = false
                throw IllegalStateException("fixture failure after original submission")
            }
        }
    }
}
