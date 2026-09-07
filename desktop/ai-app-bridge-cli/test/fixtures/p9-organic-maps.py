import re

UIA_ATTR = re.compile(r'(?:text|content-desc)="([^"]+)"')
BOUNDS = re.compile(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')


def main(ctx):
    labels = ctx.inputs["labels"]
    ctx.call("uia-tree", {})
    if labels.get("skipOnboarding"):
        ctx.call("tap-uia-text", {"text": labels["skipOnboarding"]})
        ctx.call("uia-tree", {})
    ctx.call("tap-uia-text", {"text": frozen_text(labels, "search")})
    type_into_search(ctx, frozen_text(labels, "poi"))
    tap_poi_title(ctx, frozen_text(labels, "poi"))
    detail = ctx.call("uia-tree", {})
    shot = ctx.call("screenshot", {})
    texts = collect_texts(detail.get("result"))
    ctx.assert_({
        "name": "poi-visible",
        "predicateSummary": "frozen POI is on the tree",
        "condition": poi_visible(texts, labels),
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": shot.get("evidence"),
    })
    tap_if_frozen(ctx, labels, "bookmark")
    tap_if_frozen(ctx, labels, "route")
    tap_if_frozen(ctx, labels, "routeDownloadLater")
    tap_if_frozen(ctx, labels, "cancel")
    ctx.checkpoint("organic-maps-core", {"done": True})
    return {"passed": True}


def tap_poi_title(ctx, name):
    dump = ctx.call("uia-tree", {})
    title = find_title_below_overlay(uia_xml(dump), name)
    if title is None:
        raise RuntimeError("poi_title_not_found")
    ctx.call("tap", {"tapX": title["tapX"], "tapY": title["tapY"]})
    ctx.call("uia-tree", {})


def find_title_below_overlay(xml, name):
    overlay_bottom = 0
    titles = []
    start = 0
    text = str(xml)
    while True:
        open_at = text.find("<node", start)
        if open_at < 0:
            break
        close_at = text.find(">", open_at)
        if close_at < 0:
            break
        tag = text[open_at:close_at + 1]
        start = close_at + 1
        rid_at = tag.find('resource-id="')
        text_at = tag.find('text="')
        match = BOUNDS.search(tag)
        if match is None:
            continue
        top = int(match.group(2))
        bottom = int(match.group(4))
        rid = ""
        if rid_at >= 0:
            rid_end = tag.find('"', rid_at + 13)
            if rid_end > rid_at:
                rid = tag[rid_at + 13:rid_end]
        node_text = ""
        if text_at >= 0:
            text_end = tag.find('"', text_at + 6)
            if text_end > text_at:
                node_text = tag[text_at + 6:text_end]
        if rid.endswith("id/downloader_button"):
            overlay_bottom = bottom
        if rid.endswith("id/title") and name in node_text:
            titles.append({
                "tapX": round((int(match.group(1)) + int(match.group(3))) / 2),
                "tapY": round((top + bottom) / 2),
                "top": top,
            })
    for item in titles:
        if item["top"] > overlay_bottom:
            return item
    return None


def type_into_search(ctx, query):
    dump = ctx.call("uia-tree", {})
    field = find_edit(uia_xml(dump))
    if field is None:
        raise RuntimeError("search_edit_not_found")
    ctx.call("tap", {"tapX": field["tapX"], "tapY": field["tapY"]})
    ctx.call("input-text", {"text": query})


def find_edit(xml):
    start = 0
    text = str(xml)
    while True:
        open_at = text.find("<node", start)
        if open_at < 0:
            return None
        close_at = text.find(">", open_at)
        if close_at < 0:
            return None
        tag = text[open_at:close_at + 1]
        start = close_at + 1
        if "EditText" not in tag:
            continue
        match = BOUNDS.search(tag)
        if not match:
            continue
        return {
            "tapX": round((int(match.group(1)) + int(match.group(3))) / 2),
            "tapY": round((int(match.group(2)) + int(match.group(4))) / 2),
        }


def uia_xml(dump):
    if isinstance(dump, str):
        return dump
    if not isinstance(dump, dict):
        return ""
    result = dump.get("result")
    if isinstance(result, str):
        return result
    if isinstance(result, dict) and isinstance(result.get("result"), str):
        return result.get("result")
    return ""


def tap_if_frozen(ctx, labels, key):
    value = labels.get(key)
    if not isinstance(value, str) or len(value) == 0:
        return
    ctx.call("tap-uia-text", {"text": value})


def frozen_text(labels, key):
    value = labels.get(key)
    if not isinstance(value, str) or len(value) == 0:
        raise RuntimeError(f"label_not_frozen:{key}")
    return value


def poi_visible(texts, labels):
    has_poi = any(labels["poi"] in text for text in texts)
    has_place = (
        labels["bookmark"] in texts
        or labels["bookmarkDelete"] in texts
        or labels["route"] in texts
    )
    return has_poi and has_place


def collect_texts(tree):
    xml = tree if isinstance(tree, str) else uia_xml({"result": tree})
    if xml.startswith("<") or "<hierarchy" in xml or "<node" in xml:
        return UIA_ATTR.findall(xml)
    found = []
    if not isinstance(tree, dict):
        return found
    walk(tree.get("root"), found)
    return found


def walk(node, found):
    if not node:
        return
    text = node.get("text")
    if isinstance(text, str):
        found.append(text)
    for child in node.get("children") or []:
        walk(child, found)
