package io.github.mobileaidev.aiappbridge.sample

import android.app.Activity
import android.os.Bundle
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/** Visible evidence for incomplete deep trees, long labels and recovery to a full tree. */
class ObservationCoverageFixtureActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 48, 24, 24) }
        root.setOnApplyWindowInsetsListener { view, insets ->
            view.setPadding(24, 48 + insets.systemWindowInsetTop, 24, 24 + insets.systemWindowInsetBottom)
            insets
        }
        val result = TextView(this).apply { text = "观察就绪" }
        root.addView(result)
        val longLabel = TextView(this).apply {
            text = "x".repeat(299) + "😀suffix"
            maxLines = 1
            contentDescription = "长文本预览"
        }
        root.addView(longLabel)
        val deepRoot = FrameLayout(this)
        root.addView(deepRoot, LinearLayout.LayoutParams(-1, 96))
        var parent = deepRoot
        repeat(30) {
            val child = FrameLayout(this)
            parent.addView(child, FrameLayout.LayoutParams(-1, -1))
            parent = child
        }
        parent.addView(TextView(this).apply { text = "深层仍在加载" })
        root.addView(Button(this).apply {
            text = "清理部分观察"
            setOnClickListener {
                root.removeView(deepRoot)
                root.removeView(longLabel)
                result.text = "完整观察就绪"
            }
        })
        setContentView(root)
    }
}
