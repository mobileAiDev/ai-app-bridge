# Native editing through Intent

Use a current supervised Intent observation. To acquire a newer screen without dispatching an action, call:

```json
{"operation":"observe","operationId":"your-intent","basedOnRevision":1}
```

`reobserve` is an alias. Only `waiting_for_decision` permits this operation. It reads the provider and persists the observation and summary before exposing revision + 1. Old decisions then require a new observation/revision. It does not sleep, tap, or restart a terminal execution.

Submit an editing decision using the returned revision:

```json
{"operation":"decide","operationId":"your-intent","decision":{"decisionId":"edit-title-1","agentDecision":"act","basedOnRevision":2,"action":{"action":"inputText","selector":{"resourceName":"io.github.mobileaidev.notallyx.sample:id/EnterTitle"},"value":"Example title"}}}
```

`tap` uses the same selector shape. Select either `resourceName` or exact `text`, with one selector key. Existing `tap` with top-level `text` remains supported. Native selection requires exactly one enabled, effectively visible node in the topmost observed window and a center inside its viewport. Input additionally requires SDK `editable: true`. Legacy providers without that field support only the exact standard `EditText` or `android.widget.EditText` class; custom classes require the SDK fact. Explicit `editable: false` always rejects. Duplicate, invisible, obscured and noneditable targets fail without dispatch. A native `scroll`/`scrollBy` uses that window's bounds; `direction` is `down` (default) or `up`.

Native summaries preserve `resourceName`, `editable`, `visible`, and `effectiveVisible` when supplied by the SDK, including blank input fields. Missing metadata remains unknown. The top-level `activity` is copied from the current raw tree. Summary visibility does not establish that a node belongs to the foreground window; the adapter separately enforces the topmost observed window. Each summary node retains its `rawTreeId` and `sourceIndex` for evidence lookup.

An exact native accessibility name can use `selector: {"contentDescription":"置于顶部"}`. It is a separate selector from `text`; no substring match or text/description fallback occurs. A native summary `label` derived from the raw `contentDescription` corresponds to this explicit selector. The same unique visible foreground target rules apply.

Native input passes its observed coordinates and Host action ID to the Bridge input endpoint. App-local input failures do not fall back to ADB text insertion into an unrelated focused field. Older Android runtimes may not return/associate the input action ID; Host receipts alone do not establish mobile action correlation. The caller must inspect the actual runtime evidence and verify the resulting business state.

Unsupported actions/providers fail closed. UIA and Flutter inputText are outside this addition. Unknown actions never become taps. Intent execution completion is separate from business acceptance.
