import json


def open_movies_and_play(ctx, labels):
    call_ok(ctx, "tap", {"tapX": 540, "tapY": 2292})
    call_ok(ctx, "screenshot", {})
    call_ok(ctx, "tap", {"tapX": 540, "tapY": 780})
    call_ok(ctx, "wait-text", {"targetText": labels["mediaItem"], "timeoutSec": 10})
    call_ok(ctx, "tap", {"tapX": 540, "tapY": 616})


def main(ctx):
    labels = ctx.inputs["labels"]
    call_ok(ctx, "launch-app", {"activity": ".StartActivity"})
    call_ok(ctx, "screenshot", {})
    call_ok(ctx, "screenshot", {})
    call_ok(ctx, "tap", {"tapX": 540, "tapY": 2292})
    call_ok(ctx, "screenshot", {})
    call_ok(ctx, "tap", {"tapX": 240, "tapY": 1340})
    call_ok(ctx, "wait-text", {"targetText": labels["emptyDirectory"], "timeoutSec": 8})
    call_ok(ctx, "tap-uia-text", {"text": labels["emptyDirectory"]})
    call_ok(ctx, "wait-text", {"targetText": labels["emptyOrNoResult"], "timeoutSec": 8})
    empty = call_ok(ctx, "uia-tree", {"compact": True, "textFilter": labels["emptyOrNoResult"], "maxNodes": 16})
    empty_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "empty-directory",
        "predicateSummary": "frozen empty-directory label is in the compact uia tree",
        "condition": labels["emptyOrNoResult"] in json.dumps(empty.get("result"), ensure_ascii=False),
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": empty_shot.get("evidence"),
    })
    call_ok(ctx, "tap", {"tapX": 84, "tapY": 204})
    call_ok(ctx, "wait-text", {"targetText": labels["internalStorage"], "timeoutSec": 8})
    call_ok(ctx, "tap", {"tapX": 84, "tapY": 204})
    open_movies_and_play(ctx, labels)
    call_ok(ctx, "tap", {"tapX": 800, "tapY": 684})
    call_ok(ctx, "tap", {"tapX": 975, "tapY": 2274})
    call_ok(ctx, "screenshot", {})
    file_dump = call_ok(ctx, "uia-tree", {"compact": True, "textFilter": labels["mediaFile"], "maxNodes": 16})
    player_dump = call_ok(ctx, "uia-tree", {"compact": True, "textFilter": labels["player"], "maxNodes": 16})
    player_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "player-visible",
        "predicateSummary": "Movies compact UIA shows the fixture file and 音频播放器 after play then pause",
        "condition": labels["mediaFile"] in json.dumps(file_dump.get("result"), ensure_ascii=False) and labels["player"] in json.dumps(player_dump.get("result"), ensure_ascii=False),
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": player_shot.get("evidence"),
    })
    call_ok(ctx, "tap", {"tapX": 84, "tapY": 204})
    call_ok(ctx, "tap", {"tapX": 972, "tapY": 2292})
    call_ok(ctx, "tap", {"tapX": 282, "tapY": 432})
    call_ok(ctx, "wait-text", {"targetText": labels["settingsRestore"], "timeoutSec": 8})
    call_ok(ctx, "tap-uia-text", {"text": labels["settingsRestore"], "exact": True})
    call_ok(ctx, "tap-uia-text", {"text": labels["settingsRestore"], "exact": True})
    settings = call_ok(ctx, "uia-tree", {"compact": True, "textFilter": labels["settingsRestore"], "maxNodes": 16})
    settings_shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "settings-restored",
        "predicateSummary": "frozen settings-restore row is in the compact uia tree after toggle restore",
        "condition": labels["settingsRestore"] in json.dumps(settings.get("result"), ensure_ascii=False),
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": settings_shot.get("evidence"),
    })
    call_ok(ctx, "tap", {"tapX": 84, "tapY": 204})
    ctx.checkpoint("vlc-acceptance", {"done": True})
    return {"passed": True}


def call_ok(ctx, command, args):
    result = ctx.call(command, args)
    if not result or result.get("ok") is False:
        raise RuntimeError(result.get("error") if result else command)
    return result
