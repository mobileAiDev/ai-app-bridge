# Historical source evidence

This bundle contains the 46 files referenced by the original evidence source index, plus the 10 files explicitly referenced by its two SQLite snapshot manifests. `index-original.json` is an unchanged copy of the index used to select them. `bundle-manifest.json` preserves the original paths, SHA-256 hashes, Intent IDs, observation references and scenario mapping qualifications.

Each source file was copied byte for byte. The initial bundle is 8.21 MB of original bytes, including the index copy. It includes the database, WAL, SHM, preferences and acquisition transcript needed to review the two historical database snapshots. It excludes Host FactStore segments, unrelated process logs and unreferenced binaries.

All `bundlePath` values in the manifest are relative to the repository root. Historical JSON retains its original absolute paths so that its original hashes remain valid. Use the manifest's `originalPath` and `references[].originalReference` mappings to find the local copied artifact after relocation. For SQLite inspection, copy DB/WAL/SHM to a temporary directory first; never write to the evidence files.

This is source material for authoring and reviewing Script cases. Historical completion and oracle results do not pass a new regression run. Partial scenario mappings remain partial, and unmapped scenarios remain unexecuted. No additional Intent run, screenshot, scenario coverage or current-device result is claimed by bundling these files.
