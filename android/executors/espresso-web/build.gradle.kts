plugins { id("com.android.library") }
android {
    namespace = "io.github.mobileaidev.aiappbridge.executor.web"
    compileSdk = 35
    defaultConfig { minSdk = 23 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}
dependencies {
    api(project(":ai-app-bridge-test-core"))
    implementation("androidx.test.espresso:espresso-web:3.7.0")
}

apply(from = "../publishing.gradle")
