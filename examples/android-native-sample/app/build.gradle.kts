plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("io.github.mobileaidev.aiappbridge.android")
    id("io.github.mobileaidev.aiappbridge.test")
}

android {
    namespace = "io.github.mobileaidev.aiappbridge.sample"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.mobileaidev.aiappbridge.sample"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_11.toString()
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.06.01")
    debugImplementation(composeBom)
    androidTestImplementation(composeBom)
    implementation(project(":ai-app-bridge-android"))
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    androidTestImplementation(project(":ai-app-bridge-test-instrumentation"))
    androidTestImplementation(project(":ai-app-bridge-test-espresso-web"))
    androidTestImplementation(project(":ai-app-bridge-test-compose"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.activity:activity-compose:1.10.1")
    debugImplementation("androidx.compose.material:material")
}
