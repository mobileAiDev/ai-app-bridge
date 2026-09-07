def main(ctx):
    labels = ctx.inputs["labels"]
    call_ok(ctx, "wait-text", {"targetText": labels["home"], "timeoutSec": 8, "requireActivity": "MainActivity"})
    call_ok(ctx, "tap", {"tapX": 540, "tapY": 2256})
    call_ok(ctx, "tap-text", {"text": labels["searchField"]})
    call_ok(ctx, "wait-text", {"targetText": labels["searchField"], "timeoutSec": 8})
    call_ok(ctx, "input-text", {"text": labels["articleTitle"], "tapX": 621, "tapY": 215})
    call_ok(ctx, "hide-keyboard", {})
    call_ok(ctx, "wait-text", {"targetText": labels["resultMarker"], "timeoutSec": 8})
    call_ok(ctx, "tap", {"tapX": 540, "tapY": 590})
    call_ok(ctx, "wait-text", {"targetText": labels["toc"], "timeoutSec": 8})
    article_title = call_ok(ctx, "uia-tree", {"compact": True, "textFilter": labels["articleTitle"], "maxNodes": 16})
    article_toc = call_ok(ctx, "uia-tree", {"compact": True, "textFilter": labels["toc"], "maxNodes": 16})
    article_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "article-visible",
        "predicateSummary": "frozen article title and TOC chrome are in the compact uia tree",
        "condition": compact_has_text(article_title, labels["articleTitle"]) and compact_has_text(article_toc, labels["toc"]),
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": article_shot.get("evidence"),
    })
    call_ok(ctx, "tap-uia-text", {"text": labels["toc"]})
    call_ok(ctx, "wait-text", {"targetText": labels["tocSection"], "timeoutSec": 8})
    toc = call_ok(ctx, "tree", {})
    toc_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "toc-visible",
        "predicateSummary": "frozen TOC section is on the tree",
        "condition": labels["tocSection"] in collect_texts(toc.get("result")),
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": toc_shot.get("evidence"),
    })
    call_ok(ctx, "tap", {"tapX": 573, "tapY": 570})
    call_ok(ctx, "wait-text", {"targetText": labels["toc"], "timeoutSec": 8})
    call_ok(ctx, "swipe", {"startX": 540, "startY": 400, "endX": 540, "endY": 1400, "durationMs": 400})
    call_ok(ctx, "swipe", {"startX": 540, "startY": 400, "endX": 540, "endY": 1400, "durationMs": 400})
    call_ok(ctx, "tap-text", {"text": labels["back"]})
    call_ok(ctx, "wait-text", {"targetText": labels["resultMarker"], "timeoutSec": 8})
    call_ok(ctx, "tap-text", {"text": labels["back"]})
    call_ok(ctx, "wait-text", {"targetText": labels["home"], "timeoutSec": 8})
    call_ok(ctx, "tap-text", {"text": labels["more"]})
    call_ok(ctx, "wait-text", {"targetText": labels["settings"], "timeoutSec": 8})
    call_ok(ctx, "tap-text", {"text": labels["settings"]})
    call_ok(ctx, "wait-text", {"targetText": labels["settingsTheme"], "timeoutSec": 8})
    settings = call_ok(ctx, "tree", {})
    texts = collect_texts(settings.get("result"))
    settings_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "settings-visible",
        "predicateSummary": "frozen settings theme row is on the tree",
        "condition": labels["settingsTheme"] in texts,
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": settings_shot.get("evidence"),
    })
    ctx.checkpoint("wikipedia-core", {"done": True})
    return {"passed": labels["settingsTheme"] in texts}


def call_ok(ctx, command, args):
    result = ctx.call(command, args)
    if not result or result.get("ok") is False:
        raise RuntimeError(result.get("error") if result else command)
    return result


def collect_texts(tree):
    found = []
    if not isinstance(tree, dict):
        return found
    walk(tree.get("root"), found)
    return found


def compact_has_text(call_result, expected):
    result = call_result.get("result") if isinstance(call_result, dict) else None
    nodes = result.get("nodes", []) if isinstance(result, dict) else []
    return any(
        isinstance(value, str) and expected in value
        for node in nodes if isinstance(node, dict)
        for value in (node.get("text"), node.get("contentDescription"))
    )


def walk(node, found):
    if not node:
        return
    text = node.get("text")
    if isinstance(text, str):
        found.append(text)
    for child in node.get("children") or []:
        walk(child, found)
