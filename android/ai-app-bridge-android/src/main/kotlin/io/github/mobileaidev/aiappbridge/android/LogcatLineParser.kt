package io.github.mobileaidev.aiappbridge.android

internal data class CapturedLogLine(
    val raw: String,
    val time: String,
    val level: String,
    val tag: String,
    val processId: Int,
    val message: String,
    val parsed: Boolean,
)

internal object LogcatLineParser {
    private val pattern = Regex(
        """^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+([VDIWEF])/(.+?)\(\s*(\d+)\):\s(.*)$""",
    )

    fun parse(raw: String): CapturedLogLine {
        val match = pattern.matchEntire(raw)
            ?: return CapturedLogLine(
                raw = raw,
                time = "",
                level = "info",
                tag = "",
                processId = -1,
                message = raw,
                parsed = false,
            )
        val (time, levelToken, tag, pid, message) = match.destructured
        return CapturedLogLine(
            raw = raw,
            time = time,
            level = levelName(levelToken[0]),
            tag = tag.trim(),
            processId = pid.toInt(),
            message = message,
            parsed = true,
        )
    }

    fun partition(processId: Int, myPid: Int): MobileFactPartition {
        return if (processId > 0 && processId != myPid) {
            MobileFactPartition.DEVICE_LOG
        } else {
            MobileFactPartition.APP_LOG
        }
    }

    private fun levelName(token: Char): String {
        return when (token) {
            'V' -> "verbose"
            'D' -> "debug"
            'I' -> "info"
            'W' -> "warn"
            'E' -> "error"
            'F' -> "fatal"
            else -> "info"
        }
    }
}
