#!/usr/bin/env python3
"""Apply the two-file Bridge integration to the pinned Kiwix source."""
import hashlib
import json
from pathlib import Path

SAMPLE = Path(__file__).resolve().parent
UPSTREAM = SAMPLE / "upstream"


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise SystemExit(f"Pinned upstream anchor changed: {old!r}")
    return source.replace(old, new, 1)


def main():
    edits = {}
    project = UPSTREAM / "project.yml"
    original = project.read_text()
    changed = replace_once(original, "packages:\n", "packages:\n  AiAppBridgeIOS:\n    path: ../../../ios/ai-app-bridge-ios\n")
    changed = replace_once(changed, "      - package: Defaults\n", "      - package: AiAppBridgeIOS\n        destinationFilters: [iOS]\n      - package: Defaults\n")
    changed = replace_once(changed, "    sources:\n      - path: Support\n", "      configs:\n        Debug:\n          PRODUCT_BUNDLE_IDENTIFIER: io.github.mobileaidev.kiwix.sample\n          INFOPLIST_KEY_CFBundleDisplayName: Kiwix Bridge\n    sources:\n      - path: Support\n")
    edits[project] = (original, changed)

    app = UPSTREAM / "App/App_iOS.swift"
    original = app.read_text()
    changed = replace_once(original, "#if os(iOS)\n@main", "#if os(iOS)\n#if DEBUG\nimport AiAppBridgeIOS\n#endif\n@main")
    changed = replace_once(changed, "    init() {\n", "    init() {\n        #if DEBUG\n        AiAppBridge.shared.start(appName: \"kiwix_bridge_sample\")\n        #endif\n")
    edits[app] = (original, changed)

    report = SAMPLE / "build/integration.json"
    report.parent.mkdir(exist_ok=True)
    with report.open("x") as out:
        json.dump({"source": json.loads((SAMPLE / "source.json").read_text()), "files": [
            {"path": str(path.relative_to(UPSTREAM)),
             "beforeSha256": hashlib.sha256(before.encode()).hexdigest(),
             "afterSha256": hashlib.sha256(after.encode()).hexdigest()}
            for path, (before, after) in edits.items()
        ]}, out, indent=2)
    for path, (_, after) in edits.items():
        path.write_text(after)
    print(report)


if __name__ == "__main__":
    main()
