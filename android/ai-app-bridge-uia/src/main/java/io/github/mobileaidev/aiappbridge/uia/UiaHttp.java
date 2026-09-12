package io.github.mobileaidev.aiappbridge.uia;

import android.net.LocalSocket;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** One bounded, authenticated HTTP request per ADB-forwarded local socket. */
final class UiaHttp {
    private static final java.util.concurrent.atomic.AtomicInteger reportedFailures = new java.util.concurrent.atomic.AtomicInteger();
    interface Handler { JSONObject handle(JSONObject request) throws Exception; }

    static void serve(LocalSocket socket, String token, Handler handler) {
        try (LocalSocket opened = socket) {
            opened.setSoTimeout(5000);
            JSONObject result;
            int status = 200;
            try { result = handler.handle(read(opened.getInputStream(), token)); }
            catch (Exception error) {
                status = error instanceof Wire.Failure && ((Wire.Failure) error).code.equals("uia_unauthorized") ? 401 : 400;
                result = Wire.failure(error);
            }
            byte[] body = result.toString().getBytes(StandardCharsets.UTF_8);
            if (body.length > 1048576) {
                status = 500;
                body = "{\"ok\":false,\"error\":\"uia_response_capacity_exhausted\"}".getBytes(StandardCharsets.UTF_8);
            }
            OutputStream output = opened.getOutputStream();
            output.write(("HTTP/1.1 " + status + " Result\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: "
                + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            output.write(body); output.flush();
        } catch (Exception error) {
            // A disconnected client cannot cancel or acknowledge its action.
            if (reportedFailures.getAndUpdate(count -> Math.min(count + 1, 16)) < 16)
                System.err.println("uia_http_connection_closed: " + error.getClass().getSimpleName());
        }
    }

    private static JSONObject read(InputStream input, String token) throws Exception {
        ByteArrayOutputStream header = new ByteArrayOutputStream();
        int ending = 0;
        while (ending != 0x0d0a0d0a) {
            int value = input.read();
            if (value < 0 || header.size() >= 8192 || value > 127) throw new Wire.Failure("uia_invalid_http_headers");
            header.write(value); ending = (ending << 8) | value;
        }
        String[] lines = new String(header.toByteArray(), StandardCharsets.US_ASCII).split("\r\n");
        if (!lines[0].equals("POST /v1 HTTP/1.1")) throw new Wire.Failure("uia_invalid_http_request");
        Map<String, String> fields = new HashMap<>();
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon < 1) throw new Wire.Failure("uia_invalid_http_headers");
            String key = lines[i].substring(0, colon).toLowerCase(Locale.ROOT);
            if (!key.matches("[a-z0-9-]+") || fields.put(key, lines[i].substring(colon + 1).trim()) != null)
                throw new Wire.Failure("uia_invalid_http_headers");
        }
        String authorization = fields.get("authorization");
        if (authorization == null || !MessageDigest.isEqual(authorization.getBytes(StandardCharsets.UTF_8),
                ("Bearer " + token).getBytes(StandardCharsets.UTF_8))) throw new Wire.Failure("uia_unauthorized");
        String size = fields.get("content-length");
        if (fields.containsKey("transfer-encoding") || fields.containsKey("expect") || size == null || !size.matches("[1-9][0-9]{0,6}"))
            throw new Wire.Failure("uia_invalid_http_length");
        int length = Integer.parseInt(size);
        if (length > 65536) throw new Wire.Failure("uia_request_capacity_exhausted");
        byte[] body = new byte[length];
        for (int offset = 0; offset < length;) {
            int count = input.read(body, offset, length - offset);
            if (count < 0) throw new Wire.Failure("uia_truncated_http_body");
            offset += count;
        }
        return new JSONObject(StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(body)).toString());
    }
}
