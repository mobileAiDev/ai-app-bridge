#if DEBUG
import UIKit

// iOS 27 requires a scene lifecycle. UIKit loads the original Main storyboard.
final class BridgeSampleSceneDelegate: NSObject, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        let delegate = UIApplication.shared.delegate as! AppDelegate
        delegate.window = window
        window?.backgroundColor = UIColor.app.background
        open(options.urlContexts)
    }

    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        open(contexts)
    }

    private func open(_ contexts: Set<UIOpenURLContext>) {
        let delegate = UIApplication.shared.delegate as! AppDelegate
        for context in contexts {
            _ = delegate.application(UIApplication.shared, open: context.url, options: [:])
        }
    }
}
#endif
