# Android foreground observations and explicit targets

Foreground detection reports facts; it does not authorize or veto actions. The same
contract applies to CLI, MCP, Script and Android Intent. No force or confirmation
flag is required to act when the foreground differs or cannot be probed.

Results expose `foregroundObservations` and `warnings`, including:

- `expected`: the explicitly requested serial and package.
- `actual`: observed window owner, type, Activity, UID/process identity and raw
  evidence where available. Missing fields remain missing. `ownershipVerified`
  is true only after the WindowManager, PackageManager and process checks pass.
- `status`: `match`, `mismatch`, `unknown`, or `observed` for a device-only request.
- `reason`, `source`, `startedAtMs` and `observedAtMs`: the diagnosis and timing.

A parsing failure is `unknown`, never proof of a mismatch. Specific causes such as
`foreground_window_type_missing`, conflicting field values, unknown types and ADB
stderr remain available. Window titles are client data, not owner identities.
The parser reads fields independently of indentation, line order and optional
LayoutParams class prefixes; it accepts platform numeric and symbolic types.
Nested LayoutParams task fields cannot replace the actual Activity task identity.

`execution.ok`, `dispatched` and `ambiguous` describe the actual action. Warnings
cannot turn failure into success or success into failure. Public reply `control`
retains foreground feedback even when the caller extracts only part of `value`.
A failed screenshot probe does not negate a successfully captured image.

## Intent target selection

An observation keeps its explicit provider and app. `target.foregroundPackages`
is accepted for existing callers but no longer triggers routing or admission.
An external package or an app overlay never implicitly changes the provider.
The agent reads the observation and explicitly changes targets when appropriate:

```json
{
  "command": "intent",
  "extract": null,
  "arguments": {
    "operation": "observe",
    "operationId": "EXISTING_OPERATION_ID",
    "provider": "uia",
    "observationTarget": { "packageName": "com.coloros.filemanager" }
  }
}
```

Use a package actually observed on the device. Set `observationTarget` to `null`
to return to the original app; provider selection remains explicit. Android H5
can also select `webViewId`. The summary separates `foreground` from
`executionTarget`; the immutable Intent target continues to identify the business
operation and capture streams. System-app UIA access does not imply SDK capture.
Installer UI uses this same explicit observation target. Permission workflows
retain their independent requester and permission-state verification.

Actions inherit their committed observation's provider and selected app. An
incompatible provider requires a new `observe`; the tool never retries an action
through another provider. `tap-text` and `wait-text` default to `native`.
Explicit `provider: "auto"` remains an opt-in discovery request before selection.

## References, failures and continuation

Native and UIA actions revalidate their originally bound window/node even when
focus changes. H5 references retain the original WebView and document. Missing,
replaced, expired or ambiguous targets fail specifically, without rebinding to
another target. Required action properties, such as touchability or a working
editor input connection, still apply. A coordinate request with no uniquely
resolvable window cannot invent one.

A definite action failure leaves Intent available for another observation or
explicit decision. A foreground change during capture returns both observations
and a warning with the captured tree. UIA `uia_tree_changed`, in contrast, means
traversal did not produce a complete tree; explicitly observe again before choosing
a node. Missing callbacks after dispatch retain the original settlement and
device-ownership recovery contract; foreground warnings do not release ownership
or justify replaying an unknown action.

Exact UIA selectors match text, resourceName or contentDescription in the explicit
package. Multiple matches fail without picking the first. XML numeric entities
are decoded once: `&#10;` becomes a newline, while `&amp;#10;` remains literal.
Flutter exact text or nodeId selectors retain current logical-pixel target bounds;
repeated labels require a more precise target. Fresh UI and business checks are
still needed after a successful execution receipt.
