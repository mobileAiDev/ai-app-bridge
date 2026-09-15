package io.github.mobileaidev.aiappbridge.executor;

import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONObject;

/** Keeps native, accessibility and optional DOM/semantics adapters in the same test lifecycle. */
public final class ExecutorAdapters implements ExecutorAdapter {
    private final Map<String, ExecutorAdapter> adapters;
    private ExecutorAdapter observed;
    private String snapshotId;

    public ExecutorAdapters(Map<String, ExecutorAdapter> adapters) {
        if (adapters.isEmpty()) throw new IllegalArgumentException("At least one executor adapter is required");
        this.adapters = new LinkedHashMap<>(adapters);
    }
    @Override public JSONObject capabilities() throws Exception {
        JSONObject available = new JSONObject();
        for (Map.Entry<String, ExecutorAdapter> entry : adapters.entrySet()) available.put(entry.getKey(), entry.getValue().capabilities());
        return new JSONObject().put("engine", "android-instrumentation").put("bridgeVersion", "0.3.6").put("adapters", available);
    }
    @Override public JSONObject observe(JSONObject request) throws Exception {
        String engine = request.getString("engine");
        ExecutorAdapter adapter = adapters.get(engine);
        if (adapter == null) throw new ExecutorFailure("executor_adapter_unavailable", "This test APK does not contain adapter " + engine);
        observed = null; snapshotId = null;
        JSONObject observation = adapter.observe(request).put("engine", engine);
        observed = adapter;
        snapshotId = observation.getString("snapshotId");
        return observation;
    }
    @Override public JSONObject act(JSONObject request) throws Exception {
        if (observed == null || !request.getString("snapshotId").equals(snapshotId)) throw new ExecutorFailure("reobserve_required", "Observe the required adapter before acting");
        return observed.act(request);
    }
    @Override public void idle() throws Exception { for (ExecutorAdapter adapter : adapters.values()) adapter.idle(); }
    @Override public void close() throws Exception { for (ExecutorAdapter adapter : adapters.values()) adapter.close(); }
}
