plugins { id("com.android.library") }
android {
    namespace = "io.github.mobileaidev.aiappbridge.executor"
    compileSdk = 35
    defaultConfig { minSdk = 23 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

apply(from = "../publishing.gradle")
