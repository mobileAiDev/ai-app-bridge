import json


def open_movies_and_play(ctx, labels):
    call_ok(ctx, "tap", {"tapX": 540, "tapY": 2292})
    call_ok(ctx, "screenshot", {})
    call_ok(ctx, "tap", {"tapX": 540, "tapY": 780})
    call_ok(ctx, "wait-text", {"targetText": labels["mediaItem"], "timeoutSec": 10})
    call_ok(ctx, "tap", {"tapX": 540, "tapY": 616})


def pause_and_assert_player(ctx, labels):
    call_ok(ctx, "tap", {"tapX": 800, "tapY": 684})
    call_ok(ctx, "tap", {"tapX": 975, "tapY": 2274})
    call_ok(ctx, "screenshot", {})
    file_dump = call_ok(ctx, "uia-tree", {"compact": True, "textFilter": labels["mediaFile"], "maxNodes": 16})
    player_dump = call_ok(ctx, "uia-tree", {"compact": True, "textFilter": labels["player"], "maxNodes": 16})
    shot = call_ok(ctx, "screenshot", {})
    ctx.assert_({
        "name": "player-visible",
        "predicateSummary": "Movies compact UIA shows the fixture file and 音频播放器 after play then pause",
        "condition": labels["mediaFile"] in json.dumps(file_dump.get("result"), ensure_ascii=False) and labels["player"] in json.dumps(player_dump.get("result"), ensure_ascii=False),
        "requiredEvidence": [],
        "requireCoverage": "complete",
        "evidence": shot.get("evidence"),
    })


def main(ctx):
    labels = ctx.inputs["labels"]
    call_ok(ctx, "launch-app", {"activity": ".StartActivity"})
    call_ok(ctx, "screenshot", {})
    call_ok(ctx, "screenshot", {})
    open_movies_and_play(ctx, labels)
    pause_and_assert_player(ctx, labels)
    ctx.checkpoint("vlc-core", {"done": True})
    return {"passed": True}


def call_ok(ctx, command, args):
    result = ctx.call(command, args)
    if not result or result.get("ok") is False:
        raise RuntimeError(result.get("error") if result else command)
    return result
