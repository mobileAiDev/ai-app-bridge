plugins { id("com.android.library") }
android {
    namespace = "io.github.mobileaidev.aiappbridge.executor.compose"
    compileSdk = 35
    defaultConfig { minSdk = 23 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}
dependencies {
    api(project(":ai-app-bridge-test-core"))
    // The consuming androidTest supplies its matching Compose runtime and BOM.
    compileOnly("androidx.compose.ui:ui-test-junit4-android:1.8.3")
}

apply(from = "../publishing.gradle")
