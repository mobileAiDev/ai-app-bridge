package com.philkes.notallyx.fixture

import android.app.Activity
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/** Only the SDK-free UIA test build includes this controlled unresponsive page. */
class UiaRecoveryFixtureActivity : Activity() {
    private lateinit var journal: File
    private lateinit var counterView: TextView
    private var count = 0
    private var deliveries = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val runId = requireNotNull(intent.getStringExtra("runId"))
        require(runId.matches(Regex("[A-Za-z0-9_-]{1,100}")))
        journal = File(filesDir, "uia-recovery-$runId.jsonl")
        require(!journal.exists()) { "Use a new runId; previous evidence must remain intact." }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }
        root.addView(TextView(this).apply { text = "UIA executor recovery"; textSize = 24f })
        counterView = TextView(this).apply { text = "Effect count: 0"; textSize = 22f }
        root.addView(counterView)
        root.addView(Button(this).apply {
            text = "Delayed action"
            contentDescription = "uia_recovery_delayed_action"
            setOnClickListener {
                deliveries++
                record("entered", "delayed")
                // Deliberately retain the real accessibility callback across executor death.
                // The independent file record is readable while the UI thread is blocked.
                SystemClock.sleep(8000)
                count++
                record("applied", "delayed")
                counterView.text = "Effect count: $count"
            }
        })
        root.addView(Button(this).apply {
            text = "Continue action"
            contentDescription = "uia_recovery_continue_action"
            setOnClickListener {
                deliveries++
                count++
                record("applied", "continue")
                counterView.text = "Effect count: $count"
            }
        })
        setContentView(root)
        record("ready", "none")
    }

    private fun record(phase: String, action: String) {
        val row = JSONObject().put("phase", phase).put("action", action)
            .put("count", count).put("deliveries", deliveries).put("pid", Process.myPid())
            .put("timestampMs", System.currentTimeMillis()).put("elapsedMs", SystemClock.elapsedRealtime())
        FileOutputStream(journal, true).use { stream ->
            stream.write((row.toString() + "\n").toByteArray(Charsets.UTF_8))
            stream.fd.sync()
        }
    }
}
