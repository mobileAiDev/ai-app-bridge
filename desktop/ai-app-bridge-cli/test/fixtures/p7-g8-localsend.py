def main(ctx):
    ctx.call("flutter-tree", {})
    ctx.call("tap-flutter-text", {"text": "设置"})
    ctx.call("flutter-tree", {})
    ctx.call("tap-flutter-text", {"text": "发送"})
    ctx.call("flutter-tree", {})
    ctx.call("tap-flutter-text", {"text": "接收"})
    after = ctx.call("flutter-tree", {})
    texts = collect_texts(after.get("result"))
    ctx.assert_({
        "name": "settings-visible",
        "predicateSummary": "设置 is on the tree",
        "condition": "设置" in texts,
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": after.get("evidence"),
    })
    ctx.checkpoint("g8-done", {"done": True})
    return {"passed": "设置" in texts}


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
