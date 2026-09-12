package io.github.mobileaidev.aiappbridge.android

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import java.util.concurrent.atomic.AtomicInteger

// Lives only in the SDK instrumentation APK. Faults are configured by the
// instrumentation thread; the shipped SDK has no test commands or bypasses.
class NativeFaultActivity : Activity() {
    lateinit var root: LinearLayout
    lateinit var editor: FaultEditor
    lateinit var button: Button
    lateinit var otherEditor: FaultEditor
    val clicks = AtomicInteger()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 120, 48, 48)
            isFocusableInTouchMode = true
        }
        editor = createEditor("initial")
        root.addView(editor, LinearLayout.LayoutParams(-1, 180))
        button = Button(this).apply {
            text = "Count"
            contentDescription = "atomic-count"
            setOnClickListener { clicks.incrementAndGet() }
        }
        root.addView(button, LinearLayout.LayoutParams(-1, 180))
        otherEditor = createEditor("other-initial").apply { contentDescription = "atomic-other-editor" }
        root.addView(otherEditor, LinearLayout.LayoutParams(-1, 180).apply { topMargin = 220 })
        setContentView(root)
        root.requestFocus()
        AiAppBridge.start(this)
    }

    fun createEditor(value: String) = FaultEditor(this).apply {
        contentDescription = "atomic-editor"
        setSingleLine()
        setText(value)
    }

    fun replaceEditor(): FaultEditor {
        val previous = editor
        root.removeView(previous)
        editor = createEditor("replacement")
        root.addView(editor, 0, LinearLayout.LayoutParams(-1, 180))
        editor.requestFocus()
        return previous
    }

    class FaultEditor(activity: Activity) : EditText(activity) {
        var connectionHook: (() -> Unit)? = null
        var selectionHook: (() -> Unit)? = null
        override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
            val connection = super.onCreateInputConnection(outAttrs)
            val hook = connectionHook
            connectionHook = null
            hook?.invoke()
            if (connection == null) return null
            return object : InputConnectionWrapper(connection, false) {
                override fun setSelection(start: Int, end: Int): Boolean {
                    val result = super.setSelection(start, end)
                    val selection = selectionHook
                    selectionHook = null
                    selection?.invoke()
                    return result
                }
            }
        }
    }
}
