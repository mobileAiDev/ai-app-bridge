# Golden corpus

`v1/` is a deterministic, closed store produced by the C11 reference
implementation. It contains two enabled partitions and three records whose
logical and physical expectations are in `v1/expected.json`.

`large-fact-v1.json` is the adapter-level cross-platform golden vector for a
logical fact that spans native frames. It fixes the binary chunk header, raw
UTF-8 bytes, complete SHA-256, and final manifest fields. Host, Android, and
iOS tests should consume this same file; they must not maintain independent
copies or encode chunk bytes as base64.

Consumers should copy the corpus to a temporary directory before opening it,
because a normal writer open/close advances the double-slot manifest
generation. Verify the copied corpus by scanning both physical partitions and
by performing a global-sequence scan.

To regenerate it from the module root:

```sh
clang -std=c11 -Wall -Wextra -Wpedantic -Werror \
  -Iinclude src/sfs.c tests/generate_golden.c -pthread \
  -o build/sfs_generate_golden
build/sfs_generate_golden /path/to/empty-output-directory
```

Regeneration is expected to reproduce the manifest and segment hashes in
`v1/SHA256SUMS`. The generator refuses format ambiguity by checking each append
receipt's sequence and physical offset.
