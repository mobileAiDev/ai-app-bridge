# Installation and supported Host platforms

The simplest path is a supported Node installation and one MCP configuration.
The same npm package contains CLI and MCP; running only MCP is supported.
FactStore is an embedded library bundled in that package. There is no separate
database, FactStore service or CLI process to install first.

This source targets the coordinated 0.4.2 release.
Registry publication is a separate step; before
publication, use the reviewed local tarball instead of expecting this registry
version to resolve.

```json
{
  "mcpServers": {
    "ai-app-bridge": {
      "command": "npx",
      "args": ["--yes", "--package", "@mobileaidev/ai-app-bridge@0.4.2", "ai-app-bridge-mcp"]
    }
  }
}
```

For a local tarball, replace the package/version argument with its absolute
`.tgz` path. Pin a version; do not let an unrelated global CLI installation
silently determine the MCP server version. After upgrading, reconnect the MCP
client so it loads the new code. Read mismatch diagnostics before stopping any
shared Runtime: an older client should be upgraded without stopping a newer owner.

## Requirements

| Layer | Requirement |
| --- | --- |
| Host runtime | Node >=26.3.0 <27; validation baseline 26.3.0 |
| macOS Host | arm64 or x64, macOS 13.5+ |
| Linux Host | arm64 or x64, glibc 2.28+, kernel 4.18+; Node's libstdc++ and libatomic runtime requirements |
| Native store | Bundled Node-API 8 addon selected by OS/architecture/libc, checksum checked; no compiler/Python during normal install |
| JS/regex extraction and ordinary commands | No Python interpreter needed |
| Python Script/extraction | Python 3.9+; optionally set AI_APP_BRIDGE_PYTHON |
| Android provider | ADB and a connected device; SDK commands need the App's debuggable Bridge integration |
| iOS/WDA provider | macOS, Xcode and the device/provider setup in COMMAND_CONTRACT |
| Web providers | Browser/App connection required by the selected provider |

The Node OS/library baseline follows [Node 26.3.0 build/platform requirements](https://github.com/nodejs/node/blob/v26.3.0/BUILDING.md#platform-list).
It does not imply validation on every later OS or Node minor release. Native
Windows, musl/Alpine and other architectures are outside this native Host matrix;
the POSIX store does not acquire Windows support from a sample cmd.exe config.
WDA 14.1.1 is installed as an npm dependency on all platforms, but preparation
and execution use macOS. No split WDA package is required for basic MCP use.

Missing/corrupt/unsupported prebuilds fail with the actual OS, architecture and
Node-API information. Normal install never silently compiles, downloads a
substitute addon or chooses another storage backend. Release checks must verify
each matrix artifact; a Mac build alone is not Linux acceptance.

## Development and release verification

Native maintainers may explicitly run `npm run build` in
`native/segmented-fact-store` to build from source with node-gyp and stage their
local artifact. This requires the developer's compiler/Python. Release artifacts
must also record their actual ABI minimum; never label a newer glibc build 2.28.
The loader and startup fingerprint use the same selected `.node` file.

`npm run verify:package -- /absolute/new/output` creates a real tarball and a
fresh installation outside the repository. It denies compiler/Python commands
for install and the pure MCP npx checks, verifies the loaded artifact/checksum,
then uses a separate normal environment for the existing two-language regression.
It checks first/repeated npx start, schema discovery, JS/regex, source ref recovery,
MCP disconnection versus Runtime lifetime, durable store restart and controlled
ADB scenarios. This is package/transport evidence, not physical-device acceptance.

`npm test` runs functional checks and then a serial performance group. Use
`npm run test:performance` on an otherwise quiet host for the timing gate;
existing p95 thresholds are unchanged.
