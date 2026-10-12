package io.github.mobileaidev.aiappbridge.sample

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** Visible regression fixture: duplicate labels, scoped rows, and changing live nodes. */
class AgentChoiceFixtureActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 48, 32, 32) }
        val result = TextView(this).apply { text = "选择结果：尚未点击"; textSize = 20f }
        root.addView(TextView(this).apply { text = "请阅读说明，只有同意用户协议后再点击同意按钮。" })
        root.addView(TextView(this).apply { text = "同意"; contentDescription = "普通说明标签" })
        for (index in 1..2) root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            contentDescription = "协议行"
            addView(TextView(context).apply { text = if (index == 1) "个人账户" else "企业账户" })
            addView(Button(context).apply {
                text = "同意"
                contentDescription = "同意按钮$index"
                setOnClickListener { result.text = "选择结果：按钮$index" }
            })
        })
        val moving = Button(this).apply {
            text = "移动按钮"
            setOnClickListener { result.text = "选择结果：移动按钮" }
        }
        root.addView(moving)
        var counter = 0
        fun changingButton() = Button(this).apply {
            text = "动态按钮$counter"
            contentDescription = "动态按钮"
            setOnClickListener { result.text = "选择结果：动态按钮$counter" }
        }
        var changing = changingButton()
        root.addView(changing)
        root.addView(Button(this).apply {
            text = "替换动态按钮"
            setOnClickListener {
                val index = root.indexOfChild(changing)
                root.removeView(changing)
                changing = changingButton()
                root.addView(changing, index)
                result.text = "选择结果：已替换，尚未点击"
            }
        })
        root.addView(result)
        setContentView(root)
        val step = object : Runnable {
            override fun run() {
                moving.translationX = if (moving.translationX == 0f) 16f else 0f
                changing.text = "动态按钮${++counter}"
                handler.postDelayed(this, 350)
            }
        }
        handler.postDelayed(step, 350)
    }
    override fun onDestroy() { handler.removeCallbacksAndMessages(null); super.onDestroy() }
}
