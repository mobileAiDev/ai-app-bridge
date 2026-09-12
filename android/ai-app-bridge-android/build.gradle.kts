plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("maven-publish")
}

group = "io.github.mobileaidev.aiappbridge"
version = "0.3.0-rc.3"

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
        minSdk = 19
        // For the library's instrumentation APK; consumers choose their own target SDK.
        targetSdk = 35
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_1_8.toString()
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test:runner:1.5.2")
    androidTestImplementation("junit:junit:4.13.2")
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
