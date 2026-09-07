package com.philkes.notallyx.application

import java.io.File
import java.security.MessageDigest

/** Copies without deleting source files. A failed migration leaves the active store recoverable. */
internal object VerifiedFileCopy {
    fun copyTree(source: File, target: File, copy: (File, File) -> Unit = { from, to -> from.copyTo(to, overwrite = true); Unit }) {
        if (!source.exists()) return
        source.walkTopDown().filter { it.isFile }.forEach { from ->
            val to = File(target, from.relativeTo(source).path)
            check(to.parentFile!!.isDirectory || to.parentFile!!.mkdirs()) { "Could not create attachment directory" }
            copy(from, to)
            check(from.length() == to.length() && digest(from).contentEquals(digest(to))) {
                "Attachment copy failed verification: ${from.name}"
            }
        }
    }

    private fun digest(file: File): ByteArray {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) { val size = input.read(buffer); if (size < 0) break; digest.update(buffer, 0, size) }
        }
        return digest.digest()
    }
}
