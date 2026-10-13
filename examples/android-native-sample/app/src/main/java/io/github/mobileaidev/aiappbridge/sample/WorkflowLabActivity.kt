package io.github.mobileaidev.aiappbridge.sample

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.view.WindowInsets
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Real HTTP workflow. The external server is the business oracle, never an automation shortcut. */
class WorkflowLabActivity : Activity() {
    private val client = OkHttpClient.Builder().callTimeout(3, TimeUnit.SECONDS).retryOnConnectionFailure(false).build()
    private val preferences by lazy { getSharedPreferences("workflow-lab", MODE_PRIVATE) }
    private lateinit var base: String
    private lateinit var run: String
    private lateinit var column: LinearLayout
    private lateinit var status: TextView
    private var webView: WebView? = null
    private var selected = ""
    private var search = ""
    private var page = 0
    private var queryGeneration = 0
    private var order: JSONObject? = null
    private var account = ""
    private var note = ""
    private var priority = false
    private var key = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        base = intent.getStringExtra("lab_base_url").orEmpty().trimEnd('/')
        run = intent.getStringExtra("lab_run").orEmpty()
        if (!base.startsWith("http://") || run.isEmpty()) {
            screen("综合测试环境")
            label("启动时通过 lab_base_url 和 lab_run 指定本次 HTTP 测试环境。")
            return
        }
        account = saved("assignee"); note = saved("note"); selected = saved("selected")
        key = saved("key").ifEmpty { UUID.randomUUID().toString() }
        priority = saved("priority") == "true"
        order = saved("order").takeIf { it.isNotEmpty() }?.let { JSONObject(it) }
        if (saved("session").isNotEmpty()) dashboard() else welcome()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        recreate()
    }

    private fun saved(name: String) = preferences.getString("$run:$name", "").orEmpty()
    private fun save(name: String, value: String) { preferences.edit().putString("$run:$name", value).apply() }
    private fun screen(title: String) {
        webView?.destroy(); webView = null
        column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 18, 24, 18) }
        column.addView(TextView(this).apply { text = title; textSize = 24f; contentDescription = "lab_title" })
        status = TextView(this).apply { textSize = 15f; contentDescription = "lab_status" }
        column.addView(status)
        setContentView(ScrollView(this).apply {
            addView(column)
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
    private fun label(value: String) = TextView(this).also { it.text = value; it.textSize = 16f; column.addView(it) }
    private fun button(text: String, description: String, action: () -> Unit) = Button(this).also {
        it.text = text; it.contentDescription = description; it.setOnClickListener { action() }; column.addView(it)
    }
    private fun field(hint: String, description: String, value: String = "") = EditText(this).also {
        it.hint = hint; it.contentDescription = description; it.setText(value); it.setSingleLine(true); column.addView(it)
    }

    private fun request(route: String, data: JSONObject? = null, success: (JSONObject) -> Unit,
                        failure: (Int, String) -> Unit = { code, error -> status.text = "请求失败 $code：$error" }) {
        Thread {
            try {
                val separator = if (route.contains('?')) '&' else '?'
                val builder = Request.Builder().url("$base$route${separator}run=${Uri.encode(run)}")
                    .header("X-Lab-Source", "native").header("Authorization", "Bearer ${saved("session")}")
                if (data != null) builder.post(data.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
                client.newCall(builder.build()).execute().use { response ->
                    val body = JSONObject(response.body?.string() ?: "{}")
                    runOnUiThread { if (!isFinishing && !isDestroyed) {
                        if (response.isSuccessful) success(body) else failure(response.code, body.optString("error"))
                    } }
                }
            } catch (error: Exception) {
                runOnUiThread { if (!isFinishing && !isDestroyed) failure(0, error.javaClass.simpleName) }
            }
        }.start()
    }

    private fun welcome() {
        screen("巡检协作平台")
        label("原生工单 · 系统权限 · H5 审核 · Flutter 复核")
        button("进入登录", "lab_login_entry") { login() }
    }
    private fun login() {
        screen("登录协作平台")
        val email = field("账号", "lab_account")
        val password = field("密码", "lab_password").apply { inputType = 129 }
        label("用户说明：同意协议后可以提交；此段文字中的同意不是操作按钮。")
        val agreement = CheckBox(this).apply { text = "同意"; contentDescription = "lab_agreement" }
        column.addView(agreement)
        button("登录", "lab_login_submit") {
            status.text = "正在登录…"
            request("/api/session", JSONObject().put("account", email.text.toString()).put("password", password.text.toString()).put("agreement", agreement.isChecked),
                success = { save("session", it.getString("session")); dashboard() },
                failure = { _, error -> status.text = "登录失败：$error" })
        }
    }
    private fun dashboard() {
        screen("协作工作台")
        label("本次环境：$run")
        button("查询巡检点", "lab_sites") { listSites() }
        if (selected.isNotEmpty()) button("继续本地草稿", "lab_resume_draft") { editor() }
        if (order != null) button("继续已保存工单", "lab_resume_order") { receipt() }
        button("刷新服务端工单", "lab_sync") {
            request("/api/orders", success = { result ->
                val orders = result.getJSONArray("orders")
                if (orders.length() == 0) status.text = "尚无已保存工单"
                else { acceptOrder(orders.getJSONObject(orders.length() - 1)); receipt() }
            })
        }
    }
    private fun listSites() {
        screen("巡检点查询")
        val query = field("区域或编号", "lab_query", search)
        button("搜索", "lab_search") { search = query.text.toString(); page = 0; listSites() }
        val container = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; column.addView(container)
        button("下一页", "lab_next_page") { page++; listSites() }
        button("返回工作台", "lab_home") { queryGeneration++; dashboard() }
        status.text = "正在查询…"
        val generation = ++queryGeneration
        request("/api/items?q=${Uri.encode(search)}&page=$page", success = { result ->
            if (generation != queryGeneration) return@request
            status.text = "查询完成 ${result.getInt("total")} 项 · 第 ${page + 1} 页"
            val items = result.getJSONArray("items")
            for (index in 0 until items.length()) {
                val item = items.getJSONObject(index)
                val row = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; contentDescription = "lab_site_row" }
                row.addView(TextView(this).apply { text = "${item.getString("id")} ${item.getString("zone")} ${item.getString("name")}" })
                row.addView(Button(this).apply {
                    text = "打开"; contentDescription = "open_${item.getString("id")}"; setOnClickListener {
                        queryGeneration++; selected = item.getString("id"); save("selected", selected); detail()
                    }
                }); container.addView(row)
            }
        })
    }
    private fun detail() {
        screen("巡检点 $selected")
        label("同名操作位于不同记录中，工单必须关联当前巡检点。")
        button("创建巡检工单", "lab_edit") { editor() }
        button("返回查询", "lab_back_list") { listSites() }
    }
    private fun editor() {
        screen("编辑工单 $selected")
        val owner = field("负责人", "lab_assignee", account)
        val remarks = field("现场记录", "lab_note", note)
        val urgent = CheckBox(this).apply { text = "优先处理"; contentDescription = "lab_priority"; isChecked = priority }; column.addView(urgent)
        fun retain() {
            account = owner.text.toString(); note = remarks.text.toString(); priority = urgent.isChecked
            save("assignee", account); save("note", note); save("priority", priority.toString()); save("key", key)
        }
        button("申请相机权限", "lab_camera") {
            retain()
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) status.text = "相机权限已授权"
            else requestPermissions(arrayOf(Manifest.permission.CAMERA), 901)
        }
        button("保存草稿并重新创建页面", "lab_recreate") { retain(); recreate() }
        button("预览提交", "lab_preview") {
            retain()
            if (account.isBlank() || note.isBlank()) status.text = "负责人和记录不能为空"
            else AlertDialog.Builder(this).setTitle("确认提交工单").setMessage("$selected\n$account\n$note")
                .setNegativeButton("返回修改", null).setPositiveButton("确认") { _, _ -> submit() }.show()
        }
        button("取消编辑", "lab_cancel") { retain(); dashboard() }
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 901) status.text = if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) "相机权限已授权" else "相机权限已拒绝，可重新申请"
    }
    private fun submit() {
        screen("提交巡检工单")
        status.text = "正在提交…"
        val data = JSONObject().put("idempotencyKey", key).put("siteId", selected).put("assignee", account).put("note", note).put("priority", priority)
        request("/api/orders", data, success = { acceptOrder(it.getJSONObject("order")); receipt() }, failure = { code, error ->
            status.text = if (code == 0) "结果未确认，先查询服务端" else "提交失败 $code：$error"
            if (code != 0) button("重试提交", "lab_retry") { submit() }
            button("查询本次提交结果", "lab_reconcile") {
                request("/api/orders?key=${Uri.encode(key)}", success = { result ->
                    val orders = result.getJSONArray("orders")
                    if (orders.length() == 1) { acceptOrder(orders.getJSONObject(0)); receipt() }
                    else { status.text = "服务端确认尚未保存"; button("重新提交", "lab_retry") { submit() } }
                })
            }
            button("返回草稿", "lab_back_draft") { editor() }
        })
    }
    private fun acceptOrder(value: JSONObject) { order = value; save("order", value.toString()) }
    private fun receipt() {
        screen("工单已保存")
        label("${order!!.getString("id")} · ${order!!.getString("siteId")} · ${order!!.getString("assignee")}")
        button("打开 H5 审核", "lab_h5") { review() }
        button("打开 Flutter 复核", "lab_flutter") {
            val uri = Uri.Builder().scheme("bridge-workflow-lab").authority("review").appendQueryParameter("base", base)
                .appendQueryParameter("run", run).appendQueryParameter("order", order!!.getString("id"))
                .appendQueryParameter("session", saved("session")).build()
            try { startActivity(Intent(Intent.ACTION_VIEW, uri).setClassName("io.github.mobileaidev.bridge_workflow_lab", "io.github.mobileaidev.bridge_workflow_lab.MainActivity")) }
            catch (_: android.content.ActivityNotFoundException) { status.text = "请安装同一仓库的 Flutter 综合测试 App 后继续" }
        }
        button("核对服务端结果", "lab_verify") {
            request("/api/orders/${order!!.getString("id")}", success = { result ->
                acceptOrder(result.getJSONObject("order"))
                status.text = "审核=${order!!.getBoolean("approved")}，复核=${order!!.getBoolean("checked")}，版本=${order!!.getInt("revision")}"
            })
        }
        button("返回工作台", "lab_home") { dashboard() }
    }
    private fun review() {
        screen("原生与 H5 协作")
        button("返回工单", "lab_close_h5") { receipt() }
        WebView.setWebContentsDebuggingEnabled(true)
        val view = WebView(this)
        view.settings.javaScriptEnabled = true
        view.webViewClient = WebViewClient()
        view.contentDescription = "lab_review_webview"
        column.addView(view, LinearLayout.LayoutParams(-1, 1050))
        webView = view
        view.loadUrl("$base/review.html?run=${Uri.encode(run)}&order=${Uri.encode(order!!.getString("id"))}&session=${Uri.encode(saved("session"))}")
    }
    override fun onDestroy() { queryGeneration++; webView?.destroy(); webView = null; super.onDestroy() }
}
