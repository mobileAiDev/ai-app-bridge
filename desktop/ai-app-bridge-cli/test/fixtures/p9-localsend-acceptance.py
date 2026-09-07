def main(ctx):
    labels = ctx.inputs["labels"]
    ctx.call("flutter-tree", {})
    if labels.get("skipOnboarding"):
        call_ok(ctx, "tap-flutter-text", {"text": labels["skipOnboarding"]})
        ctx.call("flutter-tree", {})
    call_ok(ctx, "tap-flutter-text", {"text": labels["send"]})
    discovery = call_ok(ctx, "uia-tree", {})
    discovery_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "empty-discovery",
        "predicateSummary": "frozen no-peer label is on the send page",
        "condition": labels["noPeer"] in uia_xml(discovery),
        "requiredEvidence": ["tree"],
        "requireCoverage": "complete",
        "evidence": discovery.get("evidence"),
    })
    call_ok(ctx, "tap-flutter-text", {"text": labels["settings"]})
    call_ok(ctx, "tap-flutter-text", {"text": labels["receive"]})
    call_ok(ctx, "tap-flutter-text", {"text": labels["settings"]})
    call_ok(ctx, "scroll-flutter", {"targetText": labels["about"]})
    call_ok(ctx, "tap-flutter-text", {"text": labels["aboutOpen"]})
    about = call_ok(ctx, "flutter-tree", {})
    about_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "about-visible",
        "predicateSummary": "frozen about label is on the flutter tree",
        "condition": labels["about"] in collect_flutter_texts(about.get("result")),
        "requiredEvidence": ["tree"],
        "requireCoverage": "complete",
        "evidence": about.get("evidence"),
    })
    call_ok(ctx, "tap-flutter-text", {"text": labels["back"]})
    call_ok(ctx, "tap-flutter-text", {"text": labels["send"]})
    call_ok(ctx, "tap-uia-text", {"text": labels["fileSelect"]})
    call_ok(ctx, "tap-uia-text", {"text": labels["cancel"]})
    call_ok(ctx, "tap-uia-text", {"text": labels["settings"]})
    call_ok(ctx, "wait-text", {"targetText": labels["theme"], "timeoutSec": 8})
    tap_theme_value(ctx, labels)
    call_ok(ctx, "wait-text", {"targetText": labels["themeLight"], "timeoutSec": 8})
    call_ok(ctx, "tap-uia-text", {"text": labels["themeLight"]})
    call_ok(ctx, "tap-uia-text", {"text": labels["themeLight"]})
    call_ok(ctx, "tap-uia-text", {"text": labels["themeRestore"]})
    tap_last_uia(ctx, labels["themeRestore"])
    call_ok(ctx, "wait-text", {"targetText": labels["language"], "timeoutSec": 8})
    language_page = call_ok(ctx, "uia-tree", {})
    language_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "language-page",
        "predicateSummary": "frozen language page title is on the uia tree",
        "condition": labels["language"] in uia_xml(language_page),
        "requiredEvidence": ["tree"],
        "requireCoverage": "complete",
        "evidence": language_page.get("evidence"),
    })
    call_ok(ctx, "tap-uia-text", {"text": labels["languageEnglish"]})
    call_ok(ctx, "wait-text", {"targetText": labels["languageRestoreEn"], "timeoutSec": 8})
    call_ok(ctx, "tap-uia-text", {"text": labels["languageRestoreEn"]})
    call_ok(ctx, "wait-text", {"targetText": labels["language"], "timeoutSec": 8})
    call_ok(ctx, "tap-uia-text", {"text": labels["back"]})
    call_ok(ctx, "tap-uia-text", {"text": labels["receive"]})
    call_ok(ctx, "tap-uia-text", {"text": labels["settings"]})
    restored = call_ok(ctx, "uia-tree", {})
    call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "theme-language-restored",
        "predicateSummary": "settings is restored after theme and language cycle",
        "condition": settings_restored(uia_xml(restored), labels),
        "requiredEvidence": ["tree"],
        "requireCoverage": "complete",
        "evidence": restored.get("evidence"),
    })
    call_ok(ctx, "tap-uia-text", {"text": labels["receive"]})
    call_ok(ctx, "tap-uia-text", {"text": labels["settings"]})
    call_ok(ctx, "tap-uia-text", {"text": labels["send"]})
    call_ok(ctx, "tap-uia-text", {"text": labels["receive"]})
    ctx.checkpoint("localsend-acceptance", {"done": True})
    return {"completed": True}


def call_ok(ctx, command, args):
    result = ctx.call(command, args)
    if not result or result.get("ok") is False:
        raise RuntimeError(result.get("error") if result else command)
    return result


def collect_flutter_texts(tree):
    found = []
    if not tree:
        return found
    operable = tree.get("operable") if isinstance(tree, dict) else None
    if isinstance(operable, dict) and isinstance(operable.get("nodes"), list):
        for node in operable.get("nodes"):
            if isinstance(node, dict) and isinstance(node.get("text"), str):
                found.append(node.get("text"))
    walk_flutter(tree.get("root") if isinstance(tree, dict) else tree, found)
    if isinstance(tree, dict) and isinstance(tree.get("nodes"), list):
        for node in tree.get("nodes"):
            walk_flutter(node, found)
    return found


def walk_flutter(node, found):
    if not isinstance(node, dict):
        return
    if isinstance(node.get("text"), str):
        found.append(node.get("text"))
    for child in node.get("children") or []:
        walk_flutter(child, found)


def uia_xml(dump):
    if not isinstance(dump, dict):
        return ""
    result = dump.get("result")
    if isinstance(result, str):
        return result
    if isinstance(result, dict) and isinstance(result.get("result"), str):
        return result.get("result")
    return ""


def uia_buttons(xml):
    found = []
    start = 0
    text = str(xml)
    while True:
        open_at = text.find("<node", start)
        if open_at < 0:
            return found
        close_at = text.find(">", open_at)
        if close_at < 0:
            return found
        tag = text[open_at:close_at + 1]
        start = close_at + 1
        if "android.widget.Button" not in tag:
            continue
        desc_at = tag.find('content-desc="')
        bounds_at = tag.find('bounds="[')
        if desc_at < 0 or bounds_at < 0:
            continue
        desc_end = tag.find('"', desc_at + 14)
        bounds_end = tag.find('"', bounds_at + 8)
        if desc_end < 0 or bounds_end < 0:
            continue
        desc = tag[desc_at + 14:desc_end].replace("&#10;", "\n")
        parts = tag[bounds_at + 8:bounds_end].strip("[]").replace("][", ",").split(",")
        if len(parts) != 4:
            continue
        found.append({
            "desc": desc,
            "x": round((int(parts[0]) + int(parts[2])) / 2),
            "y": round((int(parts[1]) + int(parts[3])) / 2),
        })


def tap_theme_value(ctx, labels):
    dump = call_ok(ctx, "uia-tree", {})
    values = {labels["themeRestore"], labels["themeLight"], labels["themeDark"]}
    chosen = None
    for node in uia_buttons(uia_xml(dump)):
        if node["desc"] in values:
            chosen = node
            break
    if chosen is None:
        raise RuntimeError("theme_value_not_found")
    call_ok(ctx, "tap", {"tapX": chosen["x"], "tapY": chosen["y"]})


def tap_last_uia(ctx, text):
    dump = call_ok(ctx, "uia-tree", {})
    chosen = None
    for node in uia_buttons(uia_xml(dump)):
        if node["desc"] == text:
            chosen = node
    if chosen is None:
        raise RuntimeError("last_uia_not_found:" + text)
    call_ok(ctx, "tap", {"tapX": chosen["x"], "tapY": chosen["y"]})


def settings_restored(xml, labels):
    if not all(labels[key] in xml for key in ["settings", "theme", "language"]):
        return False
    values = [button["desc"] for button in uia_buttons(xml)]
    required = [labels["themeRestore"], labels["languageRestore"]]
    return all(values.count(value) >= required.count(value) for value in required)
