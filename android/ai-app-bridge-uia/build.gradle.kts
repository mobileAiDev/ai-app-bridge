import java.security.MessageDigest

plugins { java }

// This shell runtime is a DEX artifact, not an APK or an SDK dependency of the target app.
val sdk = providers.environmentVariable("ANDROID_HOME")
val androidJar = sdk.map { file("$it/platforms/android-35/android.jar") }
val d8Jar = sdk.map { file("$it/build-tools/36.0.0/lib/d8.jar") }
val dexJar = layout.buildDirectory.file("runtime/ai-app-bridge-uia.jar")
val bundleManifest = layout.buildDirectory.file("runtime/manifest.json")

java {
    sourceCompatibility = JavaVersion.VERSION_1_8
    targetCompatibility = JavaVersion.VERSION_1_8
}

dependencies {
    compileOnly(files(androidJar))
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

tasks.test { useJUnit() }
tasks.jar { isPreserveFileTimestamps = false; isReproducibleFileOrder = true }

tasks.register<JavaExec>("buildRuntimeDex") {
    dependsOn(tasks.jar)
    classpath = files(d8Jar)
    mainClass.set("com.android.tools.r8.D8")
    inputs.file(tasks.jar.flatMap { it.archiveFile })
    inputs.file(androidJar)
    inputs.file(d8Jar)
    outputs.file(dexJar)
    doFirst {
        dexJar.get().asFile.parentFile.mkdirs()
        args("--min-api", "25", "--lib", androidJar.get().absolutePath,
            "--output", dexJar.get().asFile.absolutePath, tasks.jar.get().archiveFile.get().asFile.absolutePath)
    }
}

tasks.register("buildRuntimeBundle") {
    dependsOn("buildRuntimeDex", tasks.test)
    val sources = fileTree("src/main/java") { include("**/*.java") }
    inputs.files(sources, project.buildFile, androidJar, d8Jar, dexJar)
    outputs.file(bundleManifest)
    doLast {
        fun sha(file: File) = MessageDigest.getInstance("SHA-256")
            .digest(file.readBytes()).joinToString("") { "%02x".format(it.toInt() and 255) }
        val sourceHashes = (sources.files + project.buildFile).sortedBy { it.absolutePath }
            .associate { rootProject.relativePath(it) to sha(it) }
        bundleManifest.get().asFile.writeText(groovy.json.JsonOutput.prettyPrint(groovy.json.JsonOutput.toJson(mapOf(
            "schemaVersion" to "aab.uia.bundle.v1", "mainClass" to "io.github.mobileaidev.aiappbridge.uia.UiaRuntime",
            "artifact" to dexJar.get().asFile.name, "sha256" to sha(dexJar.get().asFile),
            "minApi" to 25, "compileApi" to 35, "buildTools" to "36.0.0",
            "androidJarSha256" to sha(androidJar.get()), "d8JarSha256" to sha(d8Jar.get()), "sources" to sourceHashes
        ))) + "\n")
    }
}

tasks.register<Sync>("stageRuntimeBundle") {
    dependsOn("buildRuntimeBundle")
    from(dexJar, bundleManifest)
    into(rootProject.layout.projectDirectory.dir("desktop/ai-app-bridge-cli/runtime/uia"))
}
