package io.github.mobileaidev.aiappbridge.gradle;

import org.gradle.api.Plugin;
import org.gradle.api.Project;
import org.gradle.api.logging.Logger;

public final class AiAppBridgeGradlePlugin implements Plugin<Project> {
    @Override
    public void apply(Project project) {
        AiAppBridgeExtension extension = project.getExtensions()
                .create("aiAppBridge", AiAppBridgeExtension.class);

        project.getPlugins().withId("com.android.application", ignored -> {
            configureAndroidApp(project, extension);
        });
    }

    private void configureAndroidApp(Project project, AiAppBridgeExtension extension) {
        Logger logger = project.getLogger();
        if (project.getExtensions().findByName("androidComponents") != null && classAvailable("com.android.build.api.variant.AndroidComponentsExtension")) {
            invokeBackend("io.github.mobileaidev.aiappbridge.gradle.ModernAgpInstrumentation", project, extension);
            return;
        }

        if (project.getExtensions().findByName("android") != null
                && classAvailable("com.android.build.gradle.AppExtension")
                && classAvailable("com.android.build.api.transform.Transform")) {
            invokeBackend("io.github.mobileaidev.aiappbridge.gradle.LegacyAgpTransformInstrumentation", project, extension);
            return;
        }

        logger.warn("[AiAppBridge] Android Gradle plugin APIs are not supported by this AGP version; use runtime-only integration.");
    }

    private boolean classAvailable(String className) {
        try {
            Class.forName(className, false, getClass().getClassLoader());
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private void invokeBackend(String className, Project project, AiAppBridgeExtension extension) {
        try {
            Object backend = Class.forName(className, true, getClass().getClassLoader())
                    .getDeclaredConstructor()
                    .newInstance();
            backend.getClass()
                    .getMethod("configure", Project.class, AiAppBridgeExtension.class)
                    .invoke(backend, project, extension);
        } catch (Throwable error) {
            throw new IllegalStateException("[AiAppBridge] Failed to configure Android Gradle plugin backend " + className, error);
        }
    }
}

