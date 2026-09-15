package io.github.mobileaidev.aiappbridge.gradle;

import java.util.LinkedHashMap;
import java.util.Map;
import org.gradle.api.GradleException;
import org.gradle.api.Plugin;
import org.gradle.api.Project;
import org.gradle.api.artifacts.Configuration;
import org.gradle.api.artifacts.ModuleVersionIdentifier;

/** Read-only dependency checks for optional executors. Never changes a consumer's versions. */
public final class AiAppBridgeTestGradlePlugin implements Plugin<Project> {
    @Override public void apply(Project project) {
        project.getPluginManager().withPlugin("com.android.application", ignored ->
            project.getConfigurations().configureEach(configuration -> {
                String suffix = "AndroidTestRuntimeClasspath";
                if (!configuration.getName().endsWith(suffix)) return;
                String variant = configuration.getName().substring(0, configuration.getName().length() - suffix.length());
                configuration.getIncoming().afterResolve(dependencies -> {
                    Configuration application = project.getConfigurations().getByName(variant + "RuntimeClasspath");
                    verify(versions(application), versions(configuration));
                });
            })
        );
    }

    private static Map<String, String> versions(Configuration configuration) {
        Map<String, String> versions = new LinkedHashMap<>();
        configuration.getIncoming().getResolutionResult().getAllComponents().forEach(component -> {
            ModuleVersionIdentifier module = component.getModuleVersion();
            if (module != null) versions.put(module.getGroup() + ":" + module.getName(), module.getVersion());
        });
        return versions;
    }

    static void verify(Map<String, String> application, Map<String, String> test) {
        boolean compose = test.keySet().stream().anyMatch(key -> key.endsWith(":ai-app-bridge-test-compose"));
        if (compose) {
            String testVersion = test.get("androidx.compose.ui:ui-test-android");
            String runtimeVersion = application.get("androidx.compose.ui:ui-android");
            if (testVersion == null || runtimeVersion == null || !testVersion.equals(runtimeVersion))
                throw new GradleException("[AiAppBridge] Compose test/runtime mismatch: ui-test-android=" + testVersion
                    + ", application ui-android=" + runtimeVersion + ". Use the application's Compose BOM for androidTest as well. No dependency was upgraded.");
            if (!"1.8.3".equals(testVersion))
                throw new GradleException("[AiAppBridge] This Compose adapter supports profile 1.8.3; resolved " + testVersion
                    + ". Select an adapter profile matching the application; automatic application upgrades are disabled.");
            for (Map.Entry<String, String> module : application.entrySet()) {
                if (module.getKey().startsWith("androidx.compose.") && test.containsKey(module.getKey())
                    && !module.getValue().equals(test.get(module.getKey())))
                    throw new GradleException("[AiAppBridge] Main/test Compose mismatch for " + module.getKey());
            }
        }
        boolean executor = test.keySet().stream().anyMatch(key -> key.contains(":ai-app-bridge-test-"));
        if (executor) {
            requireProfile(test, "androidx.test:runner", "1.7.0");
            requireProfile(test, "androidx.test.espresso:espresso-core", "3.7.0");
            requireProfile(test, "androidx.test.espresso:espresso-web", "3.7.0");
            requireProfile(test, "androidx.test.uiautomator:uiautomator", "2.4.0");
        }
    }

    private static void requireProfile(Map<String, String> modules, String name, String supported) {
        String resolved = modules.get(name);
        if (resolved != null && !supported.equals(resolved))
            throw new GradleException("[AiAppBridge] Unsupported executor dependency profile: " + name + "=" + resolved
                + "; this adapter was validated with " + supported + ". No dependency was rewritten.");
    }
}
