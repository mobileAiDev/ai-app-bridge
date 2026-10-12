package io.github.mobileaidev.aiappbridge.uia;

import org.json.JSONObject;

/** Node identity is distinct from changing text, layout and widget state. */
final class UiaNodeIdentity {
    static boolean sameNode(JSONObject before, JSONObject after) throws Exception {
        for (String key : new String[]{"sourceId", "windowId", "packageName", "className", "resourceName"}) {
            if (!before.get(key).equals(after.get(key))) return false;
        }
        return true;
    }
}
