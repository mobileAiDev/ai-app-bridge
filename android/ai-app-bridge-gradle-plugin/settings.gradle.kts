pluginManagement {
    repositories {
        google()
        val centralRepositoryUrl = providers.gradleProperty("aiAppBridge.centralRepositoryUrl").orNull
        if (centralRepositoryUrl == null) {
            mavenCentral()
        } else {
            maven {
                name = "configuredCentral"
                url = uri(centralRepositoryUrl)
            }
        }
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        val centralRepositoryUrl = providers.gradleProperty("aiAppBridge.centralRepositoryUrl").orNull
        if (centralRepositoryUrl == null) {
            mavenCentral()
        } else {
            maven {
                name = "configuredCentral"
                url = uri(centralRepositoryUrl)
            }
        }
    }
}

rootProject.name = "debug_bridge_gradle_plugin"

