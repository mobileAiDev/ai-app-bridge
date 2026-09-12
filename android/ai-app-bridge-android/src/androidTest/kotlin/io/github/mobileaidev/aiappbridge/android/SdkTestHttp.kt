package io.github.mobileaidev.aiappbridge.android

import android.net.LocalSocket
import android.net.LocalSocketAddress
import org.json.JSONObject
import org.junit.Assert.assertEquals

/** The instrumentation client uses the same SDK endpoint as the Host ADB forward. */
internal object SdkTestHttp {
    fun connect(socketName: String): LocalSocket = LocalSocket().apply {
        connect(LocalSocketAddress(socketName, LocalSocketAddress.Namespace.ABSTRACT))
    }

    fun request(socketName: String, path: String, body: String?, timeoutMs: Int): JSONObject =
        connect(socketName).use { socket ->
            socket.soTimeout = timeoutMs
            val bytes = body?.toByteArray(Charsets.UTF_8) ?: ByteArray(0)
            val method = if (body == null) "GET" else "POST"
            val header = "$method $path HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
            socket.outputStream.apply { write(header.toByteArray(Charsets.UTF_8)); write(bytes); flush() }
            val response = socket.inputStream.bufferedReader(Charsets.UTF_8).readText()
            assertEquals("HTTP/1.1 200 OK", response.substringBefore("\r\n"))
            JSONObject(response.substringAfter("\r\n\r\n"))
        }
}
