package io.github.mobileaidev.aiappbridge.android

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class AndroidHttpRequestTest {
    @Test fun malformedContentLengthCannotBecomeAnEmptyRequest() {
        for (length in listOf("invalid", "-1", "+1", "2147483648", "1, 1")) {
            try {
                AndroidHttpRequest.read(ByteArrayInputStream("POST /v1/events HTTP/1.1\r\nContent-Length: $length\r\n\r\n{}".toByteArray()))
                fail("Accepted invalid Content-Length: $length")
            } catch (error: AndroidHttpRequestFailure) {
                assertEquals("invalid_http_request", error.code)
            }
        }
    }

    @Test fun incompleteAmbiguousAndOversizedFramingNeverReachesTheHandler() {
        val rejected = listOf(
            "POST /v1/events HTTP/1.1\r\nContent-Length: 2\r\ncOnTeNt-LeNgTh: 2\r\n\r\n{}" to "invalid_http_request",
            "POST /v1/events HTTP/1.1\r\nContent-Length: 4194305\r\n\r\n" to "http_request_too_large",
            "GET /v1/status HTTP/1.1\r\nX-Large: ${"x".repeat(16384)}\r\n\r\n" to "http_request_too_large",
            "GET /v1/status HTTP/1.1\r\nHost: local\r\n" to "incomplete_http_request",
            "POST /v1/events HTTP/1.1\r\nContent-Length: 3\r\n\r\n{}" to "incomplete_http_request",
            "POST /v1/events HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n" to "invalid_http_request",
        )
        for ((wire, code) in rejected) {
            try {
                AndroidHttpRequest.read(ByteArrayInputStream(wire.toByteArray()))
                fail("Accepted invalid framing: ${wire.take(100)}")
            } catch (error: AndroidHttpRequestFailure) {
                assertEquals(code, error.code)
                assertEquals(if (code == "http_request_too_large") 413 else 400, error.statusCode)
            }
        }
    }

    @Test fun validFragmentedUtf8QueriesAndBoundarySizedBodiesRemainReadable() {
        val body = "{\"value\":\"商家 ☕\"}"
        val request = "POST /v1/events?name=a%2Bb+c HTTP/1.0\r\nHost: localhost\r\nContent-Length: ${body.toByteArray().size}\r\n\r\n$body"
        val input = object : ByteArrayInputStream(request.toByteArray()) {
            override fun read(bytes: ByteArray, offset: Int, length: Int): Int = super.read(bytes, offset, minOf(length, 3))
        }
        val parsed = AndroidHttpRequest.read(input)
        assertEquals("POST", parsed.method)
        assertEquals("/v1/events", parsed.path)
        assertEquals(mapOf("name" to "a+b c"), parsed.query)
        assertEquals(body, parsed.body)
        val prefix = "GET /v1/status HTTP/1.1\r\nX-Pad: "
        val atLimit = prefix + "x".repeat(16384 - prefix.length - 4) + "\r\n\r\n"
        assertEquals("/v1/status", AndroidHttpRequest.read(ByteArrayInputStream(atLimit.toByteArray())).path)
        val largeBody = "x".repeat(4194304)
        val large = "POST /v1/events HTTP/1.1\r\nContent-Length: 4194304\r\n\r\n$largeBody"
        assertEquals(largeBody, AndroidHttpRequest.read(ByteArrayInputStream(large.toByteArray())).body)
    }

    @Test fun failedSocketRequestDoesNotPreventTheNextStatusRequest() {
        val badRequests = listOf(
            "POST /v1/events HTTP/1.1\r\nContent-Length: -1\r\n\r\n" to 400,
            "POST /v1/events HTTP/1.1\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}" to 400,
            "POST /v1/events HTTP/1.1\r\nContent-Length: 4\r\n\r\n{}" to 400,
            "POST /v1/events HTTP/1.1\r\nContent-Length: 4194305\r\n\r\n" to 413,
        )
        ServerSocket(0).use { listener ->
            val executor = Executors.newSingleThreadExecutor()
            try {
                val received = executor.submit<List<String>> {
                    val paths = mutableListOf<String>()
                    repeat(badRequests.size * 2) {
                        listener.accept().use { socket -> respond(socket)?.let { paths.add(it.path) } }
                    }
                    paths
                }
                for ((wire, status) in badRequests) {
                    assertTrue(exchange(listener.localPort, wire).startsWith("HTTP/1.1 $status "))
                    assertTrue(exchange(listener.localPort, "GET /v1/status HTTP/1.1\r\n\r\n").startsWith("HTTP/1.1 200 "))
                }
                assertEquals(List(badRequests.size) { "/v1/status" }, received.get(5, TimeUnit.SECONDS))
            } finally { executor.shutdownNow() }
        }
    }

    @Test fun trickledHeaderHasATotalDeadlineInAdditionToTheSocketIdleTimeout() {
        ServerSocket(0).use { listener ->
            val executor = Executors.newSingleThreadExecutor()
            val writer = Executors.newSingleThreadScheduledExecutor()
            Socket("127.0.0.1", listener.localPort).use { client ->
                try {
                    val response = executor.submit { listener.accept().use { respond(it) } }
                    client.getOutputStream().write("GET /v1/status HTTP/1.1\r\nX-Slow: ".toByteArray())
                    writer.scheduleAtFixedRate({ client.getOutputStream().write('x'.code) }, 0, 25, TimeUnit.MILLISECONDS)
                    client.soTimeout = 6500
                    val received = client.getInputStream().bufferedReader().readText()
                    assertTrue(received, received.startsWith("HTTP/1.1 408 "))
                    assertTrue(received, received.contains("http_request_timeout"))
                    response.get(1, TimeUnit.SECONDS)
                } finally { writer.shutdownNow(); executor.shutdownNow() }
            }
        }
    }

    private fun exchange(port: Int, wire: String): String = Socket("127.0.0.1", port).use { socket ->
        socket.soTimeout = 5000
        socket.getOutputStream().write(wire.toByteArray())
        socket.shutdownOutput()
        socket.getInputStream().bufferedReader().readText()
    }

    private fun respond(socket: Socket): AndroidHttpRequest? {
        socket.soTimeout = 1500
        var status = 200
        val request: AndroidHttpRequest?
        val body: String
        try {
            request = AndroidHttpRequest.read(socket.getInputStream())
            body = request.path
        } catch (error: AndroidHttpRequestFailure) {
            status = error.statusCode
            val reply = error.code
            socket.getOutputStream().write("HTTP/1.1 $status Error\r\nContent-Length: ${reply.length}\r\nConnection: close\r\n\r\n$reply".toByteArray())
            return null
        }
        socket.getOutputStream().write("HTTP/1.1 $status OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body".toByteArray())
        return request
    }
}
