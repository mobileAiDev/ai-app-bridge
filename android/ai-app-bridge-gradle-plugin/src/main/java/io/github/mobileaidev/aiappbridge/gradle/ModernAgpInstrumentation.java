package io.github.mobileaidev.aiappbridge.gradle;

import com.android.build.api.instrumentation.FramesComputationMode;
import com.android.build.api.instrumentation.InstrumentationScope;
import com.android.build.api.variant.AndroidComponentsExtension;
import com.android.build.api.variant.Variant;
import kotlin.Unit;
import org.gradle.api.Action;
import org.gradle.api.Project;
import org.gradle.api.logging.Logger;

public final class ModernAgpInstrumentation {
    @SuppressWarnings({"rawtypes", "unchecked"})
    public void configure(Project project, AiAppBridgeExtension extension) {
        Logger logger = project.getLogger();
        AndroidComponentsExtension androidComponents = project.getExtensions()
                .getByType(AndroidComponentsExtension.class);

        androidComponents.onVariants(
                androidComponents.selector().all(),
                (Action<Variant>) variant -> {
                    if (!"debug".equalsIgnoreCase(variant.getBuildType())) {
                        return;
                    }
                    if (!extension.isEnabled()) {
                        logger.lifecycle("[AiAppBridge] Android Gradle plugin disabled for {}.", variant.getName());
                        return;
                    }

                    PluginConfiguration.applyRuntimeDependency(project, extension, variant.getName());

                    if (extension.isOkHttpCaptureEnabled()) {
                        variant.transformClassesWith(
                                OkHttpAutoCaptureClassVisitorFactory.class,
                                InstrumentationScope.ALL,
                                parameters -> Unit.INSTANCE
                        );
                        variant.setAsmFramesComputationMode(FramesComputationMode.COMPUTE_FRAMES_FOR_INSTRUMENTED_METHODS);
                    }

                    PluginConfiguration.logConfigured(logger, extension, variant.getName(), "modern");
                }
        );
    }
}
