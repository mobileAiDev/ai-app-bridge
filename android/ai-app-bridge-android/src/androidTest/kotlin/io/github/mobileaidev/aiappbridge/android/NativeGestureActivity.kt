package io.github.mobileaidev.aiappbridge.android

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.view.MotionEvent
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import org.json.JSONArray
import org.json.JSONObject

class NativeGestureActivity : Activity() {
    lateinit var root: LinearLayout
    lateinit var button: TraceButton
    lateinit var scroll: ScrollView
    var dialog: AlertDialog? = null
    var longClicks = 0
    var longClickHook: (() -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 120, 48, 48); isFocusableInTouchMode = true }
        button = createButton()
        root.addView(button, LinearLayout.LayoutParams(-1, 400))
        scroll = ScrollView(this).apply {
            contentDescription = "gesture-scroll"
            addView(LinearLayout(this@NativeGestureActivity).apply {
                orientation = LinearLayout.VERTICAL
                for (index in 0..24) addView(Button(this@NativeGestureActivity).apply { text = "Gesture row $index" }, LinearLayout.LayoutParams(-1, 180))
            })
        }
        root.addView(scroll, LinearLayout.LayoutParams(-1, 1000))
        setContentView(root); root.requestFocus(); AiAppBridge.start(this)
    }

    fun createButton() = TraceButton(this).apply {
        text = "Hold or swipe"
        contentDescription = "gesture-button"
        setOnLongClickListener { longClicks++; longClickHook?.invoke(); true }
    }

    fun showDialog() {
        dialog = AlertDialog.Builder(this).setTitle("Gesture interrupted").setMessage("Original touch window changed")
            .setNegativeButton("Close", null).show()
    }

    class TraceButton(activity: Activity) : Button(activity) {
        val events = JSONArray()
        var hook: ((MotionEvent) -> Unit)? = null
        override fun dispatchTouchEvent(event: MotionEvent): Boolean {
            events.put(JSONObject().put("action", event.actionMasked).put("eventTime", event.eventTime)
                .put("x", event.x.toDouble()).put("y", event.y.toDouble())
                .put("actionId", CaptureActionContext.currentActionId() ?: JSONObject.NULL))
            hook?.invoke(event)
            return super.dispatchTouchEvent(event)
        }
    }
}
