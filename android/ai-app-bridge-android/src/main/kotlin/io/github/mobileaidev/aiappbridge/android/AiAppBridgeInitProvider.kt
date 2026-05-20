package io.github.mobileaidev.aiappbridge.android

import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.content.pm.ApplicationInfo
import android.database.Cursor
import android.net.Uri
import android.os.Process
import android.webkit.WebView
import java.io.File

class AiAppBridgeInitProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        val appContext = context?.applicationContext ?: return true
        val debuggable =
            appContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        if (debuggable) {
            enableWebViewDebugging()
        }
        if (debuggable && isMainProcess(appContext)) {
            AiAppBridge.start(appContext)
        }
        return true
    }

    private fun enableWebViewDebugging() {
        try {
            WebView.setWebContentsDebuggingEnabled(true)
        } catch (_: Throwable) {
            // Some OEM WebView implementations can throw before WebView is ready.
        }
    }

    /**
     * Only start the bridge server in the main process to avoid port conflicts
     * when the host app uses multiple processes (e.g. :push, :webview, :remote).
     */
    private fun isMainProcess(context: android.content.Context): Boolean {
        val pid = Process.myPid()
        val processName = try {
            // API 28+ has Application.getProcessName(), fall back to /proc for older APIs
            if (android.os.Build.VERSION.SDK_INT >= 28) {
                Application.getProcessName()
            } else {
                File("/proc/$pid/cmdline").readText().trim('\u0000')
            }
        } catch (_: Throwable) {
            null
        }
        return processName == null || processName == context.packageName
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = 0
}

