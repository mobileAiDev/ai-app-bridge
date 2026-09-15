package io.github.mobileaidev.aiappbridge.sample;

import androidx.compose.ui.test.junit4.ComposeTestRule;
import androidx.compose.ui.test.junit4.AndroidComposeTestRule_androidKt;
import io.github.mobileaidev.aiappbridge.executor.ExecutorAdapter;
import io.github.mobileaidev.aiappbridge.executor.compose.ComposeExecutor;
import io.github.mobileaidev.aiappbridge.executor.instrumentation.AndroidExecutorTest;
import java.util.Map;
import org.junit.Rule;

public final class ComposeBridgeSessionTest extends AndroidExecutorTest {
    @Rule public final ComposeTestRule compose = AndroidComposeTestRule_androidKt.createEmptyComposeRule();
    @Override protected Map<String, ExecutorAdapter> adapters() {
        Map<String, ExecutorAdapter> adapters = super.adapters();
        adapters.put("compose", new ComposeExecutor(compose));
        return adapters;
    }
}
