# Release prebuilds

The normal npm install path verifies `prebuilds/manifest.json` and loads the
selected Node-API 8 artifact. It does not invoke Python, node-gyp or a compiler.
Unsupported targets and missing/corrupt binaries fail explicitly.

The 0.2.0 native package bundled in Bridge 0.4.0 includes macOS arm64/x64
(deployment target 13.5), and Linux glibc arm64/x64 (target glibc 2.28).
The Bridge Host still requires Node >=26.3.0 <27. Windows and musl Linux are
outside this release's native support matrix.

Maintainers can recreate all four artifacts on macOS with Apple clang,
the official Node 26.3.0 headers and Zig 0.15.2:

```sh
node scripts/build-release-prebuilds.js /absolute/path/to/include/node /absolute/path/to/zig
```

Verify the Node and Zig downloads against their official checksums before
building. The script compiles `src/sfs.c` and `bindings/node/sfs_node.c` and
regenerates SHA-256 metadata. Check the diff, then run the native tests and
Bridge's `verify:package` on every target before release. Compiler/platform
differences may change binary hashes; the manifest must describe the files
actually tested and packaged.

`npm run build` is an explicit developer-only node-gyp build for the current
host. Its staging step marks that artifact as `sourceBuild` and records the
host glibc version. Such a build is not evidence for the lower release glibc
baseline. Never substitute it for release matrix testing.
