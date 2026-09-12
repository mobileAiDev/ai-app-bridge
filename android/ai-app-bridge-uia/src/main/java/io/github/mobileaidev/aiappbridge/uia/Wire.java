package io.github.mobileaidev.aiappbridge.uia;

import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;

/** Strict wire types; Android JSONObject getters otherwise coerce strings and numbers. */
final class Wire {
    static final String EXECUTION = "aab.uia.execution.v1";
    static final String RECORD = "aab.uia.record.v2";
    static final String SNAPSHOT = "aab.uia.snapshot.v1";

    static final class Failure extends Exception {
        final String code;
        Failure(String code) { super(code); this.code = code; }
        Failure(String code, Throwable cause) { super(code, cause); this.code = code; }
    }

    static void keys(JSONObject value, String... names) throws Exception {
        Set<String> remaining = new HashSet<>(Arrays.asList(names));
        Iterator<String> keys = value.keys();
        while (keys.hasNext()) if (!remaining.remove(keys.next())) throw new Failure("invalid_request_fields");
        if (!remaining.isEmpty()) throw new Failure("missing_request_fields");
    }

    static String string(JSONObject value, String key) throws Exception {
        Object result = value.get(key);
        if (!(result instanceof String) || ((String) result).isEmpty()) throw new Failure("invalid_" + key);
        return (String) result;
    }

    static long integer(JSONObject value, String key, long min, long max) throws Exception {
        Object result = value.get(key);
        if (!(result instanceof Integer) && !(result instanceof Long)) throw new Failure("invalid_" + key);
        long number = ((Number) result).longValue();
        if (number < min || number > max) throw new Failure("invalid_" + key);
        return number;
    }

    static boolean bool(JSONObject value, String key) throws Exception {
        Object result = value.get(key);
        if (!(result instanceof Boolean)) throw new Failure("invalid_" + key);
        return (Boolean) result;
    }

    static JSONObject object(JSONObject value, String key) throws Exception {
        Object result = value.get(key);
        if (!(result instanceof JSONObject)) throw new Failure("invalid_" + key);
        return (JSONObject) result;
    }

    static String uuid(JSONObject value, String key) throws Exception {
        String result = string(value, key);
        if (!result.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) throw new Failure("invalid_" + key);
        return result;
    }

    static String actionId(JSONObject value) throws Exception {
        String result = string(value, "actionId");
        if (result.length() > 1024) throw new Failure("invalid_actionId");
        for (int index = 0; index < result.length(); index++) {
            char next = result.charAt(index);
            if (Character.isHighSurrogate(next)) {
                if (++index >= result.length() || !Character.isLowSurrogate(result.charAt(index))) throw new Failure("invalid_actionId");
            } else if (Character.isLowSurrogate(next)) throw new Failure("invalid_actionId");
        }
        return result;
    }

    static JSONObject request(String raw, String hash, String bootId, String epoch) throws Exception {
        if (raw.getBytes(StandardCharsets.UTF_8).length > 32768 || !sha256(raw).equals(hash))
            throw new Failure("uia_request_hash_mismatch");
        JSONObject request = new JSONObject(raw);
        keys(request, "schemaVersion", "bootId", "runtimeEpoch", "actionId", "timeoutMs", "target", "clickPolicy");
        if (!EXECUTION.equals(string(request, "schemaVersion"))) throw new Failure("uia_schema_mismatch");
        if (!bootId.equals(uuid(request, "bootId")) || !epoch.equals(uuid(request, "runtimeEpoch")))
            throw new Failure("uia_runtime_identity_mismatch");
        actionId(request); integer(request, "timeoutMs", 1, 60000);
        String policy = string(request, "clickPolicy");
        if (!policy.equals("exact_node") && !policy.equals("nearest_clickable_ancestor")) throw new Failure("invalid_clickPolicy");
        JSONObject target = object(request, "target");
        keys(target, "snapshotId", "ref", "selector");
        uuid(target, "snapshotId"); uuid(target, "ref");
        JSONObject selector = object(target, "selector");
        keys(selector, "kind", "value", "exact", "packageName");
        String kind = string(selector, "kind");
        if (!kind.equals("text") && !kind.equals("contentDescription") && !kind.equals("resourceName") && !kind.equals("nodeRef"))
            throw new Failure("invalid_selector_kind");
        if (string(selector, "value").length() > 4096) throw new Failure("invalid_selector_value");
        bool(selector, "exact");
        if (kind.equals("nodeRef") && (!bool(selector, "exact") || !uuid(selector, "value").equals(target.getString("ref"))
                || selector.isNull("packageName"))) throw new Failure("invalid_node_reference_selector");
        if (!selector.isNull("packageName")) string(selector, "packageName");
        return request;
    }

    static String sha256(String text) throws Exception { return sha256(text.getBytes(StandardCharsets.UTF_8)); }
    static String sha256(byte[] bytes) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format("%02x", b & 255));
        return result.toString();
    }

    static String code(Exception error) { return error instanceof Failure ? ((Failure) error).code : "uia_runtime_error"; }
    static JSONObject failure(Exception error) throws Exception {
        return new JSONObject().put("ok", false).put("error", code(error)).put("message", error.toString());
    }
}
