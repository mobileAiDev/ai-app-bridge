package io.github.mobileaidev.aiappbridge.sample;

public final class BridgeSessionTest extends io.github.mobileaidev.aiappbridge.executor.instrumentation.AndroidExecutorTest {
    @Override protected java.util.Map<String, io.github.mobileaidev.aiappbridge.executor.ExecutorAdapter> adapters() {
        java.util.Map<String, io.github.mobileaidev.aiappbridge.executor.ExecutorAdapter> adapters = super.adapters();
        adapters.put("espresso-web", new io.github.mobileaidev.aiappbridge.executor.web.EspressoWebExecutor());
        return adapters;
    }
}
