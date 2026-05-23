plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("maven-publish")
}

group = "io.github.mobileaidev.aiappbridge"
version = "0.2.7"

val jitpackGroup = providers.environmentVariable("GROUP").orNull
val jitpackArtifact = providers.environmentVariable("ARTIFACT").orNull
val jitpackVersion = providers.environmentVariable("VERSION").orNull
val publishGroupId = if (
    providers.environmentVariable("JITPACK").orNull == "true" &&
    !jitpackGroup.isNullOrBlank() &&
    !jitpackArtifact.isNullOrBlank()
) {
    "$jitpackGroup.$jitpackArtifact"
} else {
    project.group.toString()
}
val publishVersion = jitpackVersion ?: project.version.toString()

android {
    namespace = "io.github.mobileaidev.aiappbridge.android"
    compileSdk = 35

    defaultConfig {
        minSdk = 21
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_1_8.toString()
    }
}

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                groupId = publishGroupId
                artifactId = "ai-app-bridge-android"
                version = publishVersion
            }
        }
    }
}

