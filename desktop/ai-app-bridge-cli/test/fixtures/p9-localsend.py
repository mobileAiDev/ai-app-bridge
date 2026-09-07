def main(ctx):
    labels = ctx.inputs["labels"]
    ctx.call("flutter-tree", {})
    if labels.get("skipOnboarding"):
        ctx.call("tap-flutter-text", {"text": labels["skipOnboarding"]})
        ctx.call("flutter-tree", {})
    ctx.call("tap-flutter-text", {"text": labels["settings"]})
    ctx.call("flutter-tree", {})
    ctx.call("tap-flutter-text", {"text": labels["receive"]})
    ctx.call("flutter-tree", {})
    ctx.call("tap-flutter-text", {"text": labels["settings"]})
    ctx.call("flutter-tree", {})
    ctx.call("scroll-flutter", {"targetText": labels["about"]})
    ctx.call("tap-flutter-text", {"text": labels["aboutOpen"]})
    about = ctx.call("flutter-tree", {})
    texts = collect_texts(about.get("result"))
    shot = ctx.call("screenshot", {})
    ctx.assert_({
        "name": "about-visible",
        "predicateSummary": "frozen about label is on the tree",
        "condition": labels["about"] in texts,
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": shot.get("evidence"),
    })
    ctx.call("tap-flutter-text", {"text": labels["back"]})
    ctx.call("tap-flutter-text", {"text": labels["receive"]})
    ctx.checkpoint("localsend-core", {"done": True})
    return {"passed": labels["about"] in texts}


def collect_texts(tree):
    found = []
    if not isinstance(tree, dict):
        return found
    operable = tree.get("operable") or {}
    nodes = operable.get("nodes")
    if isinstance(nodes, list):
        for node in nodes:
            text = node.get("text") if isinstance(node, dict) else None
            if isinstance(text, str):
                found.append(text)
        return found
    walk(tree.get("root") or tree, found)
    for node in tree.get("nodes") or []:
        walk(node, found)
    return found


def walk(node, found):
    if not node:
        return
    text = node.get("text")
    if isinstance(text, str):
        found.append(text)
    for child in node.get("children") or []:
        walk(child, found)
