package io.github.mobileaidev.aiappbridge.android

import android.app.Activity
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Bundle
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** A large, unchanged form with one small continuously redrawing indicator. */
class UiObserverPerformanceActivity : Activity() {
    lateinit var pulse: PulseView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(TextView(this).apply {
            text = "Bridge UI observation performance probe"
            textSize = 20f
        })
        pulse = PulseView(this)
        root.addView(pulse, LinearLayout.LayoutParams(-1, 48))
        val rows = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            repeat(600) { index ->
                addView(TextView(this@UiObserverPerformanceActivity).apply {
                    id = android.R.id.text1
                    text = "商品 $index · 商品规格与库存说明 · 数量 12 · 单价 123.45"
                    contentDescription = "Product row $index"
                    textSize = 16f
                })
            }
        }
        root.addView(ScrollView(this).apply { addView(rows) }, LinearLayout.LayoutParams(-1, -1))
        setContentView(root)
        AiAppBridge.start(this)
    }

    class PulseView(activity: Activity) : View(activity) {
        private val paint = Paint().apply { color = Color.BLUE }
        var frames = 0L
            private set
        var continuousRedraw = true

        override fun onDraw(canvas: Canvas) {
            frames++
            canvas.drawRect(0f, 0f, (frames % 100).toFloat() + 1f, 24f, paint)
            if (continuousRedraw) postInvalidateOnAnimation()
        }
    }
}
