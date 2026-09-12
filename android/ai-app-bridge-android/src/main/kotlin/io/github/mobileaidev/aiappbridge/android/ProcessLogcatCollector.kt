package io.github.mobileaidev.aiappbridge.android

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Build
import android.util.Log
import java.io.BufferedReader
import java.util.UUID

internal interface LogcatLineSource : AutoCloseable {
    fun readLine(): String?
}

internal class ProcessLogcatSource(
    private val process: Process,
) : LogcatLineSource {
    private val reader: BufferedReader = process.inputStream.bufferedReader()
    private val marker = UUID.randomUUID().toString()
    private var started = false

    init { Log.i(LOGCAT_BOUNDARY_TAG, marker) }

    override fun readLine(): String? {
        // A new logcat process replays its readable ring buffer. Admit lines only after our
        // exact marker, so previous runtimes cannot refill the writer or acquire a new epoch.
        // This boundary also works on API 19, whose logcat has no timestamp-follow option.
        while (!started) {
            val line = reader.readLine() ?: return null
            val parsed = LogcatLineParser.parse(line)
            started = parsed.processId == android.os.Process.myPid() &&
                parsed.tag == LOGCAT_BOUNDARY_TAG && parsed.message == marker
        }
        return reader.readLine()
    }

    override fun close() {
        process.destroy()
        reader.close()
    }
}

internal class ProcessLogcatCollector(
    private val openSource: () -> LogcatLineSource,
    private val persist: (CapturedLogLine) -> Unit,
) {
    private val lock = Any()

    @Volatile
    private var stopped = true
    private var thread: Thread? = null
    private var source: LogcatLineSource? = null

    fun start() {
        synchronized(lock) {
            if (!stopped) {
                return
            }
            stopped = false
            val opened = try {
                openSource()
            } catch (_: Throwable) {
                stopped = true
                return
            }
            source = opened
            thread = Thread(
                {
                    try {
                        while (!stopped) {
                            val line = opened.readLine() ?: break
                            persist(LogcatLineParser.parse(line))
                        }
                    } catch (_: Throwable) {
                    } finally {
                        synchronized(lock) {
                            if (source === opened) {
                                stopped = true
                                source = null
                                thread = null
                            }
                        }
                        try {
                            opened.close()
                        } catch (_: Throwable) {
                        }
                    }
                },
                "aab-logcat",
            ).apply {
                isDaemon = true
                start()
            }
        }
    }

    fun stop() {
        synchronized(lock) {
            stopped = true
            try {
                source?.close()
            } catch (_: Throwable) {
            }
            source = null
            thread = null
        }
    }
}

private const val LOGCAT_BOUNDARY_TAG = "AabLogcatStart"
internal fun logcatFollowCommand(): List<String> = listOf("logcat", "-v", "time", "$LOGCAT_BOUNDARY_TAG:I")

internal fun isMainProcess(context: Context): Boolean {
    if (Build.VERSION.SDK_INT >= 28) {
        return Application.getProcessName() == context.packageName
    }
    val pid = android.os.Process.myPid()
    val processes = (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager)
        .runningAppProcesses
    val current = processes?.firstOrNull { it.pid == pid }
    return current != null && current.processName == context.packageName
}
