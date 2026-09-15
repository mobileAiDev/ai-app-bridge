package io.github.mobileaidev.aiappbridge.executor.instrumentation;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import androidx.test.platform.app.InstrumentationRegistry;
import io.github.mobileaidev.aiappbridge.executor.ExecutorAdapter;
import io.github.mobileaidev.aiappbridge.executor.ExecutorAdapters;
import io.github.mobileaidev.aiappbridge.executor.ExecutorSession;
import io.github.mobileaidev.aiappbridge.executor.espresso.EspressoExecutor;
import io.github.mobileaidev.aiappbridge.executor.uia.UiaExecutor;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.Test;

public class AndroidExecutorTest {
    protected Map<String, ExecutorAdapter> adapters() {
        Map<String, ExecutorAdapter> adapters = new LinkedHashMap<>();
        adapters.put("uiautomator", new UiaExecutor());
        adapters.put("espresso", new EspressoExecutor());
        return adapters;
    }
    @Test public void bridgeSession() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Bundle arguments = InstrumentationRegistry.getArguments();
        String activity = arguments.getString("bridgeActivity");
        if (activity == null || activity.isEmpty()) throw new IllegalArgumentException("bridgeActivity is required");
        instrumentation.startActivitySync(new Intent().setClassName(instrumentation.getTargetContext().getPackageName(), activity).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ExecutorSession.run(instrumentation, arguments, new ExecutorAdapters(adapters()));
    }
}
