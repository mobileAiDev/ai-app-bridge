package io.github.mobileaidev.aiappbridge.sample

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.*
import io.github.mobileaidev.aiappbridge.android.AiAppBridge
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** A small complete work-order app. Every result is derived from real UI actions. */
class ComplexWorkflowFixtureActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private val visits = linkedSetOf<String>()
    private val trace = JSONArray()
    private val state = JSONObject().put("selectedId", "").put("assignee", "").put("remark", "")
        .put("priority", false).put("notifications", false).put("savedCount", 0).put("submitAttempts", 0)
        .put("validationErrors", 0).put("cancelledDrafts", 0).put("historyReturns", 0).put("settingsSaved", 0)
        .put("backgroundConfirms", 0).put("refreshes", 0).put("noticeVisible", false)
    private lateinit var content: LinearLayout
    private var notice: View? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        page("loading", "正在加载工作台")
        handler.postDelayed({ dashboard() }, 250)
    }

    private fun page(name: String, title: String) {
        visits.add(name)
        state.put("page", name)
        content = column()
        content.addView(label(title, "workflow_title", 23f))
        setContentView(ScrollView(this).apply { addView(content) })
        record("page:$name")
    }

    private fun dashboard() {
        page("dashboard", "巡检工作台")
        content.addView(label("今日待办 · 2 项任务", "workflow_dashboard_status"))
        content.addView(button("任务列表", "workflow_tasks") { tasks() })
        content.addView(button("操作记录", "workflow_history") { history() })
        content.addView(button("工作偏好", "workflow_settings") { settings() })
    }

    private fun tasks() {
        page("tasks", "任务列表")
        val query = editor("搜索任务", "workflow_query")
        content.addView(query)
        val results = column()
        fun populate() {
            results.removeAllViews()
            listOf("WO-101" to "北区", "WO-102" to "南区").filter {
                query.text.isEmpty() || "巡检 ${it.first} ${it.second}".contains(query.text.toString())
            }.forEach { (id, area) ->
                results.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    contentDescription = "work_order_row"
                    addView(label(id))
                    addView(label("巡检 · $area"))
                    addView(button("打开", "打开工单") {
                        state.put("selectedId", id)
                        detail()
                    })
                })
            }
            results.addView(label("查询完成", "workflow_query_status"))
            record("query_completed")
        }
        content.addView(button("搜索", "workflow_search") {
            results.removeAllViews()
            results.addView(label("正在查询"))
            handler.postDelayed({ populate() }, 180)
        })
        content.addView(results)
        populate()
        content.addView(button("返回工作台", "workflow_home") { dashboard() })
    }

    private fun detail() {
        page("detail", "工单详情 ${state.getString("selectedId")}")
        content.addView(label("提交前请核对信息；说明中的提交、确认是说明文字。"))
        val edit = button("编辑", "workflow_edit") { edit() }
        content.addView(edit)
        content.addView(button("刷新详情", "workflow_refresh") {
            increment("refreshes")
            val index = content.indexOfChild(edit)
            content.removeView(edit)
            content.addView(button("编辑", "workflow_edit") { edit() }, index)
            record("detail_replaced")
        })
        content.addView(button("确认", "workflow_background_confirm") {
            increment("backgroundConfirms")
            record("background_confirm")
        })
        content.addView(button("返回列表", "workflow_back") { tasks() })
    }

    private fun edit() {
        page("edit", "填写巡检结果")
        val assignee = editor("负责人", "workflow_assignee")
        val remark = editor("巡检记录", "workflow_remark")
        content.addView(assignee)
        content.addView(remark)
        val priority = CheckBox(this).apply { text = "优先处理"; contentDescription = "workflow_priority" }
        content.addView(priority)
        val validation = label("请填写负责人和记录", "workflow_validation")
        content.addView(validation)
        content.addView(button("下一步", "workflow_review") {
            if (assignee.text.isBlank() || remark.text.isBlank()) {
                increment("validationErrors")
                validation.text = "负责人和记录不能为空"
                record("validation_rejected")
            } else {
                state.put("assignee", assignee.text.toString()).put("remark", remark.text.toString())
                    .put("priority", priority.isChecked)
                review()
            }
        })
        content.addView(button("放弃修改", "workflow_cancel_edit") {
            increment("cancelledDrafts")
            detail()
        })
    }

    private fun review() {
        visits.add("review")
        record("review_opened")
        AlertDialog.Builder(this).setTitle("确认巡检结果")
            .setMessage("${state.getString("selectedId")} · ${state.getString("assignee")}\n${state.getString("remark")}")
            .setNegativeButton("返回修改") { _, _ -> record("review_cancelled") }
            .setPositiveButton("确认") { _, _ -> submit() }.show()
    }

    private fun submit() {
        increment("submitAttempts")
        page("submitting", "正在提交")
        handler.postDelayed({
            if (state.getInt("submitAttempts") == 1) {
                page("retry", "服务暂时不可用，本次未保存")
                content.addView(button("重试", "workflow_retry") { submit() })
                content.addView(button("返回修改", "workflow_retry_back") { edit() })
            } else {
                increment("savedCount")
                page("receipt", "巡检已保存")
                content.addView(label("${state.getString("selectedId")} · ${state.getString("assignee")} · ${state.getString("remark")}"))
                content.addView(button("查看操作记录", "workflow_history") { history() })
                content.addView(button("返回工作台", "workflow_home") { dashboard() })
                showNotice()
            }
            record("submit_finished")
        }, 220)
    }

    // A real non-touchable window, like custom in-app notifications used on POS devices.
    private fun showNotice() {
        val view = label("已同步 · 可以继续操作", "workflow_notice").apply {
            setBackgroundColor(Color.rgb(210, 240, 215))
        }
        val params = WindowManager.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.TYPE_APPLICATION_PANEL,
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            android.graphics.PixelFormat.TRANSLUCENT).apply {
            token = window.decorView.windowToken
            gravity = Gravity.TOP or Gravity.END
        }
        windowManager.addView(view, params)
        notice = view
        state.put("noticeVisible", true)
        handler.postDelayed({ removeNotice() }, 4000)
    }

    private fun removeNotice() {
        notice?.let { windowManager.removeView(it) }
        notice = null
        state.put("noticeVisible", false)
        record("notice_closed")
    }

    private fun history() {
        visits.add("history")
        record("history_opened")
        startActivityForResult(Intent(this, ComplexWorkflowHistoryActivity::class.java), 7)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 7 && resultCode == RESULT_OK) {
            increment("historyReturns")
            dashboard()
        }
    }

    private fun settings() {
        page("settings", "工作偏好")
        val enabled = Switch(this).apply {
            text = "完成后通知"; contentDescription = "workflow_notifications"
            isChecked = state.getBoolean("notifications")
        }
        content.addView(enabled)
        content.addView(button("保存设置", "workflow_save_settings") {
            state.put("notifications", enabled.isChecked)
            increment("settingsSaved")
            dashboard()
        })
    }

    private fun increment(key: String) { state.put(key, state.getInt(key) + 1) }
    private fun record(action: String) {
        trace.put(JSONObject().put("action", action).put("atMs", System.currentTimeMillis())
            .put("noticeVisible", state.getBoolean("noticeVisible")))
        state.put("visits", JSONArray(visits.toList())).put("trace", trace)
        File(filesDir, "complex-workflow.json").writeText(state.toString())
        AiAppBridge.recordState(namespace = "complex_workflow", key = "fixture", valueJson = state.toString())
    }
    private fun column() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(12), dp(16), dp(12))
    }
    private fun label(value: String, description: String? = null, size: Float = 17f) = TextView(this).apply {
        text = value; textSize = size; contentDescription = description; setPadding(dp(8), dp(6), dp(8), dp(6))
    }
    private fun editor(hintText: String, description: String) = EditText(this).apply {
        hint = hintText; contentDescription = description; setSingleLine(true)
    }
    private fun button(value: String, description: String, action: () -> Unit) = Button(this).apply {
        text = value; contentDescription = description; isAllCaps = false; setOnClickListener { action() }
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density + .5f).toInt()
    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        removeNotice()
        super.onDestroy()
    }
}

class ComplexWorkflowHistoryActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val state = JSONObject(File(filesDir, "complex-workflow.json").readText())
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(32, 32, 32, 32)
            addView(TextView(context).apply { text = "操作记录"; textSize = 23f })
            addView(TextView(context).apply {
                text = "已保存 ${state.getInt("savedCount")} 条 · ${state.getString("selectedId")}"
                contentDescription = "workflow_history_status"; textSize = 18f
            })
            addView(Button(context).apply {
                text = "返回工作台"; contentDescription = "workflow_history_return"
                setOnClickListener { setResult(RESULT_OK); finish() }
            })
        })
    }
}
