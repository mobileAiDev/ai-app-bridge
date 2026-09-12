# FreeOTP iOS native Bridge sample

The pinned upstream source and license are preserved under ignored `upstream/`.
This sample complements Kiwix's native/WKWebView flows and the Flutter sample.
It is a real UIKit application with multiple token records, input validation,
editing, QR input, ordering, deletion and Keychain persistence.

All fixtures must be synthetic and unrelated to real accounts. Verify generated
codes independently from the App using the fixed fixture secret and counter.
Do not copy or print a user's existing authentication tokens.

Accepted validation state: the pinned App was built, signed with a Personal Team and installed
as `io.github.mobileaidev.freeotp.sample`. Native Intent created a synthetic HOTP
record. `scripts/native-regression.js` then continuously exercised validation,
input, algorithm/type selection, icon search, saving, independent HOTP checks
and process restart in 78.395 seconds (79.530 seconds from public start to
terminal). All 17 checks passed; five real screenshots are in the verified
archive. A separate wrong-code Script produced a fresh failed UI assertion.
See [results and retained failures](../../docs/IOS_NATIVE_BUSINESS_2026-09-10.md).

On 2026-09-11 this completed test sample was removed from the iPhone to free one
Personal Team installation slot for Flexify. The original signed bundle remains
at `build/device/Build/Products/Debug-iphoneos/FreeOTP.app`; original accepted
Script evidence is unchanged. A quiescent Documents/Library snapshot and file
hashes are retained under the repository's
`build/ai_app_bridge_artifacts/flexify-ios-core-2026-09-11/freeotp-backup-06/`.
Keychain is outside that snapshot and tmp copying failed; no complete credential
backup or successful reinstall is claimed. The fixtures are synthetic.

`integrate.rb` adds the local Bridge SPM package, Debug identity and the Scene
bootstrap required by iOS 27. It refuses an already integrated checkout. The
fixed upstream requires Base32 0.9.0, SDWebImage 5.21.3 and Font Awesome Free
6.4.2 fonts. `build/integration.json`, `build/fontawesome-source.json` and the
preserved build logs identify the actual dependency/bootstrap inputs. The
business model and Keychain implementation remain upstream code.

Run one fresh fixture using `node examples/freeotp-sample/validation/run-native.js
<config.json>`. The JSON config supplies `name`, explicit `language` (`javascript`
or `python`), absolute `sourcePath` and new
`outputDir`, `target` with platform/deviceId/bundleId/wdaRunnerBundleId, and
`inputs` with issuer/description/wdaSessionId. Do not put a session in the
default target: the Script explicitly closes and recreates it after restart.
The initial App page must be the home list. Output directories and issuer names
must be unused. The controller freezes the source and archives both success
and failure; it never retries a device action.

This is one UIKit business flow, not acceptance of all FreeOTP features, all
iOS native controls, H5, Flutter or the overall production goal.
