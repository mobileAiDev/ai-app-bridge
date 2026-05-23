plugins {
    `java-gradle-plugin`
    `maven-publish`
}

val jitpackGroup = providers.environmentVariable("GROUP").orNull
val jitpackArtifact = providers.environmentVariable("ARTIFACT").orNull
val jitpackVersion = providers.environmentVariable("VERSION").orNull

group = if (
    providers.environmentVariable("JITPACK").orNull == "true" &&
    !jitpackGroup.isNullOrBlank() &&
    !jitpackArtifact.isNullOrBlank()
) {
    "$jitpackGroup.$jitpackArtifact"
} else {
    "io.github.mobileaidev.aiappbridge"
}
version = jitpackVersion ?: "0.2.7"

java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
}

dependencies {
    compileOnly("com.android.tools.build:gradle-api:7.4.2")
    implementation("org.ow2.asm:asm:9.7")
}

gradlePlugin {
    plugins {
        create("aiAppBridgeAndroid") {
            id = "io.github.mobileaidev.aiappbridge.android"
            implementationClass = "io.github.mobileaidev.aiappbridge.gradle.AiAppBridgeGradlePlugin"
            displayName = "AI App Bridge Android Plugin"
            description = "Debug-only automatic capture instrumentation for AI App Bridge."
        }
    }
}

