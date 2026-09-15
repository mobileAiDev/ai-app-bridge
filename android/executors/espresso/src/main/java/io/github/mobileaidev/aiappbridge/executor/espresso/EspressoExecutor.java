package io.github.mobileaidev.aiappbridge.executor.espresso;

import android.graphics.Rect;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.widget.Checkable;
import android.widget.EditText;
import android.widget.TextView;
import androidx.test.espresso.Espresso;
import androidx.test.espresso.ViewAction;
import androidx.test.espresso.action.ViewActions;
import androidx.test.espresso.matcher.ViewMatchers;
import io.github.mobileaidev.aiappbridge.executor.ExecutorAdapter;
import io.github.mobileaidev.aiappbridge.executor.ExecutorFailure;
import org.hamcrest.Matchers;
import org.json.JSONArray;
import org.json.JSONObject;
import java.lang.ref.WeakReference;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

public final class EspressoExecutor implements ExecutorAdapter {
    private final Map<String, Node> nodes = new LinkedHashMap<>();
    private String snapshotId;

    @Override public JSONObject capabilities() throws Exception {
        return new JSONObject().put("engine", "espresso").put("compiledAgainst", "3.7.0").put("scope", "application-views")
            .put("actions", new JSONArray(new String[] {"click", "longClick", "typeText", "replaceText", "replaceTextViaInputConnection", "scrollTo", "swipeUp", "swipeDown", "swipeLeft", "swipeRight", "closeKeyboard", "back"}))
            .put("limitations", new JSONArray(new String[] {"selected Espresso root only", "Compose and WebView require their optional adapters", "business async needs registered idling resources or explicit observation"}));
    }

    @Override public JSONObject observe(JSONObject request) throws Exception {
        nodes.clear(); snapshotId = UUID.randomUUID().toString();
        JSONArray tree = new JSONArray();
        Exception[] failure = new Exception[1];
        Espresso.onView(ViewMatchers.isRoot()).check((root, error) -> {
            if (error != null) throw error;
            try { append(root, null, tree, 0); }
            catch (Exception caught) { failure[0] = caught; }
        });
        if (failure[0] != null) throw failure[0];
        return new JSONObject().put("snapshotId", snapshotId).put("nodes", tree).put("observedAtMs", System.currentTimeMillis());
    }

    private void append(View view, String parent, JSONArray tree, int depth) throws Exception {
        if (nodes.size() >= 2000 || depth > 80) throw new ExecutorFailure("executor_tree_limit", "View tree exceeds the observation limit");
        String id = String.valueOf(nodes.size());
        JSONObject value = describe(view);
        nodes.put(id, new Node(view, value.toString()));
        tree.put(value.put("nodeId", id).put("parentId", parent == null ? JSONObject.NULL : parent));
        if (view instanceof ViewGroup) for (int index = 0; index < ((ViewGroup) view).getChildCount(); index++) append(((ViewGroup) view).getChildAt(index), id, tree, depth + 1);
    }

    private JSONObject describe(View view) throws Exception {
        Rect bounds = new Rect();
        boolean visible = view.getGlobalVisibleRect(bounds);
        String resource = null;
        if (view.getId() != View.NO_ID) {
            try { resource = view.getResources().getResourceName(view.getId()); }
            catch (android.content.res.Resources.NotFoundException generated) { resource = null; }
        }
        JSONObject result = new JSONObject().put("className", view.getClass().getName()).put("resourceId", resource == null ? JSONObject.NULL : resource)
            .put("text", view instanceof TextView ? ((TextView) view).getText().toString() : JSONObject.NULL)
            .put("description", view.getContentDescription() == null ? JSONObject.NULL : view.getContentDescription().toString())
            .put("clickable", view.isClickable()).put("enabled", view.isEnabled()).put("visible", visible)
            .put("bounds", new JSONArray(new int[] {bounds.left, bounds.top, bounds.right, bounds.bottom}));
        if (view instanceof Checkable) result.put("checkable", true).put("checked", ((Checkable) view).isChecked());
        return result;
    }

    @Override public JSONObject act(JSONObject request) throws Exception {
        if (snapshotId == null || !snapshotId.equals(request.getString("snapshotId"))) throw new ExecutorFailure("reobserve_required", "Espresso observation changed");
        JSONObject action = request.getJSONObject("action");
        String type = action.getString("type");
        if (type.equals("back")) { Espresso.pressBack(); return new JSONObject().put("mechanism", "espresso-back"); }
        if (type.equals("closeKeyboard")) { Espresso.closeSoftKeyboard(); return new JSONObject().put("mechanism", "espresso-close-keyboard"); }
        Node node = nodes.get(action.getString("nodeId"));
        View view = node == null ? null : node.view.get();
        if (view == null) throw new ExecutorFailure("reobserve_required", "The observed View no longer exists");
        ExecutorFailure[] rejected = new ExecutorFailure[1];
        ViewAction operation;
        switch (type) {
            case "click": operation = ViewActions.click(); break;
            case "longClick": operation = ViewActions.longClick(); break;
            case "typeText": operation = ViewActions.typeText(action.getString("text")); break;
            case "replaceText": operation = ViewActions.replaceText(action.getString("text")); break;
            case "replaceTextViaInputConnection": operation = replaceViaInputConnection(action.getString("text"), rejected); break;
            case "scrollTo": operation = ViewActions.scrollTo(); break;
            case "swipeUp": operation = ViewActions.swipeUp(); break;
            case "swipeDown": operation = ViewActions.swipeDown(); break;
            case "swipeLeft": operation = ViewActions.swipeLeft(); break;
            case "swipeRight": operation = ViewActions.swipeRight(); break;
            default: throw new ExecutorFailure("executor_action_unsupported", "Unsupported Espresso action");
        }
        // Validation and dispatch share one UI callback; a recycled View cannot change in between.
        Espresso.onView(Matchers.sameInstance(view)).perform(new ViewAction() {
            @Override public org.hamcrest.Matcher<View> getConstraints() { return operation.getConstraints(); }
            @Override public String getDescription() { return "AI Bridge observed View: " + operation.getDescription(); }
            @Override public void perform(androidx.test.espresso.UiController controller, View current) {
                try {
                    if (!current.isAttachedToWindow() || current.getWindowToken() != node.windowToken || !node.fingerprint.equals(describe(current).toString())) {
                        rejected[0] = new ExecutorFailure("reobserve_required", "Observed View properties, bounds or window changed"); return;
                    }
                } catch (Exception error) { throw new IllegalStateException(error); }
                operation.perform(controller, current);
                if (rejected[0] == null && (type.equals("replaceText") || type.equals("replaceTextViaInputConnection"))
                    && (!(current instanceof TextView) || !action.optString("text").contentEquals(((TextView) current).getText())))
                    rejected[0] = new ExecutorFailure("executor_postcondition_failed", "The editor did not retain the requested text", true);
            }
        });
        if (rejected[0] != null) throw rejected[0];
        return new JSONObject().put("mechanism", type.equals("replaceText") ? "espresso-replaceText-setter"
            : type.equals("replaceTextViaInputConnection") ? "espresso-input-connection"
            : type.equals("typeText") ? "espresso-key-input" : "espresso-touch-action").put("type", type);
    }

    private ViewAction replaceViaInputConnection(String text, ExecutorFailure[] rejected) {
        return new ViewAction() {
            @Override public org.hamcrest.Matcher<View> getConstraints() {
                return Matchers.allOf(ViewMatchers.isDisplayed(), ViewMatchers.isEnabled(), ViewMatchers.isAssignableFrom(EditText.class));
            }
            @Override public String getDescription() { return "replace editor text through its InputConnection"; }
            @Override public void perform(androidx.test.espresso.UiController controller, View current) {
                EditText editor = (EditText) current;
                if (!editor.requestFocus()) { rejected[0] = new ExecutorFailure("executor_input_rejected", "The editor did not accept focus"); return; }
                InputConnection connection = editor.onCreateInputConnection(new EditorInfo());
                if (connection == null) { rejected[0] = new ExecutorFailure("executor_input_rejected", "The editor has no InputConnection", true); return; }
                connection.beginBatchEdit();
                try {
                    if (!connection.setSelection(0, editor.length()) || !connection.commitText(text, 1))
                        rejected[0] = new ExecutorFailure("executor_input_rejected", "The editor rejected selection or text commitment", true);
                } finally { connection.endBatchEdit(); }
                controller.loopMainThreadUntilIdle();
            }
        };
    }

    private static final class Node {
        final WeakReference<View> view;
        final android.os.IBinder windowToken;
        final String fingerprint;
        Node(View view, String fingerprint) { this.view = new WeakReference<>(view); this.windowToken = view.getWindowToken(); this.fingerprint = fingerprint; }
    }
}
