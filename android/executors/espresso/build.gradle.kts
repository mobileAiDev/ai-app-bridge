plugins { id("com.android.library") }
android {
    namespace = "io.github.mobileaidev.aiappbridge.executor.espresso"
    compileSdk = 35
    defaultConfig { minSdk = 23 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}
dependencies {
    api(project(":ai-app-bridge-test-core"))
    implementation("androidx.test.espresso:espresso-core:3.7.0")
    implementation("androidx.test:runner:1.7.0")
    implementation("junit:junit:4.13.2")
}

apply(from = "../publishing.gradle")
