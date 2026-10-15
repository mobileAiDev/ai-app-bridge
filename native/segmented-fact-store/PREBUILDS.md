# Release prebuilds

The normal npm install path verifies `prebuilds/manifest.json` and loads the
selected Node-API 8 artifact. It does not invoke Python, node-gyp or a compiler.
Unsupported targets and missing/corrupt binaries fail explicitly.

The 0.2.0 native package bundled in Bridge 0.4.14 includes macOS arm64/x64
(deployment target 13.5), Linux glibc arm64/x64 (target glibc 2.28), and Windows
x64. The Bridge Host still requires Node >=26.3.0 <27. Windows ARM64 and musl
Linux are outside this release's native support matrix. macOS and Linux were
already shipped in 0.4.13; Windows x64 is new in 0.4.14.

Maintainers can recreate the four POSIX artifacts on macOS with Apple clang,
the official Node 26.3.0 headers and Zig 0.15.2:

```sh
node scripts/build-release-prebuilds.js /absolute/path/to/include/node /absolute/path/to/zig
```

Verify the Node and Zig downloads against their official checksums before
building. The script compiles the native sources, regenerates SHA-256 metadata,
and preserves an existing Windows entry. Check the diff, then run the native tests and
Bridge's `verify:package` on every target before release. Compiler/platform
differences may change binary hashes; the manifest must describe the files
actually tested and packaged.

The Windows artifact is built with MSVC on an actual Windows CI runner. Import
the exact tested binary and its manifest entry only after native recovery,
golden-format, Host lifecycle and fresh-package tests pass. Every artifact records
seven source hashes; verify them against the release source as well as checking
the binary hash. The final Windows 0.4.14 artifact comes from CI run 38734283036
at source 6187bb57a389aeab37b4ec4e2a4c5a5c28cb9621. Existing POSIX targets were
verified in run 38734289532 and locally on macOS arm64.

`npm run build` is an explicit developer-only node-gyp build for the current
host. Its staging step marks that artifact as `sourceBuild` and records the
host and compiler. On Linux it also records the host glibc version; such a build
is not evidence for the lower release glibc baseline. `sourceBuild` describes
maintainer build provenance, not compilation during consumer installation.
Never substitute a build alone for release matrix testing.
