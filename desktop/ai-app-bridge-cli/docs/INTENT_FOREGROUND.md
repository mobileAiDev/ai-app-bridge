# Android Intent foreground routing

An Intent can keep its original business target while navigating through explicitly listed Android system apps. Supply `target.foregroundPackages` to enable this mode. Without that field, the existing explicit provider contract is unchanged.

```json
{
  "command": "intent",
  "arguments": {
    "operation": "start",
    "goal": "Export a backup, choose its file in the system picker, and return to the notes app",
    "provider": "native",
    "target": {
      "serial": "DEVICE_SERIAL",
      "packageName": "io.github.mobileaidev.notallyx.sample",
      "foregroundPackages": ["com.coloros.filemanager"]
    }
  }
}
```

Use packages actually resolved on the device for the requested flow. `foregroundPackages` is an explicit array of additional package names; an empty array restricts the operation to its original app. It does not discover or grant access to unrelated apps.

Each observation checks the foreground component before and after acquiring a fresh tree. In the original app it uses the selected primary provider (`native`, `flutter`, or `uia`); in a listed external package it uses UIA. Provider failures remain errors, and never trigger a substitute tree. A UIA dump must identify the same foreground package.

`uia_tree_changed` means the tree changed during traversal; that read supplies no
complete tree. A caller may make another explicit read within its observation
budget, retaining the failed read. It must obtain a complete current tree before
choosing any action. The Host does not retry the read or substitute a provider.

The summary contains `provider` and `foreground` (`packageName`, `activity`, `component`, probe source and timestamps). Observation, decision, dispatch marker and receipt records preserve that route. The original `target` continues to identify the business operation and its app capture streams. System UIA observations do not imply that system-app network/state/event capture is available.

Actions inherit the provider of their committed observation. An explicit conflicting provider is rejected. Before dispatch, the adapter checks the foreground component again; a changed component returns `reobserve_required` without dispatching a tap. Exact UIA taps use the API 25+ phone node runtime. Its `uia-node` execution receipt binds the Intent action ID, original request hash, runtime epoch, node/window attributes and original callback. The selected node is revalidated on the same automation connection before dispatch. A callback still requires a fresh observation and business checks; it does not create system-app SDK events.

Device-scoped physical taps remain managed Android shell input. Cancellation
and recovery follow the selected executor's admission and completion contract.
If a dispatched action's terminal receipt is unavailable, durable device
ownership blocks later mutations until `device-ownership reconcile` verifies
that original receipt.
Intent records retain both the original unknown result and any separate recovery
history. A completed tap still requires a fresh observation and business checks.

For exact UIA taps, use one of these selectors:

```json
{ "action": "tap", "selector": { "text": "NotallyX Backup 2026-09-07 \n15-44.zip" } }
{ "action": "tap", "selector": { "resourceName": "com.coloros.filemanager:id/action_file_operate" } }
{ "action": "tap", "selector": { "contentDescription": "返回" } }
```

The selector must identify exactly one enabled node in the observed package. Duplicate matches, unsupported selector fields and unavailable bounds fail before input. UIA lookup, compact trees and Intent summaries share the same XML attribute decoder, including decimal/hexadecimal character references. Decoding happens once: `&amp;#10;` stays literal `&#10;`, while `&#10;` becomes a newline. Invalid XML character references fail explicitly.

If the foreground changes during observation, the operation enters `waiting_for_observation`. Call `operation: "observe"` with the same `operationId`; the operation returns to `waiting_for_decision` only after a new observation commits. Acting or completing from `waiting_for_observation` is rejected. Existing evidence-store failures retain their separate blocked state.

Flutter taps accept one exact selector: `{ "text": "Settings" }` or
`{ "nodeId": "15" }`. Put the identity inside `action.selector`.
Text must identify one actionable node. Repeated
labels such as three settings rows displaying "System" return
`flutter_selector_not_unique` without dispatch. Select the intended row's
`nodeId` from the current committed observation instead. IDs are local to that
observation; a new tree requires a new lookup. A node must supply valid
`tap.bounds`; the Host does not invent tap bounds for text-only nodes. Flutter
coordinates remain logical pixels. Material `NavigationDestination` nodes
expose their public labels and individual destination bounds.

The operable tree traverses live Elements, including framework-owned pages
such as `LicensePage`. It is separate from the diagnostic inspector summary.
Repeated text for the same action region is emitted once; distinct settings
rows keep distinct targets. Each emitted label needs its own visible bounds.
The traversal reports truncation when its 512-level depth limit is reached.

This brackets foreground identity; it is not an atomic OS screenshot/action transaction. Animations and layout changes within the same Activity still require fresh stable observations and post-action verification. This change does not add arbitrary UIA Unicode input or attachment/backup business assertions.
