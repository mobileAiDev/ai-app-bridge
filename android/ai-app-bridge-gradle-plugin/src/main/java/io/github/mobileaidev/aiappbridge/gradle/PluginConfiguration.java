package io.github.mobileaidev.aiappbridge.gradle;

import org.gradle.api.Project;
import org.gradle.api.logging.Logger;

final class PluginConfiguration {
    private PluginConfiguration() {
    }

    static void applyRuntimeDependency(Project project, AiAppBridgeExtension extension, String variantName) {
        String runtimeDependencyNotation = extension.getRuntimeDependencyNotation().trim();
        if (!runtimeDependencyNotation.isEmpty()) {
            project.getDependencies().add(variantName + "Implementation", runtimeDependencyNotation);
        }
    }

    static void logConfigured(Logger logger, AiAppBridgeExtension extension, String variantName, String backend) {
        if (!extension.getUnusedOptions().isEmpty()) {
            logger.warn("[AiAppBridge] These deprecated options have no effect: {}. Remove them from aiAppBridge configuration.",
                    extension.getUnusedOptions());
        }
        logger.lifecycle(
                "[AiAppBridge] Android Gradle plugin configured for {} using {} backend. "
                        + "okHttpCaptureEnabled="
                        + extension.isOkHttpCaptureEnabled()
                        + ".",
                variantName,
                backend
        );
    }
}
