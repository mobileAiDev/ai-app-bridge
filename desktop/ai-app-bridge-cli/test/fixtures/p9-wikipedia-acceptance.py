def main(ctx):
    labels = ctx.inputs["labels"]
    call_ok(ctx, "wait-text", {"targetText": labels["home"], "timeoutSec": 8, "requireActivity": "MainActivity"})
    call_ok(ctx, "tap", {"tapX": 540, "tapY": 2256})
    call_ok(ctx, "tap-text", {"text": labels["searchField"]})
    call_ok(ctx, "wait-text", {"targetText": labels["back"], "timeoutSec": 8})
    call_ok(ctx, "input-text", {"text": labels["noResultQuery"], "tapX": 621, "tapY": 215})
    call_ok(ctx, "wait-text", {"targetText": labels["noResultQuery"], "timeoutSec": 8})
    call_ok(ctx, "hide-keyboard", {})
    call_ok(ctx, "wait-text", {"targetText": labels["noResult"], "timeoutSec": 15})
    empty = call_ok(ctx, "uia-tree", {"compact": True, "textFilter": labels["noResult"], "maxNodes": 16})
    empty_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "no-result",
        "predicateSummary": "frozen no-result label is in the compact uia tree",
        "condition": compact_has_text(empty, labels["noResult"]),
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": empty_shot.get("evidence"),
    })
    call_ok(ctx, "tap-uia-text", {"text": labels["clearQuery"]})
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
    call_ok(ctx, "wait-text", {"targetText": labels["readingList"], "timeoutSec": 8})
    call_ok(ctx, "tap-text", {"text": labels["readingList"]})
    listed = ctx.call("wait-text", {"targetText": labels["testList"], "timeoutSec": 4})
    if not listed or listed.get("ok") is False:
        call_ok(ctx, "wait-text", {"targetText": labels["readingListSheet"], "timeoutSec": 8})
        call_ok(ctx, "tap-uia-text", {"text": labels["readingListSheet"]})
        call_ok(ctx, "wait-text", {"targetText": labels["listNameField"], "timeoutSec": 8})
        call_ok(ctx, "input-text", {"text": labels["testList"]})
        call_ok(ctx, "tap-uia-text", {"text": labels["confirm"]})
        call_ok(ctx, "wait-text", {"targetText": labels["savedToList"], "timeoutSec": 8})
    else:
        call_ok(ctx, "tap-uia-text", {"text": labels["testList"]})
    call_ok(ctx, "wait-text", {"targetText": labels["savedToList"], "timeoutSec": 8})
    call_ok(ctx, "tap-text", {"text": labels["readingList"]})
    call_ok(ctx, "wait-text", {"targetText": labels["testList"], "timeoutSec": 8})
    test_list_dump = call_ok(ctx, "uia-tree", {"compact": True, "textFilter": labels["testList"], "maxNodes": 16})
    sheet_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "reading-list-sheet",
        "predicateSummary": "test collection p9-test is in the compact uia tree after opening the reading list",
        "condition": compact_has_text(test_list_dump, labels["testList"]),
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": sheet_shot.get("evidence"),
    })
    call_ok(ctx, "tap-uia-text", {"text": labels["testList"]})
    call_ok(ctx, "wait-text", {"targetText": labels["readingList"], "timeoutSec": 8})
    call_ok(ctx, "tap-text", {"text": labels["theme"]})
    call_ok(ctx, "wait-text", {"targetText": labels["themeRestore"], "timeoutSec": 8})
    call_ok(ctx, "tap-uia-text", {"text": labels["themeRestore"]})
    call_ok(ctx, "tap", {"tapX": 315, "tapY": 1965})
    call_ok(ctx, "tap-uia-text", {"text": labels["themeRestore"]})
    call_ok(ctx, "tap", {"tapX": 84, "tapY": 216})
    call_ok(ctx, "wait-text", {"targetText": labels["language"], "timeoutSec": 8})
    call_ok(ctx, "tap-text", {"text": labels["language"]})
    call_ok(ctx, "wait-text", {"targetText": labels["languageLinksTitle"], "timeoutSec": 8})
    call_ok(ctx, "wait-text", {"targetText": labels["languagePage"], "timeoutSec": 60, "intervalMs": 3000})
    call_ok(ctx, "wait-text", {"targetText": labels["languageSwitch"], "timeoutSec": 10})
    call_ok(ctx, "tap-uia-text", {"text": labels["languageSwitch"], "exact": True})
    call_ok(ctx, "wait-text", {"targetText": labels["switchedTitle"], "timeoutSec": 60})
    call_ok(ctx, "wait-text", {"targetText": labels["toc"], "timeoutSec": 15})
    switched = call_ok(ctx, "uia-tree", {"compact": True, "textFilter": labels["switchedTitle"], "maxNodes": 16})
    switched_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "language-switched",
        "predicateSummary": "Afrikaans Moon title is in the compact uia tree after language switch",
        "condition": compact_has_text(switched, labels["switchedTitle"]),
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": switched_shot.get("evidence"),
    })
    call_ok(ctx, "tap-uia-text", {"text": labels["back"]})
    call_ok(ctx, "wait-text", {
        "targetText": labels["articleTitle"],
        "absentText": labels["switchedTitle"],
        "timeoutSec": 60,
        "requireActivity": "PageActivity",
    })
    call_ok(ctx, "swipe", {"startX": 540, "startY": 400, "endX": 540, "endY": 1400, "durationMs": 400})
    call_ok(ctx, "swipe", {"startX": 540, "startY": 400, "endX": 540, "endY": 1400, "durationMs": 400})
    restored = call_ok(ctx, "uia-tree", {
        "compact": True,
        "textFilter": labels["articleTitle"],
        "visibleOnly": True,
        "maxNodes": 16,
    })
    restored_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "theme-language-restored",
        "predicateSummary": "visible Chinese article text is in compact uia nodes after theme cycle and back-stack language restore",
        "condition": compact_has_text(restored, labels["articleTitle"]),
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": restored_shot.get("evidence"),
    })
    call_ok(ctx, "tap-uia-text", {"text": labels["back"]})
    call_ok(ctx, "wait-text", {"targetText": labels["resultMarker"], "timeoutSec": 8, "requireActivity": "SearchActivity"})
    left_article = call_ok(ctx, "uia-tree", {"compact": True, "textFilter": labels["resultMarker"], "maxNodes": 16})
    left_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "left-article-search",
        "predicateSummary": "search result marker is in the compact uia tree after leaving PageActivity",
        "condition": compact_has_text(left_article, labels["resultMarker"]),
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": left_shot.get("evidence"),
    })
    call_ok(ctx, "tap-text", {"text": labels["back"]})
    call_ok(ctx, "wait-text", {"targetText": labels["home"], "timeoutSec": 8})
    call_ok(ctx, "tap-text", {"text": labels["more"]})
    call_ok(ctx, "wait-text", {"targetText": labels["settings"], "timeoutSec": 8})
    call_ok(ctx, "tap-text", {"text": labels["settings"]})
    call_ok(ctx, "wait-text", {"targetText": labels["settingsTheme"], "timeoutSec": 8})
    settings = call_ok(ctx, "tree", {})
    settings_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "settings-visible",
        "predicateSummary": "frozen settings theme row is on the tree",
        "condition": labels["settingsTheme"] in collect_texts(settings.get("result")),
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": settings_shot.get("evidence"),
    })
    call_ok(ctx, "tap-text", {"text": labels["back"]})
    call_ok(ctx, "wait-text", {"targetText": labels["home"], "timeoutSec": 8})
    call_ok(ctx, "tap", {"tapX": 540, "tapY": 2256})
    call_ok(ctx, "tap-text", {"text": labels["searchField"]})
    call_ok(ctx, "input-text", {"text": labels["articleTitle"], "tapX": 621, "tapY": 215})
    call_ok(ctx, "hide-keyboard", {})
    call_ok(ctx, "wait-text", {"targetText": labels["resultMarker"], "timeoutSec": 8})
    call_ok(ctx, "tap", {"tapX": 540, "tapY": 590})
    call_ok(ctx, "wait-text", {"targetText": labels["toc"], "timeoutSec": 8})
    call_ok(ctx, "tap-uia-text", {"text": labels["back"]})
    call_ok(ctx, "wait-text", {"targetText": labels["resultMarker"], "timeoutSec": 8, "requireActivity": "SearchActivity"})
    repeat_left = call_ok(ctx, "uia-tree", {"compact": True, "textFilter": labels["resultMarker"], "maxNodes": 16})
    repeat_left_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "repeat-left-article-search",
        "predicateSummary": "search result marker is in the compact uia tree after the repeat article back",
        "condition": compact_has_text(repeat_left, labels["resultMarker"]),
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": repeat_left_shot.get("evidence"),
    })
    ctx.checkpoint("wikipedia-acceptance", {"done": True})
    return {"passed": True}


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
