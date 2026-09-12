pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "ai-app-bridge"

include(":ai-app-bridge-android")
project(":ai-app-bridge-android").projectDir = file("android/ai-app-bridge-android")

include(":ai-app-bridge-gradle-plugin")
project(":ai-app-bridge-gradle-plugin").projectDir = file("android/ai-app-bridge-gradle-plugin")

include(":ai-app-bridge-uia")
project(":ai-app-bridge-uia").projectDir = file("android/ai-app-bridge-uia")
