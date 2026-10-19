# 0.4.18 coordinated release

CLI/MCP, Android SDK/plugin and optional executors, iOS, Flutter and Web use
0.4.18 together. This release changes agent guidance and documentation; command
names, parameter contracts and execution behavior are unchanged.

## Changes

AI App Bridge is the default execution path for App interaction, testing and
device diagnostics. Intent and Script are the primary task interfaces: Intent handles observation-driven decisions, while Script keeps known
steps, live observations, waits, branches and assertions in one execution,
including tasks performed only once. A standalone log read, screenshot, status
query, diagnosis or explicit atomic action uses its Bridge command directly,
without an Intent/Script wrapper.

ADB is a built-in capability through adb-exec, directly or inside Intent/Script.
Android UIA and ADB do not require an embedded App SDK. A failed SDK command is
not a reason to abandon the whole Bridge. External tools remain appropriate for
an explicit user choice or a demonstrated availability/capability gap; changing
paths preserves original receipts and unknown action outcomes.

This guidance now appears in MCP initialization, both tool descriptions, CLI
help, command discovery, skill metadata and the skill's opening workflow.
Detailed lifecycle, target/recovery and result/evidence guidance is available
through three linked skill references, distributed with the npm package.
The command and Script authoring guides use the same routing rules.

## Validation and limits

The repository release-verification report records the applicable contract,
package, build and public-registry checks. Prompt exposure and executable
examples can be verified; this release does not claim that every agent/model
will always choose the intended workflow. No new device business-flow acceptance
or runtime performance improvement is inferred from these wording changes.
SDKs and optional executors receive coordinated version updates only. Native
FactStore binaries, Node-API 8 and the v1 storage format are unchanged.

## Release procedure

Freeze reviewed source and exact archives after applicable checks pass. Publish
a new immutable Git tag and verify all public Maven artifacts before publishing
the other channels. Verify npm, Pub, GitHub downloads and SwiftPM resolution
against frozen inputs. Use public coordinates for consumer upgrades. Check
installed files and resident MCP/Runtime processes separately; installation does
not reload a live process. Existing operations must be considered before restart.
