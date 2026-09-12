#!/usr/bin/env python3
"""Freeze the release's world maps and Monaco with the upstream download hashes."""
import base64
import hashlib
import json
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

sample = Path(__file__).resolve().parent
upstream = sample / "upstream"
source = json.loads((sample / "source.json").read_text())
commit = subprocess.check_output(["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True).strip()
if commit != source["commit"]:
    raise SystemExit("Requires the pinned Organic Maps source")
if len(sys.argv) != 2:
    raise SystemExit("Usage: prepare-maps.py NEW_OUTPUT_DIRECTORY")
output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=False)
catalog_path = upstream / "data/countries.json"
catalog = json.loads(catalog_path.read_text())


def countries(node):
    yield node
    for child in node.get("g", []):
        yield from countries(child)


entries = {item["id"]: item for item in countries(catalog)}
# Use the same pinned BLAKE3 implementation as the app. Organic Maps stores
# the first nine hash bytes as base64 in countries.json.
b3 = upstream / "3party/BLAKE3/c"
helper = output / "hash-file.c"
helper.write_text('''#include <stdio.h>
#include "blake3.h"
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  FILE *f = fopen(argv[1], "rb");
  if (!f) return 3;
  blake3_hasher h; blake3_hasher_init(&h);
  unsigned char data[65536], hash[BLAKE3_OUT_LEN]; size_t n;
  while ((n = fread(data, 1, sizeof(data), f)) > 0) blake3_hasher_update(&h, data, n);
  if (ferror(f)) { fclose(f); return 4; }
  fclose(f); blake3_hasher_finalize(&h, hash, sizeof(hash));
  for (size_t i = 0; i < sizeof(hash); ++i) printf("%02x", hash[i]);
  return 0;
}
''')
binary = output / "hash-file"
subprocess.run([
    "cc", "-O2", "-DBLAKE3_USE_NEON=0", "-DBLAKE3_NO_SSE2", "-DBLAKE3_NO_SSE41",
    "-DBLAKE3_NO_AVX2", "-DBLAKE3_NO_AVX512", "-I" + str(b3), str(helper),
    *[str(b3 / name) for name in ("blake3.c", "blake3_dispatch.c", "blake3_portable.c")],
    "-o", str(binary),
], check=True)
manifest = {"upstreamCommit": commit, "dataVersion": catalog["v"],
            "catalogSha256": hashlib.sha256(catalog_path.read_bytes()).hexdigest(), "files": []}
for name in ("World", "WorldCoasts", "Monaco"):
    target = output / (name + ".mwm")
    url = f"https://cdn.organicmaps.app/maps/{catalog['v']}/{name}.mwm"
    if name in ("World", "WorldCoasts"):
        shutil.copyfile(upstream / "data" / target.name, target)
        origin = "pinned upstream data/" + target.name
    else:
        with urllib.request.urlopen(url, timeout=60) as response, target.open("xb") as file:
            shutil.copyfileobj(response, file)
        origin = url
    hash_bytes = bytes.fromhex(subprocess.check_output([str(binary), str(target)], text=True))
    short_hash = base64.b64encode(hash_bytes[:9]).decode()
    if target.stat().st_size != entries[name]["s"] or short_hash != entries[name]["h"]:
        raise SystemExit("Official map size/hash mismatch: " + name)
    manifest["files"].append({"name": target.name, "origin": origin,
                              "bytes": target.stat().st_size, "blake3PrefixBase64": short_hash,
                              "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
with (output / "manifest.json").open("x") as file:
    json.dump(manifest, file, indent=2)
    file.write("\n")
print(json.dumps(manifest, indent=2))
