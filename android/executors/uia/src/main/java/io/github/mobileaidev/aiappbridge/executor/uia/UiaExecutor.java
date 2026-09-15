package io.github.mobileaidev.aiappbridge.executor.uia;

import android.graphics.Rect;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.Direction;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import io.github.mobileaidev.aiappbridge.executor.ExecutorAdapter;
import io.github.mobileaidev.aiappbridge.executor.ExecutorFailure;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

public final class UiaExecutor implements ExecutorAdapter {
    private final UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    private final Map<String, Node> nodes = new LinkedHashMap<>();
    private String snapshotId;

    @Override public JSONObject capabilities() throws Exception {
        return new JSONObject().put("engine", "uiautomator").put("compiledAgainst", "2.4.0").put("scope", "device-accessibility")
            .put("actions", new JSONArray(new String[] {"click", "longClick", "setText", "scroll", "back", "home"}))
            .put("textMechanism", "accessibility-ACTION_SET_TEXT-with-readback")
            .put("limitations", new JSONArray(new String[] {"accessibility tree only", "no DOM or Compose internals", "no business completion inference"}));
    }

    @Override public JSONObject observe(JSONObject request) throws Exception {
        nodes.clear(); snapshotId = UUID.randomUUID().toString();
        JSONArray tree = new JSONArray();
        for (UiObject2 root : device.findObjects(By.depth(0))) append(root, null, tree, 0);
        return new JSONObject().put("snapshotId", snapshotId).put("nodes", tree).put("foregroundPackage", device.getCurrentPackageName())
            .put("display", new JSONObject().put("width", device.getDisplayWidth()).put("height", device.getDisplayHeight()))
            .put("observedAtMs", System.currentTimeMillis());
    }

    private void append(UiObject2 object, String parent, JSONArray tree, int depth) throws Exception {
        if (nodes.size() >= 2000 || depth > 80) throw new ExecutorFailure("executor_tree_limit", "Accessibility tree exceeds the observation limit");
        String id = String.valueOf(nodes.size());
        JSONObject value = describe(object);
        nodes.put(id, new Node(object, value.toString()));
        tree.put(value.put("nodeId", id).put("parentId", parent == null ? JSONObject.NULL : parent));
        for (UiObject2 child : object.getChildren()) append(child, id, tree, depth + 1);
    }

    private JSONObject describe(UiObject2 object) throws Exception {
        Rect bounds = object.getVisibleBounds();
        return new JSONObject().put("className", object.getClassName()).put("resourceId", object.getResourceName())
            .put("text", object.getText()).put("description", object.getContentDescription()).put("packageName", object.getApplicationPackage())
            .put("clickable", object.isClickable()).put("enabled", object.isEnabled()).put("scrollable", object.isScrollable())
            .put("bounds", new JSONArray(new int[] {bounds.left, bounds.top, bounds.right, bounds.bottom}));
    }

    @Override public JSONObject act(JSONObject request) throws Exception {
        if (snapshotId == null || !snapshotId.equals(request.getString("snapshotId"))) throw new ExecutorFailure("reobserve_required", "UI Automator observation changed");
        JSONObject action = request.getJSONObject("action");
        String type = action.getString("type");
        if (type.equals("back") || type.equals("home")) {
            boolean accepted = type.equals("back") ? device.pressBack() : device.pressHome();
            if (!accepted) throw new ExecutorFailure("executor_key_rejected", "System key was rejected", true);
            return new JSONObject().put("mechanism", "uiautomator-system-key").put("type", type);
        }
        Node node = nodes.get(action.getString("nodeId"));
        if (node == null) throw new ExecutorFailure("reobserve_required", "Node is not in this observation");
        if (!node.fingerprint.equals(describe(node.object).toString())) throw new ExecutorFailure("reobserve_required", "Observed node properties or bounds changed");
        switch (type) {
            case "click": node.object.click(); break;
            case "longClick": node.object.longClick(); break;
            case "setText":
                node.object.setText(action.getString("text"));
                if (!action.getString("text").equals(node.object.getText())) throw new ExecutorFailure("executor_postcondition_failed", "Accessibility input did not retain the requested text", true);
                break;
            case "scroll":
                boolean canContinue = node.object.scroll(Direction.valueOf(action.getString("direction").toUpperCase(java.util.Locale.ROOT)), (float) action.getDouble("percent"));
                return new JSONObject().put("mechanism", "uiautomator-scroll-gesture").put("canScrollFurther", canContinue);
            default: throw new ExecutorFailure("executor_action_unsupported", "Unsupported UI Automator action");
        }
        return new JSONObject().put("mechanism", type.equals("setText") ? "accessibility-ACTION_SET_TEXT" : "uiautomator-touch-gesture").put("type", type);
    }

    private static final class Node {
        final UiObject2 object;
        final String fingerprint;
        Node(UiObject2 object, String fingerprint) { this.object = object; this.fingerprint = fingerprint; }
    }
}
