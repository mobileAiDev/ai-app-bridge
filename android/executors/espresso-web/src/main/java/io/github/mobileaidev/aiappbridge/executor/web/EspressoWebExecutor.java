package io.github.mobileaidev.aiappbridge.executor.web;

import android.os.IBinder;
import android.view.View;
import android.webkit.WebView;
import androidx.test.espresso.Espresso;
import androidx.test.espresso.Root;
import androidx.test.espresso.ViewAction;
import androidx.test.espresso.UiController;
import androidx.test.espresso.matcher.ViewMatchers;
import androidx.test.espresso.web.action.AtomAction;
import androidx.test.espresso.web.model.Atom;
import androidx.test.espresso.web.model.Atoms;
import androidx.test.espresso.web.model.ElementReference;
import androidx.test.espresso.web.model.WindowReference;
import androidx.test.espresso.web.webdriver.DriverAtoms;
import androidx.test.espresso.web.webdriver.Locator;
import io.github.mobileaidev.aiappbridge.executor.ExecutorAdapter;
import io.github.mobileaidev.aiappbridge.executor.ExecutorFailure;
import io.github.mobileaidev.aiappbridge.executor.ExecutorUnsettled;
import java.lang.ref.WeakReference;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.hamcrest.Description;
import org.hamcrest.Matcher;
import org.hamcrest.Matchers;
import org.hamcrest.TypeSafeMatcher;
import org.json.JSONArray;
import org.json.JSONObject;

/** Optional WebDriver atoms in the observed native WebView and DOM frame. */
public final class EspressoWebExecutor implements ExecutorAdapter {
    private WeakReference<WebView> webView = new WeakReference<>(null);
    private IBinder windowToken;
    private WindowReference frame;
    private String snapshotId;
    private final Map<String, ElementReference> nodes = new LinkedHashMap<>();
    private final Map<String, String> fingerprints = new LinkedHashMap<>();
    private static final String DESCRIBE = "function(es){return JSON.stringify(es.map(function(e){"
        + "var r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,id:e.id,"
        + "role:e.getAttribute('role'),label:e.getAttribute('aria-label'),type:e.getAttribute('type'),"
        + "text:(e.innerText||'').slice(0,4096),value:e.type==='password'?null:('value'in e?String(e.value).slice(0,4096):null),"
        + "enabled:!e.disabled,visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden',"
        + "bounds:[r.left,r.top,r.right,r.bottom]};}));}";

    @Override public JSONObject capabilities() throws Exception {
        return new JSONObject().put("engine", "espresso-web").put("compiledAgainst", "3.7.0").put("scope", "selected-webview-frame")
            .put("actions", new JSONArray(new String[] {"webClick", "webKeys", "webClear", "webScrollIntoView"}))
            .put("mechanism", "webdriver-javascript-atoms")
            .put("limitations", new JSONArray(new String[] {"JavaScript and hardware acceleration must already be enabled", "DOM events do not prove native hit testing or IME input", "cross-origin iframe access is subject to WebView security", "closed Shadow DOM is not observable", "a JavaScript timeout ends the test session; it does not cancel or replay the atom"}));
    }

    @Override public JSONObject observe(JSONObject request) throws Exception {
        nodes.clear(); fingerprints.clear(); snapshotId = null; frame = null;
        Matcher<View> matcher = ViewMatchers.isAssignableFrom(WebView.class);
        if (request.has("webView")) {
            JSONObject selector = request.getJSONObject("webView");
            matcher = Matchers.allOf(matcher, selector.getString("by").equals("resourceId")
                ? ViewMatchers.withResourceName(selector.getString("value")) : ViewMatchers.withContentDescription(selector.getString("value")));
        }
        Espresso.onView(matcher).check((view, error) -> {
            if (error != null) throw error;
            webView = new WeakReference<>((WebView) view); windowToken = view.getWindowToken();
        });
        JSONArray path = request.optJSONArray("framePath");
        if (path != null) for (int index = 0; index < path.length(); index++) {
            JSONObject entry = path.getJSONObject(index);
            Atom<WindowReference> selection;
            if (entry.has("index")) selection = frame == null
                ? DriverAtoms.selectFrameByIndex(entry.getInt("index"))
                : DriverAtoms.selectFrameByIndex(entry.getInt("index"), frame);
            else selection = frame == null
                ? DriverAtoms.selectFrameByIdOrName(entry.getString("name"))
                : DriverAtoms.selectFrameByIdOrName(entry.getString("name"), frame);
            frame = run(selection, null);
        }
        List<ElementReference> elements = run(DriverAtoms.findMultipleElements(Locator.CSS_SELECTOR, "*"), null);
        if (elements.size() > 2000) throw new ExecutorFailure("executor_tree_limit", "The selected DOM frame exceeds 2000 elements");
        JSONArray descriptions = new JSONArray(run(dto(elements), null));
        JSONArray tree = new JSONArray();
        for (int index = 0; index < elements.size(); index++) {
            String id = String.valueOf(index);
            JSONObject node = descriptions.getJSONObject(index);
            nodes.put(id, elements.get(index)); fingerprints.put(id, node.toString());
            tree.put(node.put("nodeId", id));
        }
        String document = run(Atoms.script("function(){return JSON.stringify({url:location.href,title:document.title});}", Atoms.castOrDie(String.class)), null);
        snapshotId = UUID.randomUUID().toString();
        return new JSONObject().put("snapshotId", snapshotId).put("nodes", tree).put("document", new JSONObject(document))
            .put("framePath", path == null ? new JSONArray() : path).put("observedAtMs", System.currentTimeMillis());
    }

    @Override public JSONObject act(JSONObject request) throws Exception {
        if (snapshotId == null || !snapshotId.equals(request.getString("snapshotId"))) throw new ExecutorFailure("reobserve_required", "The WebView observation changed");
        JSONObject action = request.getJSONObject("action");
        String id = action.getString("nodeId");
        ElementReference element = nodes.get(id);
        if (element == null) throw new ExecutorFailure("reobserve_required", "Unknown observed DOM element");
        JSONObject current;
        try { current = new JSONArray(run(dto(Collections.singletonList(element)), null)).getJSONObject(0); }
        catch (java.util.concurrent.ExecutionException stale) { throw new ExecutorFailure("reobserve_required", "The observed DOM reference is no longer available"); }
        if (!fingerprints.get(id).equals(current.toString())) throw new ExecutorFailure("reobserve_required", "The observed DOM element changed");
        String type = action.getString("type");
        switch (type) {
            case "webClick": run(DriverAtoms.webClick(), element); break;
            case "webClear": run(DriverAtoms.clearElement(), element); break;
            case "webKeys": run(DriverAtoms.webKeys(action.getString("text")), element); break;
            case "webScrollIntoView": run(DriverAtoms.webScrollIntoView(), element); break;
            default: throw new ExecutorFailure("executor_action_unsupported", "Unsupported Espresso-Web action");
        }
        return new JSONObject().put("type", type).put("mechanism", "webdriver-javascript-atoms");
    }

    private Atom<String> dto(List<ElementReference> elements) {
        return Atoms.transform(Atoms.scriptWithArgs(DESCRIBE, Collections.<Object>singletonList(elements)), Atoms.castOrDie(String.class));
    }

    private <T> T run(Atom<T> atom, ElementReference element) throws Exception {
        WebView selected = webView.get();
        if (selected == null) throw new ExecutorFailure("reobserve_required", "The observed WebView no longer exists");
        AtomAction<T> action = new AtomAction<>(atom, frame, element);
        Matcher<Root> root = new TypeSafeMatcher<Root>() {
            @Override public void describeTo(Description description) { description.appendText("the observed WebView window"); }
            @Override protected boolean matchesSafely(Root candidate) { return candidate.getDecorView().getWindowToken() == windowToken; }
        };
        ExecutorFailure[] rejected = new ExecutorFailure[1];
        Espresso.onView(Matchers.sameInstance(selected)).inRoot(root).perform(new ViewAction() {
            @Override public Matcher<View> getConstraints() { return action.getConstraints(); }
            @Override public String getDescription() { return "AI Bridge WebView atom"; }
            @Override public void perform(UiController controller, View view) {
                if (!view.isAttachedToWindow() || view.getWindowToken() != windowToken) {
                    rejected[0] = new ExecutorFailure("reobserve_required", "The WebView window changed"); return;
                }
                action.perform(controller, view);
            }
        });
        if (rejected[0] != null) throw rejected[0];
        try { return action.get(10, TimeUnit.SECONDS); }
        catch (TimeoutException | InterruptedException error) {
            throw new ExecutorUnsettled("The WebView atom has no completion; ending this test session", error);
        }
    }
}
