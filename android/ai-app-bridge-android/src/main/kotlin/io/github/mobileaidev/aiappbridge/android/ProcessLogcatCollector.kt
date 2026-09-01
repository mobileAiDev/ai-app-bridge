package io.github.mobileaidev.aiappbridge.android

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Build
import java.io.BufferedReader

internal interface LogcatLineSource : AutoCloseable {
    fun readLine(): String?
}

internal class ProcessLogcatSource(
    private val process: Process,
) : LogcatLineSource {
    private val reader: BufferedReader = process.inputStream.bufferedReader()

    override fun readLine(): String? = reader.readLine()

    override fun close() {
        reader.close()
        process.destroy()
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

internal fun logcatFollowCommand(): List<String> = listOf("logcat", "-v", "time")

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
