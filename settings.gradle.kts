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

include(":ai-app-bridge-test-core", ":ai-app-bridge-test-uia", ":ai-app-bridge-test-espresso")
project(":ai-app-bridge-test-core").projectDir = file("android/executors/core")
project(":ai-app-bridge-test-uia").projectDir = file("android/executors/uia")
project(":ai-app-bridge-test-espresso").projectDir = file("android/executors/espresso")
include(":ai-app-bridge-test-instrumentation")
project(":ai-app-bridge-test-instrumentation").projectDir = file("android/executors/instrumentation")
include(":ai-app-bridge-test-espresso-web")
project(":ai-app-bridge-test-espresso-web").projectDir = file("android/executors/espresso-web")
include(":ai-app-bridge-test-compose")
project(":ai-app-bridge-test-compose").projectDir = file("android/executors/compose")
