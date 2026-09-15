package io.github.mobileaidev.aiappbridge.executor.compose;

import androidx.compose.ui.geometry.Rect;
import androidx.compose.ui.node.RootForTest;
import androidx.compose.ui.semantics.SemanticsActions;
import androidx.compose.ui.semantics.SemanticsConfiguration;
import androidx.compose.ui.semantics.SemanticsConfigurationKt;
import androidx.compose.ui.semantics.SemanticsNode;
import androidx.compose.ui.semantics.SemanticsProperties;
import androidx.compose.ui.test.ActionsKt;
import androidx.compose.ui.test.SemanticsMatcher;
import androidx.compose.ui.test.SemanticsNodeInteraction;
import androidx.compose.ui.test.TextActionsKt;
import androidx.compose.ui.test.TouchInjectionScopeKt;
import androidx.compose.ui.test.junit4.ComposeTestRule;
import androidx.compose.ui.text.AnnotatedString;
import io.github.mobileaidev.aiappbridge.executor.ExecutorAdapter;
import io.github.mobileaidev.aiappbridge.executor.ExecutorFailure;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import kotlin.Unit;
import org.json.JSONArray;
import org.json.JSONObject;

/** The caller's JUnit rule must surround the entire session and precede Activity creation. */
public final class ComposeExecutor implements ExecutorAdapter {
    private final ComposeTestRule rule;
    private final boolean originalAutoAdvance;
    private final Map<String, Node> nodes = new LinkedHashMap<>();
    private boolean unmerged;
    private String snapshotId;

    public ComposeExecutor(ComposeTestRule rule) {
        this.rule = rule;
        originalAutoAdvance = rule.getMainClock().getAutoAdvance();
        rule.getMainClock().setAutoAdvance(true);
    }
    @Override public JSONObject capabilities() throws Exception {
        return new JSONObject().put("engine", "compose").put("compiledAgainst", "1.8.3").put("scope", "compose-semantics")
            .put("clockPolicy", "automatic-test-clock-with-idle-frame-ticks")
            .put("actions", new JSONArray(new String[] {"click", "semanticLongClick", "composeInput", "composeReplaceText", "composeClearText", "scrollTo", "composeScrollToIndex", "swipeUp", "swipeDown", "swipeLeft", "swipeRight"}))
            .put("limitations", new JSONArray(new String[] {"the consuming test must supply a matching Compose runtime", "test clock timing differs from wall time", "text and semanticLongClick invoke semantics actions", "external native and WebView content require their own adapter"}));
    }
    @Override public JSONObject observe(JSONObject request) throws Exception {
        snapshotId = null; nodes.clear(); unmerged = request.optBoolean("composeUnmergedTree", false);
        List<SemanticsNode> observed = rule.onAllNodes(new SemanticsMatcher("all Compose nodes", node -> true), unmerged)
            .fetchSemanticsNodes(false, "Compose tree is unavailable");
        if (observed.size() > 2000) throw new ExecutorFailure("executor_tree_limit", "Compose tree exceeds 2000 nodes");
        JSONArray tree = rule.runOnUiThread(() -> {
            JSONArray result = new JSONArray();
            try {
                for (SemanticsNode node : observed) {
                    if (node.getRoot() == null) throw new IllegalStateException("Detached Compose root");
                    String id = String.valueOf(nodes.size());
                    JSONObject description = describe(node);
                    nodes.put(id, new Node(node, description.toString()));
                    result.put(description.put("nodeId", id));
                }
            } catch (Exception error) { throw new IllegalStateException(error); }
            return result;
        });
        snapshotId = UUID.randomUUID().toString();
        return new JSONObject().put("snapshotId", snapshotId).put("nodes", tree).put("unmergedTree", unmerged).put("testClockMs", rule.getMainClock().getCurrentTime());
    }
    private JSONObject describe(SemanticsNode node) throws Exception {
        SemanticsConfiguration config = node.getConfig();
        SemanticsProperties properties = SemanticsProperties.INSTANCE;
        List<AnnotatedString> text = SemanticsConfigurationKt.getOrNull(config, properties.getText());
        AnnotatedString editable = SemanticsConfigurationKt.getOrNull(config, properties.getEditableText());
        List<String> descriptions = SemanticsConfigurationKt.getOrNull(config, properties.getContentDescription());
        boolean password = config.contains(properties.getPassword());
        JSONArray texts = new JSONArray();
        if (!password && text != null) for (AnnotatedString value : text) texts.put(value.getText());
        Rect bounds = node.getBoundsInWindow();
        if (!bounds.isFinite()) throw new IllegalStateException("Compose bounds are not finite");
        String tag = SemanticsConfigurationKt.getOrNull(config, properties.getTestTag());
        return new JSONObject().put("semanticsId", node.getId()).put("tag", tag == null ? JSONObject.NULL : tag)
            .put("text", texts).put("editableText", password || editable == null ? JSONObject.NULL : editable.getText())
            .put("description", descriptions == null ? new JSONArray() : new JSONArray(descriptions))
            .put("enabled", !config.contains(properties.getDisabled()))
            .put("bounds", new JSONArray(new float[] {bounds.getLeft(), bounds.getTop(), bounds.getRight(), bounds.getBottom()}));
    }
    @Override public JSONObject act(JSONObject request) throws Exception {
        if (snapshotId == null || !snapshotId.equals(request.getString("snapshotId"))) throw new ExecutorFailure("reobserve_required", "The Compose observation changed");
        JSONObject action = request.getJSONObject("action");
        Node node = nodes.get(action.getString("nodeId"));
        if (node == null) throw new ExecutorFailure("reobserve_required", "Unknown observed Compose node");
        SemanticsMatcher identity = new SemanticsMatcher("observed Compose root and node", current -> current.getId() == node.id && current.getRoot() == node.root);
        SemanticsMatcher fingerprint = new SemanticsMatcher("observed Compose properties", current -> {
            try { return node.fingerprint.equals(describe(current).toString()); }
            catch (Exception error) { throw new IllegalStateException(error); }
        });
        SemanticsNodeInteraction target = rule.onNode(identity.and(fingerprint), unmerged);
        try { target.fetchSemanticsNode("The observed Compose node changed"); }
        catch (AssertionError stale) { throw new ExecutorFailure("reobserve_required", "The observed Compose node is absent or changed"); }
        String type = action.getString("type"), mechanism;
        switch (type) {
            case "click": ActionsKt.performClick(target); mechanism = "compose-touch-input"; break;
            case "semanticLongClick":
                ActionsKt.performSemanticsAction(target, SemanticsActions.INSTANCE.getOnLongClick(), operation -> {
                    if (!Boolean.TRUE.equals(operation.invoke())) throw new AssertionError("Compose long-click semantics rejected");
                    return Unit.INSTANCE;
                });
                mechanism = "compose-long-click-semantics"; break;
            case "composeInput": TextActionsKt.performTextInput(target, action.getString("text")); mechanism = "compose-insert-text-semantics"; break;
            case "composeReplaceText": TextActionsKt.performTextReplacement(target, action.getString("text")); mechanism = "compose-set-text-semantics"; break;
            case "composeClearText": TextActionsKt.performTextClearance(target); mechanism = "compose-set-text-semantics"; break;
            case "scrollTo": ActionsKt.performScrollTo(target); mechanism = "compose-scroll-semantics"; break;
            case "composeScrollToIndex": ActionsKt.performScrollToIndex(target, action.getInt("index")); mechanism = "compose-scroll-semantics"; break;
            case "swipeUp": case "swipeDown": case "swipeLeft": case "swipeRight":
                ActionsKt.performTouchInput(target, scope -> {
                    switch (type) {
                        case "swipeUp": TouchInjectionScopeKt.swipeUp(scope, scope.getBottom() * .9f, scope.getBottom() * .1f, 300L); break;
                        case "swipeDown": TouchInjectionScopeKt.swipeDown(scope, scope.getBottom() * .1f, scope.getBottom() * .9f, 300L); break;
                        case "swipeLeft": TouchInjectionScopeKt.swipeLeft(scope, scope.getRight() * .9f, scope.getRight() * .1f, 300L); break;
                        case "swipeRight": TouchInjectionScopeKt.swipeRight(scope, scope.getRight() * .1f, scope.getRight() * .9f, 300L); break;
                    }
                    return Unit.INSTANCE;
                });
                mechanism = "compose-touch-input"; break;
            default: throw new ExecutorFailure("executor_action_unsupported", "Unsupported Compose action");
        }
        return new JSONObject().put("type", type).put("mechanism", mechanism);
    }
    @Override public void idle() { rule.getMainClock().advanceTimeByFrame(); }
    @Override public void close() { rule.getMainClock().setAutoAdvance(originalAutoAdvance); }
    private static final class Node {
        final int id;
        final RootForTest root;
        final String fingerprint;
        Node(SemanticsNode node, String fingerprint) { id = node.getId(); root = node.getRoot(); this.fingerprint = fingerprint; }
    }
}
