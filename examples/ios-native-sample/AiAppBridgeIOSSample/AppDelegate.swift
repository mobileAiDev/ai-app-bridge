import AiAppBridgeIOS
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        #if DEBUG
        AiAppBridge.shared.start(appName: "ios_native_sample")
        AiAppBridge.shared.recordLog(level: "info", tag: "Sample", message: "iOS native sample launched")
        AiAppBridge.shared.recordState(namespace: "sample", key: "screen", value: "home")
        #endif
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }
}
