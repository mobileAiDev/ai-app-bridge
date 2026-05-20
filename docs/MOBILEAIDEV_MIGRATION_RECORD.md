# mobileAiDev Migration Record

## 2026-05-20

### Scope

Migrate the current repository surface to `mobileAiDev/ai-app-bridge` and
prepare a new `0.2.0` release under neutral package coordinates.

Old artifacts remain available under their existing legacy coordinates. Git
commits, tags, and GitHub history are not rewritten.

### Initial evidence

- `https://github.com/mobileAiDev/ai-app-bridge` returned HTTP 200.
- `npm view @mobileaidev/ai-app-bridge` returned `E404`, so no public package
  with that exact new npm name was visible before migration.
- Current local branch: `main`.
- Current remote before migration pointed at the legacy GitHub owner.
- Pre-existing dirty file before migration: `docs/KNOWN_ISSUES.md`.

### Decisions

- Use GitHub owner `mobileAiDev`.
- Use npm package `@mobileaidev/ai-app-bridge` because npm package names and
  scopes should be lowercase.
- Use source package prefix `io.github.mobileaidev.aiappbridge`.
- Use Gradle plugin id `io.github.mobileaidev.aiappbridge.android`.
- Keep Flutter pub package name `ai_app_bridge_flutter`; only update its
  version, metadata, Android package name, and debug Android runtime dependency.
- Use sample app id `io.github.mobileaidev.aiappbridge.sample`.
- Use first migrated release version `0.2.0`.
- Keep historical documentation files, but scrub current visible old identity
  strings from those files so GitHub source search on the current tree does not
  show the old package names.
- Do not store the npm token in the repository.

### Checklist

- [x] Write migration design document.
- [x] Rename package coordinates and source packages.
- [x] Update public READMEs and integration docs.
- [x] Scrub old identity strings from current tree.
- [x] Run local syntax, unit, Gradle, and Flutter validation.
- [ ] Decide whether this machine can publish under `@mobileaidev`.
- [ ] Publish and verify new artifacts.

### Validation results

- Former identity scan: passed. No current source-tree matches outside `.git`.
- Node syntax: passed for `bin/ai-app-bridge.js` and `bin/mcp-server.js`.
- Node tests: passed, 31 tests.
- npm package dry run: passed for `@mobileaidev/ai-app-bridge@0.2.0`.
- npm publish dry run: passed with public access for
  `@mobileaidev/ai-app-bridge@0.2.0`.
- Android runtime and Gradle plugin build: passed with
  `:ai-app-bridge-android:build :ai-app-bridge-gradle-plugin:build`.
- Android native sample build: passed with `:app:assembleDebug`; the new Gradle
  plugin id configured the debug build and ASM transform executed.
- Flutter pub get: passed.
- Flutter analyze: passed with no issues.
- Flutter publish dry run: archive content was correct, but the command returned
  non-zero because the package is currently in a dirty git working tree. Re-run
  after committing the migration before publishing to pub.dev.
- npm auth state: `npm whoami` is not currently authenticated on this machine.
  Real npm publish needs a valid token or login, but the token must stay out of
  repo files and logs.

### Release preparation results

- Git remote was updated to `https://github.com/mobileAiDev/ai-app-bridge.git`.
- Commit `1dc90ab` was pushed to `main`.
- Tag `0.2.0` was pushed to GitHub and resolves to commit `1dc90ab`.
- JitPack `0.2.0` remote artifacts were verified with HTTP 200:
  - Android runtime POM
  - Android runtime AAR
  - Gradle plugin POM
  - Gradle plugin JAR
- npm organization `mobileaidev` was created manually by the maintainer.
- Real npm publish for `@mobileaidev/ai-app-bridge@0.2.0` is still blocked:
  `npm whoami` returned `E401`, and publish returned an authorization failure.
  The package remains unpublished as confirmed by `npm view`.

### Remaining publish steps

- Provide a valid npm login or token with publish permission for the
  `mobileaidev` organization, then publish
  `@mobileaidev/ai-app-bridge@0.2.0`.
- Publish `ai_app_bridge_flutter 0.2.0` to pub.dev after confirming pub.dev
  credentials on this machine.
- After npm publish, run `npm view @mobileaidev/ai-app-bridge version
  dist-tags --json`, install the new package globally, and verify
  `ai-app-bridge --help`.
