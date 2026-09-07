def main(ctx):
    tree = ctx.call("tree", {})
    texts = collect_texts(tree.get("result"))
    ctx.checkpoint("after-tree", {"step": 1})
    tap = ctx.call("tap-text", {"text": "About"})
    after = ctx.call("tree", {})
    verdict = ctx.assert_({
        "name": "license-visible",
        "predicateSummary": "License Notices is on the tree",
        "condition": "License Notices" in collect_texts(after.get("result")),
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": after.get("evidence"),
    })
    return {
        "passed": verdict.get("verdict") == "passed",
        "tapped": tap.get("execution", {}).get("actionId"),
        "sawAbout": "About" in texts,
    }


def collect_texts(tree):
    found = []
    walk(tree.get("root") if isinstance(tree, dict) else None, found)
    return found


def walk(node, found):
    if not node:
        return
    text = node.get("text")
    if isinstance(text, str):
        found.append(text)
    for child in node.get("children") or []:
        walk(child, found)
