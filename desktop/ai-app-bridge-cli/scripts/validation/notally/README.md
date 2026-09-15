# NotallyX regression through Instrumentation

These JavaScript and Python scripts independently execute the same 70-step plan through `ctx.call('android-executor', ...)`. They run against the existing NotallyX sample application (`io.github.mobileaidev.notallyx.sample`), preserving its package and existing notes. Each run intentionally creates one note, one two-item list, and a uniquely named label, which remain available for inspection.

Prepare that project's `:app` / `debug` variant with `executor-prepare`, then install the returned matching application and test APKs. The generated class is `io.github.mobileaidev.aiappbridge.generated.BridgeSessionTest`; no test source is added to NotallyX's business source. Start from its normal notes page without an open modal. The plan expects the sample's English UI and its current resource IDs.

From the CLI source directory:

```sh
node scripts/validation/verify-notally-executor.js DEVICE /absolute/new-js-proof javascript
node scripts/validation/verify-notally-executor.js DEVICE /absolute/new-python-proof python
```

Coverage: Unicode/multiline note creation and editing, reopening, pinning, label assignment, archive/unarchive, trash/restore, list creation, persisted checkbox state, positive/negative search, and a final UI Automator observation. This does not cover attachments, reminders, sharing, or every NotallyX feature.

The scripts use Espresso touch actions and explicit `replaceTextViaInputConnection`. NotallyX's custom `setText` suppresses a business watcher; the setter action alone can change the screen without saving the model. Reopening assertions are therefore part of the plan. Bridge's action receipt still does not replace an independent persistence check.

The OPPO/API-36 run for 0.3.8 completed in 26.4 s (JS) and 26.8 s (Python), each with 53 actions including one list scroll and 18 assertions. Timings exclude build/install/session startup. Independent SQLite verification confirmed the resulting notes/list states and that all 34 pre-existing notes remained unchanged. Other data volumes, devices, and App revisions can require different locators or timing.
