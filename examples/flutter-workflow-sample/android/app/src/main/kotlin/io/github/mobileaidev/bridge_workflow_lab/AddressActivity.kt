package io.github.mobileaidev.bridge_workflow_lab

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.os.Build
import android.view.View
import android.view.WindowInsets
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.*
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class AddressActivity : Activity() {
    private val editors = linkedMapOf<String, EditText>()
    private lateinit var message: TextView
    private lateinit var save: Button
    private var selectedLabel = "公司"
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        selectedLabel = savedInstanceState?.getString("addressLabel") ?: "公司"
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 24, 32, 32); setBackgroundColor(Color.rgb(247, 247, 242)) }
        fun text(value: String, size: Float = 16f) = TextView(this).apply { text = value; textSize = size; setPadding(0, 18, 0, 18); content.addView(this) }
        text("管理收货地址", 25f)
        text("科技园配送站 · 原生地址页\n保存后返回原来的 Flutter 结算页面")
        message = text("可手工输入，也可授权定位。未授权不会丢失草稿。")
        content.addView(Button(this).apply { text = "使用当前位置"; contentDescription = "使用当前位置"; setOnClickListener {
            if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) message.text = "位置权限已允许，请确认配送地址"
            else requestPermissions(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION), 701)
        } })
        for ((key, label) in listOf("recipient" to "收件人", "phone" to "联系电话", "street" to "详细地址")) {
            text(label)
            val editor = EditText(this).apply {
                hint = label; contentDescription = label; setSingleLine(key != "street")
                if (key == "phone") inputType = android.text.InputType.TYPE_CLASS_PHONE
                setText(savedInstanceState?.getString(key) ?: "")
            }
            editors[key] = editor; content.addView(editor, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        val labels = RadioGroup(this).apply { orientation = RadioGroup.HORIZONTAL }
        for (label in listOf("家", "公司", "其他")) labels.addView(RadioButton(this).apply {
            id = View.generateViewId(); text = label; isChecked = label == selectedLabel
            setOnCheckedChangeListener { _, checked -> if (checked) selectedLabel = label }
        })
        content.addView(labels)
        save = Button(this).apply { text = "保存并使用"; contentDescription = "保存并使用"; setOnClickListener { submit() } }
        content.addView(save)
        content.addView(Button(this).apply { text = "取消修改"; setOnClickListener { finish() } })
        setContentView(ScrollView(this).apply {
            addView(content)
            setOnApplyWindowInsetsListener { view, insets ->
                if (Build.VERSION.SDK_INT >= 30) {
                    val bars = insets.getInsets(WindowInsets.Type.systemBars())
                    view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                } else {
                    @Suppress("DEPRECATION")
                    view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                }
                insets
            }
        })
    }
    private fun submit() {
        val payload = JSONObject().apply { editors.forEach { (key, editor) -> put(key, editor.text.toString()) }; put("label", selectedLabel) }
        save.isEnabled = false; message.text = "正在保存地址…"
        Thread {
            try {
                val connection = URL("${intent.getStringExtra("base")}/api/shop/addresses?run=${intent.getStringExtra("run")}").openConnection() as HttpURLConnection
                val result: Pair<Int, JSONObject>
                try {
                    connection.requestMethod = "POST"; connection.connectTimeout = 3000; connection.readTimeout = 4000; connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json")
                    connection.setRequestProperty("Authorization", "Bearer ${intent.getStringExtra("session")}")
                    connection.setRequestProperty("x-lab-source", "native-address")
                    connection.outputStream.use { it.write(payload.toString().toByteArray()) }
                    val code = connection.responseCode
                    result = code to JSONObject((if (code < 400) connection.inputStream else connection.errorStream).bufferedReader().use { it.readText() })
                } finally { connection.disconnect() }
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    if (result.first < 400) {
                        setResult(RESULT_OK, Intent().apply { for (key in editors.keys) putExtra(key, result.second.getJSONObject("address").getString(key)) }); finish()
                    } else { message.text = "保存失败：${result.second.optString("error")}，可修改后重试"; save.isEnabled = true }
                }
            } catch (error: Exception) {
                runOnUiThread { if (!isFinishing && !isDestroyed) { message.text = "连接失败：${error.javaClass.simpleName}，可重试"; save.isEnabled = true } }
            }
        }.start()
    }
    override fun onSaveInstanceState(outState: Bundle) { editors.forEach { (key, editor) -> outState.putString(key, editor.text.toString()) }; outState.putString("addressLabel", selectedLabel); super.onSaveInstanceState(outState) }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 701) message.text = if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) "位置权限已允许，请确认配送地址" else "未授权定位，可继续手工填写地址"
    }
}
