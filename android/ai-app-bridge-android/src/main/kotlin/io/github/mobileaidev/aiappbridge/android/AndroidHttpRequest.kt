package io.github.mobileaidev.aiappbridge.android

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.IOException
import java.net.URLDecoder
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.StandardCharsets
import java.util.Locale

internal class AndroidHttpRequestFailure(val code: String, val statusCode: Int, message: String) : IOException(message)

internal data class AndroidHttpRequest(
    val method: String,
    val path: String,
    val query: Map<String, String>,
    val body: String,
) {
    companion object {
        private const val MAX_HEADER_BYTES = 16 * 1024
        private const val MAX_BODY_BYTES = 4 * 1024 * 1024
        private val headerName = Regex("[!#$%&'*+.^_`|~0-9A-Za-z-]+")

        fun read(input: InputStream): AndroidHttpRequest {
            // The socket idle timeout alone permits an endless trickle. This
            // deadline bounds framing; it does not limit an admitted action.
            val deadline = System.nanoTime() + 5_000_000_000L
            fun checkDeadline() {
                if (System.nanoTime() - deadline >= 0) throw AndroidHttpRequestFailure("http_request_timeout", 408,
                    "HTTP request headers and body must arrive within 5000 ms.")
            }
            val headerBytes = ByteArrayOutputStream()
            val tail = IntArray(4)
            var tailSize = 0
            while (true) {
                checkDeadline()
                val next = input.read()
                if (next == -1) throw AndroidHttpRequestFailure("incomplete_http_request", 400, "The connection ended before the HTTP headers were complete.")
                headerBytes.write(next)
                if (headerBytes.size() > MAX_HEADER_BYTES) throw AndroidHttpRequestFailure("http_request_too_large", 413, "HTTP headers exceed $MAX_HEADER_BYTES bytes.")
                tail[tailSize % tail.size] = next
                tailSize++
                if (tailSize >= 4 && isHeaderEnd(tail, tailSize)) break
            }
            val lines = decode(headerBytes.toByteArray()).removeSuffix("\r\n\r\n").split("\r\n")
            val firstLine = lines.first().split(" ")
            if (firstLine.size != 3 || !headerName.matches(firstLine[0]) || firstLine[1].isBlank() ||
                firstLine[2] !in listOf("HTTP/1.0", "HTTP/1.1")) throw AndroidHttpRequestFailure("invalid_http_request", 400, "Invalid HTTP request line.")
            val target = firstLine[1]
            var length: String? = null
            for (line in lines.drop(1)) {
                val colon = line.indexOf(':')
                if (colon <= 0 || !headerName.matches(line.substring(0, colon)))
                    throw AndroidHttpRequestFailure("invalid_http_request", 400, "Invalid HTTP header.")
                when (line.substring(0, colon).lowercase(Locale.ROOT)) {
                    "content-length" -> {
                        if (length != null) throw AndroidHttpRequestFailure("invalid_http_request", 400, "Duplicate Content-Length is not supported.")
                        length = line.substring(colon + 1).trim()
                    }
                    "transfer-encoding" -> throw AndroidHttpRequestFailure("invalid_http_request", 400, "Transfer-Encoding is not supported; send a Content-Length body.")
                }
            }
            val contentLength = if (length == null) 0 else
                length.takeIf { it.matches(Regex("[0-9]+")) }?.toIntOrNull()
                    ?: throw AndroidHttpRequestFailure("invalid_http_request", 400, "Content-Length must be a non-negative decimal integer.")
            if (contentLength > MAX_BODY_BYTES) throw AndroidHttpRequestFailure("http_request_too_large", 413, "HTTP body exceeds $MAX_BODY_BYTES bytes.")
            val bodyBytes = ByteArray(contentLength)
            var offset = 0
            while (offset < contentLength) {
                checkDeadline()
                val read = input.read(bodyBytes, offset, contentLength - offset)
                if (read < 0) throw AndroidHttpRequestFailure("incomplete_http_request", 400, "The connection ended after $offset of $contentLength body bytes.")
                offset += read
            }
            checkDeadline()
            return AndroidHttpRequest(firstLine[0], target.substringBefore("?"),
                parseQuery(target.substringAfter("?", "")), decode(bodyBytes))
        }

        private fun isHeaderEnd(tail: IntArray, tailSize: Int): Boolean {
            val start = tailSize % tail.size
            return tail[start] == '\r'.code && tail[(start + 1) % tail.size] == '\n'.code &&
                tail[(start + 2) % tail.size] == '\r'.code && tail[(start + 3) % tail.size] == '\n'.code
        }

        private fun decode(bytes: ByteArray): String = try {
            StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: CharacterCodingException) {
            throw AndroidHttpRequestFailure("invalid_http_request", 400, "HTTP request text must be valid UTF-8.")
        }

        private fun parseQuery(rawQuery: String): Map<String, String> = try {
            if (rawQuery.isBlank()) emptyMap() else rawQuery.split("&").filter { it.isNotBlank() }.associate { part ->
                URLDecoder.decode(part.substringBefore("="), StandardCharsets.UTF_8.name()) to
                    URLDecoder.decode(part.substringAfter("=", ""), StandardCharsets.UTF_8.name())
            }
        } catch (_: IllegalArgumentException) {
            throw AndroidHttpRequestFailure("invalid_http_request", 400, "HTTP query contains invalid percent encoding.")
        }
    }
}
