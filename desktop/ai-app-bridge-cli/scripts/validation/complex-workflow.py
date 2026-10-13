"""The same native business regression as complex-workflow.js, in real Python."""
import json
import time
from pathlib import Path


def main(ctx):
    began = time.monotonic()
    steps, checks, expected_failures = [], [], []
    phase, state, error = "start", None, None

    def raw(command, args=None):
        started = time.monotonic()
        result = ctx.call(command, args or {})
        steps.append({"phase": phase, "command": command, "ms": round((time.monotonic() - started) * 1000),
                      "ok": result["ok"], "error": result.get("error"), "dispatched": result.get("dispatched")})
        return result

    def call(command, args=None):
        result = raw(command, args)
        if not result["ok"] or result.get("ambiguous"):
            raise RuntimeError(f"{phase}: {command}: {result.get('error')}")
        return result["result"]

    def check(name, condition):
        result = ctx.assert_({"scope": "code", "name": name, "condition": condition})
        checks.append({"name": name, "verdict": result["verdict"]})
        if result["verdict"] != "passed":
            raise AssertionError(name)

    def tap(description):
        return call("tap-native", {"selector": {"contentDescription": description}})

    def enter(description, value):
        return call("input-text", {"selector": {"contentDescription": description}, "text": value, "hideKeyboard": True})

    def wait(text):
        return call("wait-text", {"provider": "native", "targetText": text, "timeoutMs": 6000, "intervalMs": 50})

    try:
        call("adb-exec", {"argv": ["shell", "am", "force-stop", ctx.target["packageName"]]})
        call("launch-activity", {"activity": ".ComplexWorkflowFixtureActivity"})
        wait("巡检工作台")
        phase = "query-and-disambiguate"
        tap("workflow_tasks")
        enter("workflow_query", "巡检")
        tap("workflow_search")
        wait("查询完成")
        call("tap-native", {"selector": {"text": "打开", "within": {"text": "WO-102", "ancestor": {"contentDescription": "work_order_row"}}}})
        wait("工单详情 WO-102")
        phase = "stale-reference-recovery"
        nodes = call("tree", {"compact": True, "visibleOnly": True, "maxNodes": 300})["nodes"]
        old_edit = next(node for node in nodes if node.get("contentDescription") == "workflow_edit")
        tap("workflow_refresh")
        stale = raw("tap-native", {"selector": old_edit["selector"]})
        check("Replaced view is not dispatched", not stale["ok"] and stale.get("dispatched") is False and not stale.get("ambiguous"))
        expected_failures.append({"phase": phase, "error": stale.get("error"), "dispatched": stale.get("dispatched")})
        tap("workflow_edit")
        phase = "cancel-and-form-validation"
        tap("workflow_cancel_edit")
        tap("workflow_edit")
        tap("workflow_review")
        wait("负责人和记录不能为空")
        enter("workflow_assignee", "测试员")
        enter("workflow_remark", "已完成现场巡检")
        tap("workflow_priority")
        tap("workflow_review")
        wait("确认巡检结果")
        call("tap-native", {"selector": {"text": "返回修改"}})
        tap("workflow_review")
        phase = "submit-and-recover"
        call("tap-native", {"selector": {"text": "确认", "className": "android.widget.Button"}})
        wait("服务暂时不可用，本次未保存")
        tap("workflow_retry")
        wait("巡检已保存")
        phase = "cross-window-navigation"
        tap("workflow_history")
        wait("已保存 1 条 · WO-102")
        tap("workflow_history_return")
        phase = "settings"
        tap("workflow_settings")
        tap("workflow_notifications")
        tap("workflow_save_settings")
        wait("巡检工作台")
        phase = "independent-verification"
        state = json.loads(call("adb-exec", {"argv": ["shell", "run-as", ctx.target["packageName"], "cat", "files/complex-workflow.json"], "readOnly": True})["stdout"])
        conditions = {
            "correctRecord": state["selectedId"] == "WO-102",
            "savedExactlyOnce": state["savedCount"] == 1 and state["submitAttempts"] == 2,
            "inputPreserved": state["assignee"] == "测试员" and state["remark"] == "已完成现场巡检" and state["priority"],
            "cancelledAndValidated": state["cancelledDrafts"] == 1 and state["validationErrors"] == 1,
            "settingsPersisted": state["notifications"] and state["settingsSaved"] == 1,
            "noBackgroundAction": state["backgroundConfirms"] == 0,
            "historyReturned": state["historyReturns"] == 1,
            "allPages": all(page in state["visits"] for page in ["loading", "dashboard", "tasks", "detail", "edit", "review", "submitting", "retry", "receipt", "history", "settings"]),
        }
        for name, condition in conditions.items():
            check(name, condition)
    except Exception as exception:
        error = str(exception)
    elapsed = round((time.monotonic() - began) * 1000)
    report = {"ok": error is None, "mode": "python", "elapsedMs": elapsed, "withinMinute": elapsed <= 60000,
              "phase": phase, "error": error, "calls": len(steps), "expectedFailures": expected_failures,
              "checks": checks, "pages": state["visits"] if state else []}
    if ctx.inputs.get("outDir"):
        Path(ctx.inputs["outDir"], "details.json").write_text(json.dumps({"report": report, "steps": steps, "state": state}, ensure_ascii=False, indent=2))
    return report
