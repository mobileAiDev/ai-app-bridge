package io.github.mobileaidev.aiappbridge.gradle;

import java.util.LinkedHashMap;
import java.util.Map;
import org.gradle.api.GradleException;
import org.junit.Test;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

public final class AiAppBridgeTestGradlePluginTest {
    @Test public void rejectsTheObservedMainAndTestComposeBinaryMismatch() {
        Map<String, String> application = new LinkedHashMap<>();
        application.put("androidx.compose.ui:ui-android", "1.7.4");
        Map<String, String> test = new LinkedHashMap<>();
        test.put("io.github.mobileaidev.aiappbridge:ai-app-bridge-test-compose", "0.3.6");
        test.put("androidx.compose.ui:ui-test-android", "1.8.3");
        GradleException error = assertThrows(GradleException.class, () -> AiAppBridgeTestGradlePlugin.verify(application, test));
        assertTrue(error.getMessage().contains("ui-android=1.7.4"));
        application.put("androidx.compose.ui:ui-android", "1.8.3");
        AiAppBridgeTestGradlePlugin.verify(application, test);
    }
    @Test public void ignoresProjectsThatDidNotOptIntoTheExecutor() {
        Map<String, String> application = new LinkedHashMap<>();
        application.put("androidx.compose.ui:ui-android", "1.7.4");
        Map<String, String> test = new LinkedHashMap<>();
        test.put("androidx.compose.ui:ui-test-android", "1.8.3");
        AiAppBridgeTestGradlePlugin.verify(application, test);
    }
}
