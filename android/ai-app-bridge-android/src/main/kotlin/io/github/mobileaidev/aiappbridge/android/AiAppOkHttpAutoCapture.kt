package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject
import java.lang.reflect.InvocationHandler
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import java.util.Collections
import java.util.WeakHashMap

object AiAppOkHttpAutoCapture {
    private const val source = "okhttp-auto"
    private const val maxBodyBytes = 20_000L
    private val installedBuilders = Collections.synchronizedMap(WeakHashMap<Any, Boolean>())

    @JvmStatic
    fun installBuilder(builder: Any?): Any? {
        if (builder == null) {
            return null
        }
        if (installedBuilders.containsKey(builder)) {
            return builder
        }
        return try {
            val builderClass = builder.javaClass
            val interceptorClass = Class.forName("okhttp3.Interceptor", false, builderClass.classLoader)
            val interceptor = Proxy.newProxyInstance(
                interceptorClass.classLoader,
                arrayOf(interceptorClass),
                OkHttpInterceptorInvocationHandler(),
            )
            // Do not enumerate all public Builder methods here. OkHttp 4.x exposes
            // java.time.Duration overloads; resolving those on older Android
            // devices can throw NoClassDefFoundError before we get to addInterceptor.
            val addInterceptor = builderClass.getDeclaredMethod("addInterceptor", interceptorClass)
            addInterceptor.invoke(builder, interceptor)
            installedBuilders[builder] = true
            builder
        } catch (error: Throwable) {
            AiAppBridge.recordLog(
                level = "warn",
                tag = "AiAppOkHttpAutoCapture",
                message = "failed to install OkHttp interceptor",
                dataJson = JSONObject().put("error", error.toString()).toString(),
            )
            builder
        }
    }

    private class OkHttpInterceptorInvocationHandler : InvocationHandler {
        override fun invoke(proxy: Any, method: Method, args: Array<out Any?>?): Any? {
            if (method.name == "toString" && method.parameterTypes.isEmpty()) {
                return "AiAppOkHttpAutoCaptureInterceptor"
            }
            if (method.name == "hashCode" && method.parameterTypes.isEmpty()) {
                return System.identityHashCode(proxy)
            }
            if (method.name == "equals" && method.parameterTypes.size == 1) {
                return proxy === args?.firstOrNull()
            }
            if (method.name != "intercept") {
                return method.defaultValue
            }

            val chain = args?.firstOrNull()
                ?: throw IllegalArgumentException("OkHttp chain argument missing")
            val request = invokeNoArgs(chain, "request")
            val startedAt = System.nanoTime()
            return try {
                val response = invokeMethod(chain, "proceed", request)
                val durationMs = (System.nanoTime() - startedAt) / 1_000_000L
                recordRequestResponse(request, response, durationMs, null)
                response
            } catch (error: Throwable) {
                val unwrapped = unwrapInvocation(error)
                val durationMs = (System.nanoTime() - startedAt) / 1_000_000L
                recordRequestResponse(request, null, durationMs, unwrapped.toString())
                throw unwrapped
            }
        }
    }

    private fun recordRequestResponse(
        request: Any?,
        response: Any?,
        durationMs: Long,
        error: String?,
    ) {
        val method = invokeNoArgs(request, "method")?.toString().orEmpty().ifBlank { "GET" }
        val url = invokeNoArgs(request, "url")?.toString().orEmpty()
        val statusCode = (invokeNoArgs(response, "code") as? Int) ?: if (error == null) 0 else -1
        val requestHeaders = headersToJson(invokeNoArgs(request, "headers"))
        val responseHeaders = headersToJson(invokeNoArgs(response, "headers"))
        val requestBody = requestBodyToString(invokeNoArgs(request, "body"))
        val responseBody = responseBodyToString(response)
        AiAppBridge.recordNetworkAuto(
            source = source,
            method = method,
            url = url,
            statusCode = statusCode,
            durationMs = durationMs,
            requestHeadersJson = requestHeaders.toString(),
            responseHeadersJson = responseHeaders.toString(),
            requestBody = requestBody,
            responseBody = responseBody,
            error = error,
        )
    }

    private fun headersToJson(headers: Any?): JSONObject {
        val result = JSONObject()
        if (headers == null) {
            return result
        }
        val names = invokeNoArgs(headers, "names") as? Set<*> ?: return result
        for (nameValue in names) {
            val name = nameValue?.toString() ?: continue
            val value = if (shouldRedact(name)) {
                "<redacted>"
            } else {
                invokeMethod(headers, "get", name)?.toString().orEmpty()
            }
            result.put(name, value)
        }
        return result
    }

    private fun shouldRedact(name: String): Boolean {
        val normalized = name.lowercase()
        return normalized.contains("authorization") ||
            normalized.contains("cookie") ||
            normalized.contains("token") ||
            normalized.contains("secret") ||
            normalized.contains("password")
    }

    private fun requestBodyToString(body: Any?): String? {
        if (body == null) {
            return null
        }
        return try {
            val contentType = invokeNoArgs(body, "contentType")?.toString()
            if (!isLikelyTextContentType(contentType)) {
                return omittedNonTextBody(contentType)
            }
            val contentLength = (invokeNoArgs(body, "contentLength") as? Long) ?: -1L
            if (contentLength > maxBodyBytes) {
                return "<omitted: request body too large>"
            }
            val bufferClass = Class.forName("okio.Buffer", false, body.javaClass.classLoader)
            val buffer = bufferClass.getDeclaredConstructor().newInstance()
            invokeMethod(body, "writeTo", buffer)
            invokeNoArgs(buffer, "readUtf8")?.toString()
        } catch (error: Throwable) {
            "<unavailable: ${error.javaClass.simpleName}>"
        }
    }

    private fun responseBodyToString(response: Any?): String? {
        if (response == null) {
            return null
        }
        return try {
            val body = invokeNoArgs(response, "body")
            val contentType = invokeNoArgs(body, "contentType")?.toString()
            if (!isLikelyTextContentType(contentType)) {
                return omittedNonTextBody(contentType)
            }
            // peekBody(long) may not exist on OkHttp < 3.12. Gracefully skip response
            // body capture if the method is not found.
            val peekBodyMethod = response.javaClass.methods.firstOrNull { method ->
                method.name == "peekBody" && method.parameterTypes.size == 1
            } ?: return null
            val peekBody = peekBodyMethod.invoke(response, maxBodyBytes) ?: return null
            invokeNoArgs(peekBody, "string")?.toString()
        } catch (error: Throwable) {
            "<unavailable: ${error.javaClass.simpleName}>"
        }
    }

    private fun isLikelyTextContentType(contentType: String?): Boolean {
        val normalized = contentType?.lowercase()?.trim().orEmpty()
        if (normalized.isBlank()) {
            return true
        }
        return normalized.startsWith("text/") ||
            normalized.contains("json") ||
            normalized.contains("xml") ||
            normalized.contains("html") ||
            normalized.contains("javascript") ||
            normalized.contains("x-www-form-urlencoded") ||
            normalized.contains("graphql") ||
            normalized.contains("csv") ||
            normalized.contains("yaml")
    }

    private fun omittedNonTextBody(contentType: String?): String {
        val suffix = contentType?.takeIf { it.isNotBlank() }?.let { "; contentType=$it" }.orEmpty()
        return "<omitted: non-text body$suffix>"
    }

    private fun invokeNoArgs(target: Any?, name: String): Any? {
        if (target == null) {
            return null
        }
        return try {
            target.javaClass.methods.firstOrNull { method ->
                method.name == name && method.parameterTypes.isEmpty()
            }?.invoke(target)
        } catch (_: Throwable) {
            null
        }
    }

    private fun invokeMethod(target: Any?, name: String, vararg args: Any?): Any? {
        if (target == null) {
            return null
        }
        return try {
            val method = target.javaClass.methods.firstOrNull { candidate ->
                candidate.name == name && candidate.parameterTypes.size == args.size
            } ?: return null
            method.invoke(target, *args)
        } catch (error: InvocationTargetException) {
            throw error.targetException
        }
    }

    private fun unwrapInvocation(error: Throwable): Throwable {
        return if (error is InvocationTargetException && error.targetException != null) {
            error.targetException
        } else {
            error
        }
    }
}

