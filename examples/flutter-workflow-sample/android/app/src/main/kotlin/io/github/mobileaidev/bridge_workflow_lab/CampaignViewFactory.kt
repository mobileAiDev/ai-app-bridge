package io.github.mobileaidev.bridge_workflow_lab

import android.content.Context
import android.net.Uri
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory

class CampaignViewFactory(private val close: () -> Unit) : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
    override fun create(context: Context, viewId: Int, args: Any?): PlatformView {
        val config = args as Map<*, *>
        val web = WebView(context).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = WebViewClient()
            contentDescription = "城市生活活动网页"
            addJavascriptInterface(object { @JavascriptInterface fun close() = this@CampaignViewFactory.close() }, "CityLab")
            loadUrl("${config["base"]}/campaign.html?run=${Uri.encode(config["run"] as String)}&session=${Uri.encode(config["session"] as String)}")
        }
        return object : PlatformView {
            override fun getView(): View = web
            override fun dispose() { web.stopLoading(); web.removeJavascriptInterface("CityLab"); web.destroy() }
        }
    }
}
