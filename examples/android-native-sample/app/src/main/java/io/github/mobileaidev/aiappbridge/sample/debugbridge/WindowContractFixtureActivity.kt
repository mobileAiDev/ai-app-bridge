package io.github.mobileaidev.aiappbridge.sample.debugbridge

import android.app.Activity
import android.app.Dialog
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.TextView
import io.github.mobileaidev.aiappbridge.android.AiAppBridge
import org.json.JSONObject
import java.io.File

/** Real Android windows, with independent counters for detecting a background click. */
class WindowContractFixtureActivity : Activity() {
    private val state = JSONObject().put("backgroundClicks", 0).put("dialogClicks", 0)
        .put("confirmClicks", 0).put("popupClicks", 0).put("childReturns", 0)
        .put("savedInput", "").put("dialogOpen", false).put("popupOpen", false)
    private lateinit var status: TextView
    private var activeDialog: Dialog? = null
    private var activePopup: PopupWindow? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val content = column()
        content.addView(TextView(this).apply { text = "Window Contract Fixture"; textSize = 22f })
        status = TextView(this).apply { contentDescription = "window_fixture_status" }
        content.addView(status)
        content.addView(button("Open Dialog", "window_open_dialog") { openDialog() })
        content.addView(button("Open Popup", "window_open_popup") { openPopup(it) })
        content.addView(button("Open Child Activity", "window_open_child") {
            startActivityForResult(Intent(this, WindowContractChildActivity::class.java), 1)
        })
        repeat(2) { index ->
            content.addView(button("Choice", "window_background_choice_$index") { increment("backgroundClicks") })
        }
        setContentView(content)
        persist("created")
    }

    private fun openDialog() {
        val dialog = Dialog(this)
        val content = column()
        content.addView(TextView(this).apply { text = "Window Dialog"; textSize = 20f })
        val editor = EditText(this).apply {
            contentDescription = "window_dialog_input"
            setSingleLine(true)
            setText(if (state.getInt("confirmClicks") == 0) "initial" else state.getString("savedInput"))
        }
        content.addView(editor)
        content.addView(button("Choice", "window_dialog_choice") { increment("dialogClicks") })
        content.addView(button("Dialog Popup", "window_dialog_popup") { openPopup(it) })
        content.addView(button("Confirm", "window_dialog_confirm") {
            state.put("savedInput", editor.text.toString())
            increment("confirmClicks")
            dialog.dismiss()
        })
        content.addView(button("Cancel", "window_dialog_cancel") { dialog.dismiss() })
        dialog.setContentView(content)
        dialog.setOnDismissListener {
            activePopup?.dismiss()
            activeDialog = null
            state.put("dialogOpen", false)
            persist("dialog_dismissed")
        }
        activeDialog = dialog
        dialog.show()
        dialog.window!!.setLayout((resources.displayMetrics.widthPixels * .85f).toInt(), ViewGroup.LayoutParams.WRAP_CONTENT)
        state.put("dialogOpen", true)
        content.post {
            val decor = dialog.window!!.decorView
            state.put("dialogSharesActivityToken", (decor.layoutParams as WindowManager.LayoutParams).token ==
                (window.decorView.layoutParams as WindowManager.LayoutParams).token)
            state.put("dialogSharesApplicationWindowToken", decor.applicationWindowToken == window.decorView.applicationWindowToken)
            persist("dialog_opened")
        }
    }

    private fun openPopup(anchor: View) {
        val content = column()
        content.setBackgroundColor(Color.WHITE)
        content.addView(TextView(this).apply { text = "Window Popup"; textSize = 20f })
        val popup = PopupWindow(content, dp(240), ViewGroup.LayoutParams.WRAP_CONTENT, false)
        popup.setBackgroundDrawable(ColorDrawable(Color.WHITE))
        popup.isOutsideTouchable = true
        popup.elevation = dp(8).toFloat()
        content.addView(button("Choice", "window_popup_choice") {
            increment("popupClicks")
            popup.dismiss()
        })
        popup.setOnDismissListener {
            activePopup = null
            state.put("popupOpen", false)
            persist("popup_dismissed")
        }
        activePopup = popup
        popup.showAsDropDown(anchor)
        state.put("popupOpen", true)
        persist("popup_opened")
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 1 && resultCode == RESULT_OK) increment("childReturns")
    }

    override fun onDestroy() {
        activePopup?.dismiss()
        activeDialog?.dismiss()
        super.onDestroy()
    }

    private fun increment(key: String) {
        state.put(key, state.getInt(key) + 1)
        persist(key)
    }

    private fun persist(action: String) {
        state.put("action", action)
        File(filesDir, "window-contract-fixture.json").writeText(state.toString(2))
        status.text = "Background: ${state.getInt("backgroundClicks")}  Dialog: ${state.getInt("dialogClicks")}\n" +
            "Confirm: ${state.getInt("confirmClicks")}  Popup: ${state.getInt("popupClicks")}  Return: ${state.getInt("childReturns")}"
        AiAppBridge.recordState(namespace = "window_contract", key = "fixture", valueJson = state.toString())
    }

    private fun column() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(16), dp(16), dp(16))
    }

    private fun button(label: String, description: String, action: (View) -> Unit) = Button(this).apply {
        text = label
        contentDescription = description
        isAllCaps = false
        setOnClickListener(action)
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density + .5f).toInt()
}

class WindowContractChildActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 80, 32, 32) }
        root.addView(TextView(this).apply { text = "Window Child Activity"; textSize = 22f })
        root.addView(Button(this).apply {
            text = "Choice"
            contentDescription = "window_child_return"
            setOnClickListener {
                File(filesDir, "window-contract-child.json").writeText(JSONObject().put("returned", true).toString())
                setResult(RESULT_OK)
                finish()
            }
        })
        setContentView(root)
    }
}
