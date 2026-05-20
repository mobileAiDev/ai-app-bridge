package io.github.mobileaidev.aiappbridge.sample.debugbridge

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import io.github.mobileaidev.aiappbridge.android.AiAppBridge
import io.github.mobileaidev.aiappbridge.sample.R
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.Proxy

class DebugBridgeNativeTestActivity : Activity() {
    private var counter = 0
    private lateinit var statusView: TextView
    private lateinit var inputView: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildContentView())
        recordScreenState(action = "created")
        AiAppBridge.recordLog(
            level = "info",
            tag = "NativeBridgeTest",
            message = "native AI app bridge test activity created",
            dataJson = stateJson(action = "created"),
        )
    }

    private fun buildContentView(): ScrollView {
        val root = LinearLayout(this).apply {
            id = R.id.ai_app_native_test_root
            orientation = LinearLayout.VERTICAL
            contentDescription = "ai_app_native_test_root"
            setPadding(dp(20), dp(24), dp(20), dp(24))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
        }

        root.addView(
            TextView(this).apply {
                id = R.id.ai_app_native_test_title
                text = "AiApp Native Bridge Test"
                textSize = 22f
                contentDescription = "native_test_title"
            },
        )
        statusView = TextView(this).apply {
            id = R.id.ai_app_native_test_status
            text = statusText()
            textSize = 18f
            contentDescription = "native_counter_status"
            setPadding(0, dp(18), 0, dp(12))
        }
        root.addView(statusView)

        inputView = EditText(this).apply {
            id = R.id.ai_app_native_test_input
            hint = "Native input"
            setText("native initial value")
            contentDescription = "native_input"
            setSingleLine(true)
        }
        root.addView(inputView)

        root.addView(button("Native Increment", R.id.ai_app_native_test_increment) {
            counter += 1
            statusView.text = statusText()
            recordScreenState(action = "increment")
            AiAppBridge.recordLog(
                level = "info",
                tag = "NativeBridgeTest",
                message = "native counter incremented",
                dataJson = stateJson(action = "increment"),
            )
        })
        root.addView(button("Record Log", R.id.ai_app_native_test_record_log) {
            Log.d(
                "NativeBridgeLogcatTest",
                "manual native logcat fixture input=${inputView.text}",
            )
            AiAppBridge.recordLog(
                level = "debug",
                tag = "NativeBridgeTest",
                message = "manual native log event",
                dataJson = stateJson(action = "record_log"),
            )
        })
        root.addView(button("Record Network", R.id.ai_app_native_test_record_network) {
            AiAppBridge.recordNetwork(
                method = "POST",
                url = "https://debug.local/native-test",
                statusCode = 200,
                durationMs = 37L,
                requestBody = JSONObject()
                    .put("counter", counter)
                    .put("input", inputView.text.toString())
                    .toString(),
                responseBody = JSONObject()
                    .put("ok", true)
                    .put("source", "native-test")
                    .toString(),
                error = null,
            )
        })
        root.addView(button("Run OkHttp Auto Capture", R.id.ai_app_native_test_okhttp_auto) {
            runOkHttpAutoCaptureGet()
        })
        root.addView(button("Run OkHttp Auto POST", R.id.ai_app_native_test_okhttp_auto_post) {
            runOkHttpAutoCapturePost()
        })
        root.addView(button("Run OkHttp Auto Error", R.id.ai_app_native_test_okhttp_auto_error) {
            runOkHttpAutoCaptureError()
        })
        root.addView(button("Record State", R.id.ai_app_native_test_record_state) {
            recordScreenState(action = "record_state")
        })
        root.addView(button("Record Event", View.generateViewId()) {
            AiAppBridge.recordEvent(
                category = "native_test",
                name = "manual_event",
                dataJson = stateJson(action = "record_event"),
            )
        })
        root.addView(button("Open Dialog", View.generateViewId()) {
            showNativeDialog()
        })
        root.addView(button("Request Camera Permission", R.id.ai_app_native_test_request_camera) {
            requestCameraPermission()
        })
        root.addView(button("Request Microphone Permission", R.id.ai_app_native_test_request_microphone) {
            requestMicrophonePermission()
        })
        root.addView(
            WebView(this).apply {
                id = R.id.ai_app_native_test_webview
                contentDescription = "native_h5_webview"
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                }
                loadDataWithBaseURL(
                    "http://debug.local/native-webview",
                    nativeH5Html,
                    "text/html",
                    "UTF-8",
                    null,
                )
            },
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(220),
            ).apply {
                topMargin = dp(16)
                bottomMargin = dp(8)
            },
        )
        for (index in 1..24) {
            root.addView(
                TextView(this).apply {
                    text = "Native List Row $index"
                    textSize = 16f
                    contentDescription = "native_list_row_$index"
                    setPadding(0, dp(8), 0, dp(8))
                },
            )
        }
        root.addView(button("Finish", R.id.ai_app_native_test_finish) {
            finish()
        })

        return ScrollView(this).apply {
            addView(root)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val permission = when (requestCode) {
            requestCameraPermissionCode -> Manifest.permission.CAMERA
            requestMicrophonePermissionCode -> Manifest.permission.RECORD_AUDIO
            else -> return
        }
        val label = when (permission) {
            Manifest.permission.CAMERA -> "Camera"
            else -> "Microphone"
        }
        val key = label.lowercase()
        val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        statusView.text = "$label permission: ${if (granted) "granted" else "denied"}"
        AiAppBridge.recordEvent(
            category = "native_test",
            name = "${key}_permission_result",
            dataJson = JSONObject()
                .put("permission", permission)
                .put("granted", granted)
                .toString(),
        )
        recordScreenState(action = if (granted) "${key}_permission_granted" else "${key}_permission_denied")
    }

    private fun button(text: String, id: Int, action: () -> Unit): Button {
        return Button(this).apply {
            this.id = id
            this.text = text
            contentDescription = text.lowercase().replace(" ", "_")
            setAllCaps(false)
            setOnClickListener { action() }
        }
    }

    private fun recordScreenState(action: String) {
        AiAppBridge.recordState(
            namespace = "native_test",
            key = "screen",
            valueJson = stateJson(action),
        )
    }

    private fun showNativeDialog() {
        AiAppBridge.recordEvent(
            category = "native_test",
            name = "dialog_opened",
            dataJson = stateJson(action = "dialog_opened"),
        )
        AlertDialog.Builder(this)
            .setTitle("Native Dialog Title")
            .setMessage("Native dialog body for bridge perception")
            .setNegativeButton("Dialog Cancel", null)
            .setPositiveButton("Dialog Confirm") { _, _ ->
                AiAppBridge.recordEvent(
                    category = "native_test",
                    name = "dialog_confirmed",
                    dataJson = stateJson(action = "dialog_confirmed"),
                )
                recordScreenState(action = "dialog_confirmed")
            }
            .show()
    }

    private fun requestCameraPermission() {
        requestRuntimePermission(
            permission = Manifest.permission.CAMERA,
            label = "Camera",
            requestCode = requestCameraPermissionCode,
        )
    }

    private fun requestMicrophonePermission() {
        requestRuntimePermission(
            permission = Manifest.permission.RECORD_AUDIO,
            label = "Microphone",
            requestCode = requestMicrophonePermissionCode,
        )
    }

    private fun requestRuntimePermission(permission: String, label: String, requestCode: Int) {
        val key = label.lowercase()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            statusView.text = "$label permission: legacy-granted"
            recordScreenState(action = "${key}_permission_legacy_granted")
            return
        }
        if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
            statusView.text = "$label permission: already granted"
            recordScreenState(action = "${key}_permission_already_granted")
            AiAppBridge.recordEvent(
                category = "native_test",
                name = "${key}_permission_already_granted",
                dataJson = JSONObject()
                    .put("permission", permission)
                    .toString(),
            )
            return
        }
        statusView.text = "$label permission: requesting"
        AiAppBridge.recordEvent(
            category = "native_test",
            name = "${key}_permission_requested",
            dataJson = JSONObject()
                .put("permission", permission)
                .toString(),
        )
        requestPermissions(arrayOf(permission), requestCode)
    }

    private fun runOkHttpAutoCaptureGet() {
        statusView.text = "OkHttp auto GET: running"
        Thread {
            val result = try {
                val request = Request.Builder()
                    .url("http://127.0.0.1:18080/v1/logs?limit=1")
                    .get()
                    .build()
                okHttpClient().newCall(request).execute().use { response ->
                    "OkHttp auto capture: HTTP ${response.code}"
                }
            } catch (error: Throwable) {
                "OkHttp auto capture error: ${error.javaClass.simpleName}"
            }
            runOnUiThread {
                statusView.text = result
            }
        }.start()
    }

    private fun runOkHttpAutoCapturePost() {
        statusView.text = "OkHttp auto POST: running"
        Thread {
            val result = try {
                val payload = JSONObject()
                    .put("category", "native_test")
                    .put("name", "okhttp_auto_post_fixture")
                    .put("data", JSONObject().put("input", inputView.text.toString()))
                    .toString()
                val request = Request.Builder()
                    .url("http://127.0.0.1:18080/v1/events")
                    .post(payload.toRequestBody())
                    .build()
                okHttpClient().newCall(request).execute().use { response ->
                    "OkHttp auto POST: HTTP ${response.code}"
                }
            } catch (error: Throwable) {
                "OkHttp auto POST error: ${error.javaClass.simpleName}"
            }
            runOnUiThread {
                statusView.text = result
            }
        }.start()
    }

    private fun runOkHttpAutoCaptureError() {
        statusView.text = "OkHttp auto error: running"
        Thread {
            val result = try {
                val request = Request.Builder()
                    .url("http://127.0.0.1:1/ai-app-bridge-error")
                    .get()
                    .build()
                okHttpClient().newCall(request).execute().use { response ->
                    "OkHttp auto error unexpected HTTP ${response.code}"
                }
            } catch (error: Throwable) {
                "OkHttp auto error captured: ${error.javaClass.simpleName}"
            }
            runOnUiThread {
                statusView.text = result
            }
        }.start()
    }

    private fun okHttpClient(): OkHttpClient {
        return OkHttpClient.Builder()
            .proxy(Proxy.NO_PROXY)
            .build()
    }

    private fun stateJson(action: String): String {
        return JSONObject()
            .put("action", action)
            .put("counter", counter)
            .put("input", if (::inputView.isInitialized) inputView.text.toString() else "")
            .put("activity", javaClass.name)
            .put("timestampMs", System.currentTimeMillis())
            .toString()
    }

    private fun statusText(): String = "Native counter: $counter"

    private fun dp(value: Int): Int {
        return (value * resources.displayMetrics.density).toInt()
    }

    companion object {
        private const val requestCameraPermissionCode = 7001
        private const val requestMicrophonePermissionCode = 7002
        private const val nativeH5Html = """
            <!doctype html>
            <html>
              <head>
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>Native H5 Test</title>
              </head>
              <body>
                <h1>Native H5 Test</h1>
                <p id="native-h5-body">H5 DOM snapshot body text</p>
                <input id="native-h5-input" aria-label="Native H5 Input" value="h5 initial value" />
                <button id="native-h5-button" aria-label="Native H5 Button" onclick="document.getElementById('native-h5-body').innerText='Native H5 clicked';">Native H5 Button</button>
                <button id="native-h5-fetch-button" aria-label="Native H5 Fetch Button" onclick="runAiBridgeWebViewProbe()">Native H5 Fetch</button>
                <script>
                  window.runAiBridgeWebViewProbe = function(port) {
                    const targetPort = port || 18080;
                    const url = 'http://127.0.0.1:' + targetPort + '/v1/status?from=webview-cdp-fixture';
                    console.log('ai-bridge-webview-console-start', url);
                    return fetch(url)
                      .then(function(response) {
                        console.log('ai-bridge-webview-fetch-response', response.status, url);
                        return response.text();
                      })
                      .then(function(body) {
                        document.getElementById('native-h5-body').innerText = 'Native H5 fetch finished';
                        return body.length;
                      })
                      .catch(function(error) {
                        console.log('ai-bridge-webview-fetch-error', error.name + ':' + error.message);
                        throw error;
                      });
                  };
                </script>
              </body>
            </html>
        """
    }
}

