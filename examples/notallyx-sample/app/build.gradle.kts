plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.parcelize")
    id("com.google.devtools.ksp")
    id("org.jetbrains.kotlin.plugin.serialization") version "1.9.0"
}

android {
    namespace = "com.philkes.notallyx"
    compileSdk = 36
    defaultConfig {
        applicationId = "io.github.mobileaidev.notallyx.sample"
        minSdk = 23
        targetSdk = 36
        versionCode = 71120
        versionName = "7.11.2-aab-baseline"
        vectorDrawables.generatedDensities?.clear()
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    ksp {
        arg("room.generateKotlin", "true")
        arg("room.schemaLocation", "$projectDir/schemas")
    }
    buildTypes {
        debug { resValue("string", "app_name", "NotallyX AAB Sample") }
        release { isMinifyEnabled = true; isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    kotlinOptions { jvmTarget = "1.8" }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures { viewBinding = true; dataBinding = true; buildConfig = true }
    testOptions { unitTests.isIncludeAndroidResources = true }
}

dependencies {
    debugImplementation(project(":ai-app-bridge-android"))
    val navVersion = "2.3.5"
    val roomVersion = "2.6.1"

    implementation("androidx.navigation:navigation-fragment-ktx:$navVersion")
    implementation("androidx.navigation:navigation-ui-ktx:$navVersion")
    implementation("androidx.preference:preference-ktx:1.2.1")
    implementation("androidx.lifecycle:lifecycle-livedata-ktx:2.8.7")
    ksp("androidx.room:room-compiler:$roomVersion")
    implementation("androidx.room:room-ktx:$roomVersion")
    implementation("androidx.room:room-runtime:$roomVersion")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.sqlite:sqlite-ktx:2.4.0")
    implementation("androidx.work:work-runtime:2.9.1")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("cat.ereza:customactivityoncrash:2.4.0")
    implementation("com.davemorrissey.labs:subsampling-scale-image-view-androidx:3.10.0")
    implementation("com.github.bumptech.glide:glide:4.15.1")
    implementation("cn.Leaqi:SwipeDrawer:1.6")
    implementation("com.github.skydoves:colorpickerview:2.3.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("com.google.code.findbugs:jsr305:3.0.2")
    implementation("me.zhanghai.android.fastscroll:library:1.3.0")
    implementation("net.lingala.zip4j:zip4j:2.11.5")
    implementation("net.zetetic:sqlcipher-android:4.10.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("org.jsoup:jsoup:1.18.1")
    implementation("org.ocpsoft.prettytime:prettytime:4.0.6.Final")
    implementation("org.simpleframework:simple-xml:2.7.1") {
        exclude(group = "xpp3", module = "xpp3")
    }
    implementation("org.commonmark:commonmark:0.27.0")
    implementation("org.commonmark:commonmark-ext-gfm-strikethrough:0.27.0")
    implementation("com.github.luben:zstd-jni:1.5.7-6@aar")

    androidTestImplementation("androidx.room:room-testing:$roomVersion")
    androidTestImplementation("androidx.work:work-testing:2.9.1")
    testImplementation("androidx.arch.core:core-testing:2.2.0")
    testImplementation("androidx.test:core-ktx:1.6.1")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("io.mockk:mockk:1.13.12")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.assertj:assertj-core:3.24.2")
    testImplementation("org.json:json:20180813")
    testImplementation("org.mockito.kotlin:mockito-kotlin:5.4.0")
    testImplementation("org.mockito:mockito-core:5.13.0")
    testImplementation("org.robolectric:robolectric:4.16.1")
    testImplementation("com.github.luben:zstd-jni:1.5.7-6")
}