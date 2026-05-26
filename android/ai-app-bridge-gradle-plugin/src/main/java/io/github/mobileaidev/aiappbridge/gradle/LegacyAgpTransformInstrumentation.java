package io.github.mobileaidev.aiappbridge.gradle;

import com.android.build.gradle.AppExtension;
import org.gradle.api.Project;
import org.gradle.api.logging.Logger;

public final class LegacyAgpTransformInstrumentation {
    public void configure(Project project, AiAppBridgeExtension extension) {
        Logger logger = project.getLogger();
        if (!extension.isEnabled()) {
            logger.lifecycle("[AiAppBridge] Android Gradle plugin disabled.");
            return;
        }

        AppExtension android = project.getExtensions().getByType(AppExtension.class);
        android.getApplicationVariants().all(variant -> {
            if (!"debug".equalsIgnoreCase(variant.getBuildType().getName())) {
                return;
            }
            PluginConfiguration.applyRuntimeDependency(project, extension, variant.getName());
            PluginConfiguration.logConfigured(logger, extension, variant.getName(), "legacy-transform");
        });

        if (extension.isOkHttpCaptureEnabled()) {
            android.registerTransform(new OkHttpAutoCaptureTransform());
        }
    }
}
