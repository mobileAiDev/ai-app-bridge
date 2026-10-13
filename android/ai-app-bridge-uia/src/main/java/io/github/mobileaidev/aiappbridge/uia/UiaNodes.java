package io.github.mobileaidev.aiappbridge.uia;

import android.graphics.Rect;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import org.json.JSONObject;
import org.json.JSONArray;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** All observation and validation calls run on the runtime's single UI worker. */
final class UiaNodes implements UiaActionEngine.Gateway {
    private static final int MAX_NODES = 2000, MAX_DEPTH = 64, MAX_SNAPSHOTS = 8;
    private static final long SNAPSHOT_TTL_MS = 60000;
    private final UiaConnection connection;
    private final String bootId, epoch;
    private final JSONArray startupWarnings;
    private final Map<String, Snapshot> snapshots = new LinkedHashMap<>();

    private static final class Node {
        final String ref = UUID.randomUUID().toString();
        final AccessibilityNodeInfo handle;
        final JSONObject identity;
        final Node parent;
        final List<Node> children = new ArrayList<>();
        Node(AccessibilityNodeInfo handle, JSONObject identity, Node parent) {
            this.handle = handle; this.identity = identity; this.parent = parent;
        }
    }

    private static final class Snapshot {
        final String id = UUID.randomUUID().toString();
        final long created = SystemClock.elapsedRealtime(), expires = created + SNAPSHOT_TTL_MS;
        final Map<String, Node> nodes = new LinkedHashMap<>();
        final List<Node> roots = new ArrayList<>();
        final JSONArray windows = new JSONArray(), warnings = new JSONArray();
        JSONObject window;
        boolean truncated;
    }

    UiaNodes(UiaConnection connection, String bootId, String epoch, JSONArray startupWarnings) {
        this.connection = connection; this.bootId = bootId; this.epoch = epoch;
        this.startupWarnings = startupWarnings;
    }

    private static Object nullable(CharSequence value) { return value == null ? JSONObject.NULL : value.toString(); }

    private JSONObject identity(AccessibilityNodeInfo node) throws Exception {
        Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
        return new JSONObject().put("sourceId", Long.toString(connection.sourceId(node))).put("windowId", node.getWindowId())
            .put("packageName", nullable(node.getPackageName())).put("className", nullable(node.getClassName()))
            .put("text", nullable(node.getText())).put("contentDescription", nullable(node.getContentDescription()))
            .put("resourceName", nullable(node.getViewIdResourceName()))
            .put("bounds", "[" + bounds.left + "," + bounds.top + "][" + bounds.right + "," + bounds.bottom + "]")
            .put("enabled", node.isEnabled()).put("visible", node.isVisibleToUser()).put("clickable", node.isClickable())
            .put("checkable", node.isCheckable()).put("checked", node.isChecked()).put("scrollable", node.isScrollable());
    }

    private Node walk(AccessibilityNodeInfo handle, Node parent, Snapshot snapshot, int depth) throws Exception {
        if (depth > MAX_DEPTH || snapshot.nodes.size() >= MAX_NODES) { snapshot.truncated = true; return null; }
        Node node = new Node(handle, identity(handle), parent); snapshot.nodes.put(node.ref, node);
        for (int index = 0; index < handle.getChildCount(); index++) {
            AccessibilityNodeInfo child = handle.getChild(index);
            if (child == null) { snapshot.truncated = true; continue; }
            Node observed = walk(child, node, snapshot, depth + 1);
            if (observed != null) node.children.add(observed);
        }
        return node;
    }

    private Snapshot read(Integer windowId) throws Exception {
        Snapshot snapshot = new Snapshot();
        for (AccessibilityWindowInfo window : connection.windows()) {
            if (UiaConnection.displayId(window) != 0 || windowId != null && window.getId() != windowId) continue;
            JSONObject info = new JSONObject().put("id", window.getId()).put("displayId", UiaConnection.displayId(window))
                .put("type", window.getType()).put("focused", window.isFocused()).put("title", nullable(window.getTitle()));
            snapshot.windows.put(info);
            if (windowId != null || window.isFocused()) snapshot.window = info;
            AccessibilityNodeInfo root = window.getRoot();
            if (root == null) {
                snapshot.truncated = true;
                snapshot.warnings.put(new JSONObject().put("code", "uia_window_root_unavailable").put("windowId", window.getId()).put("blocking", false));
                continue;
            }
            Node observed = walk(root, null, snapshot, 0);
            if (observed != null) snapshot.roots.add(observed);
        }
        if (snapshot.windows.length() == 0) {
            snapshot.truncated = true;
            snapshot.warnings.put(new JSONObject().put("code", "uia_windows_unavailable").put("blocking", false));
        }
        if (windowId != null && snapshot.window == null) throw new Wire.Failure("uia_stale_reference");
        if (snapshot.window == null) snapshot.warnings.put(new JSONObject().put("code", "uia_focused_window_unavailable").put("blocking", false));
        return snapshot;
    }

    JSONObject observe() throws Exception {
        // A snapshot describes the current UI. Unrelated accessibility events
        // must not delay reads; callers wait for the specific state they need.
        Snapshot snapshot = read(null);
        for (int i = 0; i < startupWarnings.length(); i++) snapshot.warnings.put(startupWarnings.get(i));
        Iterator<Snapshot> existing = snapshots.values().iterator();
        while (existing.hasNext()) if (existing.next().expires <= snapshot.created) existing.remove();
        if (snapshots.size() == MAX_SNAPSHOTS) snapshots.remove(snapshots.keySet().iterator().next());
        StringBuilder body = new StringBuilder();
        for (int i = 0; i < snapshot.roots.size(); i++) xml(snapshot.roots.get(i), body, i, snapshot);
        if (snapshot.truncated) snapshot.warnings.put(new JSONObject().put("code", "uia_tree_incomplete")
            .put("message", "Some nodes were unavailable or exceeded the observation budget. Returned references remain selectable.").put("blocking", false));
        StringBuilder xml = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?><hierarchy");
        attr(xml, "aab-schema", Wire.SNAPSHOT); attr(xml, "aab-boot-id", bootId);
        attr(xml, "aab-runtime-epoch", epoch); attr(xml, "aab-snapshot-id", snapshot.id);
        attr(xml, "aab-truncated", Boolean.toString(snapshot.truncated));
        attr(xml, "aab-warnings", snapshot.warnings.toString());
        xml.append('>').append(body).append("</hierarchy>");
        snapshots.put(snapshot.id, snapshot);
        return new JSONObject().put("ok", true).put("schemaVersion", Wire.SNAPSHOT).put("bootId", bootId)
            .put("runtimeEpoch", epoch).put("snapshotId", snapshot.id).put("createdAtElapsedMs", snapshot.created)
            .put("expiresAtElapsedMs", snapshot.expires).put("window", snapshot.window == null ? JSONObject.NULL : snapshot.window)
            .put("windows", snapshot.windows).put("warnings", snapshot.warnings).put("truncated", snapshot.truncated)
            .put("nodeCount", snapshot.nodes.size()).put("xml", xml.toString());
    }

    // The XML surface has Android UIA's explicit empty-string encoding for absent optional text.
    private static String xmlValue(JSONObject value, String key) throws Exception {
        return value.isNull(key) ? "" : value.get(key).toString();
    }

    private static void xml(Node node, StringBuilder output, int index, Snapshot snapshot) throws Exception {
        StringBuilder tag = new StringBuilder();
        xmlTag(node, tag, index);
        if (output.length() + tag.length() > 480000) { snapshot.truncated = true; return; }
        output.append(tag);
        for (int i = 0; i < node.children.size(); i++) xml(node.children.get(i), output, i, snapshot);
        output.append("</node>");
    }

    private static void xmlTag(Node node, StringBuilder output, int index) throws Exception {
        output.append("<node"); attr(output, "index", Integer.toString(index)); attr(output, "aab-ref", node.ref);
        attr(output, "aab-window-id", node.identity.get("windowId").toString());
        String[][] names = {{"package", "packageName"}, {"class", "className"}, {"text", "text"},
            {"content-desc", "contentDescription"}, {"resource-id", "resourceName"}, {"bounds", "bounds"},
            {"enabled", "enabled"}, {"visible-to-user", "visible"}, {"clickable", "clickable"},
            {"checkable", "checkable"}, {"checked", "checked"}, {"scrollable", "scrollable"}};
        for (String[] name : names) attr(output, name[0], xmlValue(node.identity, name[1]));
        output.append('>');
    }

    private static void attr(StringBuilder output, String key, String value) throws Exception {
        output.append(' ').append(key).append("=\"");
        for (int offset = 0; offset < value.length();) {
            int point = value.codePointAt(offset); offset += Character.charCount(point);
            if (!(point == 9 || point == 10 || point == 13 || point >= 32 && point <= 0xD7FF
                    || point >= 0xE000 && point <= 0xFFFD || point >= 0x10000 && point <= 0x10FFFF))
                throw new Wire.Failure("uia_xml_invalid_character");
            switch (point) {
                case '&': output.append("&amp;"); break;
                case '<': output.append("&lt;"); break;
                case '>': output.append("&gt;"); break;
                case '"': output.append("&quot;"); break;
                case 9: output.append("&#9;"); break;
                case 10: output.append("&#10;"); break;
                case 13: output.append("&#13;"); break;
                default: output.appendCodePoint(point);
            }
        }
        output.append('"');
    }

    private static boolean matches(Node node, JSONObject selector) throws Exception {
        if (!node.identity.getBoolean("visible")) return false;
        if (!selector.isNull("packageName") && !selector.get("packageName").equals(node.identity.get("packageName"))) return false;
        String kind = Wire.string(selector, "kind");
        Object actual = kind.equals("nodeRef") ? node.ref : node.identity.get(kind);
        if (actual == JSONObject.NULL) return false;
        String value = Wire.string(selector, "value");
        return Wire.bool(selector, "exact") ? actual.equals(value) : ((String) actual).contains(value);
    }

    private static Node clickNode(Node node, String policy) throws Exception {
        if (policy.equals("nearest_clickable_ancestor")) while (!node.identity.getBoolean("clickable") && node.parent != null) node = node.parent;
        if (!node.identity.getBoolean("clickable") || !node.identity.getBoolean("enabled") || !node.identity.getBoolean("visible"))
            throw new Wire.Failure("uia_target_not_operable");
        return node;
    }

    @Override public JSONObject validate(JSONObject request) throws Exception {
        JSONObject target = Wire.object(request, "target");
        Snapshot snapshot = snapshots.get(Wire.string(target, "snapshotId"));
        if (snapshot == null || snapshot.expires <= SystemClock.elapsedRealtime()) throw new Wire.Failure("uia_stale_reference");
        Node original = snapshot.nodes.get(Wire.string(target, "ref"));
        if (original == null) throw new Wire.Failure("uia_stale_reference");
        JSONObject selector = Wire.object(target, "selector");
        if (!matches(original, selector)) throw new Wire.Failure("uia_reference_selector_mismatch");
        Snapshot current = read(original.identity.getInt("windowId"));
        Node selected = null;
        boolean byReference = selector.getString("kind").equals("nodeRef");
        for (Node node : current.nodes.values()) if (node.identity.getString("sourceId").equals(original.identity.getString("sourceId"))) {
            if (selected != null) throw new Wire.Failure("uia_target_ambiguous");
            selected = node;
        }
        if (selected == null) throw new Wire.Failure("uia_target_not_found");
        if (!byReference && !matches(selected, selector)) throw new Wire.Failure("uia_reference_selector_mismatch");
        if (!UiaNodeIdentity.sameNode(original.identity, selected.identity)) throw new Wire.Failure("uia_reobserve_required");
        if (!selected.identity.getBoolean("enabled")) throw new Wire.Failure("uia_target_not_operable");
        String policy = Wire.string(request, "clickPolicy");
        Node originalAction = original, action = clickNode(selected, policy);
        if (policy.equals("nearest_clickable_ancestor")) while (!originalAction.identity.getBoolean("clickable") && originalAction.parent != null) originalAction = originalAction.parent;
        if (!UiaNodeIdentity.sameNode(originalAction.identity, action.identity)) throw new Wire.Failure("uia_reobserve_required");
        if (!original.handle.refresh() || !UiaNodeIdentity.sameNode(identity(original.handle), original.identity)
                || !action.handle.refresh() || !UiaNodeIdentity.sameNode(identity(action.handle), action.identity))
            throw new Wire.Failure("uia_reobserve_required");
        org.json.JSONArray warnings = new org.json.JSONArray();
        if (!selected.identity.toString().equals(original.identity.toString())) warnings.put(new JSONObject()
            .put("code", "uia_target_attributes_changed").put("blocking", false)
            .put("before", original.identity).put("current", selected.identity));
        if (!current.window.getBoolean("focused")) warnings.put(new JSONObject().put("code", "uia_window_not_focused")
            .put("source", "AccessibilityWindowInfo.isFocused").put("observedAtMs", System.currentTimeMillis())
            .put("windowId", current.window.getInt("id")));
        return new JSONObject().put("snapshotId", snapshot.id).put("ref", original.ref).put("selector", selector)
            .put("clickPolicy", policy).put("target", selected.identity).put("actionTarget", action.identity)
            .put("window", current.window)
            .put("warnings", warnings)
            .put("identityStrength", "same_connection_node");
    }

    @Override public boolean dispatch(JSONObject binding, int interactionId, UiaActionEngine.Callback callback) throws Exception {
        JSONObject action = binding.getJSONObject("actionTarget");
        return connection.requestClick(action.getInt("windowId"), Long.parseLong(action.getString("sourceId")),
            interactionId, callback::completed);
    }
}
