#!/usr/bin/env python3
"""Validate the standalone UIA runtime. This is not acceptance of public command routing."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
import xml.etree.ElementTree as ET


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha(value):
    return hashlib.sha256(value).hexdigest()


def rpc(port, token, payload):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=8)
    try:
        body = encode(payload).encode()
        connection.request("POST", "/v1", body, {"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        response = connection.getresponse()
        return {"httpStatus": response.status, "body": json.loads(response.read())}
    finally:
        connection.close()


def child_submit():
    context = json.load(sys.stdin)
    result = rpc(context["port"], context["token"], context["payload"])
    print(encode(result), flush=True)
    os.kill(os.getpid(), signal.SIGKILL)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", required=True)
    parser.add_argument("--cli", type=Path, required=True)
    parser.add_argument("--jar", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    package = "io.github.mobileaidev.aiappbridge.sample"
    runtime_root = "/data/local/tmp/ai-app-bridge-uia-test-" + str(uuid.uuid4())
    jar_hash = sha(args.jar.read_bytes())
    shutil.copy2(args.jar, args.out / "runtime.jar")
    descriptor, port, dialog = None, None, False
    tracked = []
    report = {"ok": False, "serial": args.serial, "jarSha256": jar_hash, "runtimeRoot": runtime_root,
              "publicRoutesVerified": False, "scope": "standalone-runtime"}
    calls = 0

    def save(name, value):
        (args.out / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

    def adb(*values, check=True):
        return subprocess.run(["adb", "-s", args.serial, *values], capture_output=True, text=True, timeout=20, check=check)

    def cli(name, *values):
        result = subprocess.run(["node", str(args.cli), *values, "--serial", args.serial], capture_output=True, text=True, timeout=25)
        (args.out / (name + ".stdout.json")).write_text(result.stdout)
        (args.out / (name + ".stderr.log")).write_text(result.stderr)
        assert result.returncode == 0, (name, result.returncode, result.stderr)
        data = json.loads(result.stdout)
        assert data.get("ok") is True, (name, data)
        return data

    def counter(name, expected=None):
        data = cli(name, "tree", "--package-name", package, "--compact")
        values = {int(node["text"].split(": ")[1]) for node in data["nodes"]
                  if re.fullmatch(r"Native counter: \d+", node.get("text") or "")}
        assert len(values) == 1, values
        value = values.pop()
        if expected is not None:
            assert value == expected, (name, value, expected)
        return value

    def call(operation, request=None, **fields):
        nonlocal calls
        payload = {"op": operation, **fields}
        if request is not None:
            raw = encode(request)
            payload.update(requestJson=raw, requestSha256=sha(raw.encode()))
        result = rpc(port, descriptor["token"], payload)
        calls += 1
        save(f"rpc-{calls:03d}-{operation}.json", {"request": payload, "response": result})
        return result["body"]

    def make_request(snapshot):
        nodes = [node for node in ET.fromstring(snapshot["xml"]).iter("node")
                 if node.attrib.get("text") == "Native Increment" and node.attrib.get("package") == package]
        assert len(nodes) == 1, len(nodes)
        value = {"schemaVersion": "aab.uia.execution.v1", "bootId": descriptor["bootId"],
                 "runtimeEpoch": descriptor["runtimeEpoch"], "actionId": str(uuid.uuid4()), "timeoutMs": 10000,
                 "clickPolicy": "nearest_clickable_ancestor", "target": {"snapshotId": snapshot["snapshotId"],
                 "ref": nodes[0].attrib["aab-ref"], "selector": {"kind": "text", "value": "Native Increment", "exact": True, "packageName": package}}}
        tracked.append(value)
        return value

    def settled(request):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            result = call("query", request)
            if result.get("settled") is True:
                raw = result["receiptJson"]
                assert sha(raw.encode()) == result["receiptSha256"]
                receipt = json.loads(raw)
                for key in ("actionId", "bootId", "runtimeEpoch"):
                    assert receipt[key] == request[key]
                assert receipt["requestSha256"] == sha(encode(request).encode())
                assert receipt["settled"] is True and receipt["ambiguous"] is False
                return receipt, result
            time.sleep(0.04)
        raise AssertionError("original action did not settle")

    try:
        manufacturer = adb("shell", "getprop ro.product.manufacturer").stdout.strip()
        assert manufacturer.lower() == "oppo", manufacturer
        report["bootId"] = adb("shell", "cat /proc/sys/kernel/random/boot_id").stdout.strip()
        report["apiLevel"] = int(adb("shell", "getprop ro.build.version.sdk").stdout.strip())
        owner = cli("ownership-before", "device-ownership", "--operation", "status")
        assert owner["active"] == 0
        before = counter("sdk-before")
        report["counterBefore"] = before
        apk = adb("shell", "pm path " + package).stdout.strip()
        assert apk.startswith("package:") and "\n" not in apk, apk
        report["installedApkSha256"] = adb("shell", "sha256sum " + apk[len("package:"):]).stdout.split()[0]
        adb("shell", "umask 077; mkdir " + runtime_root)
        adb("push", str(args.jar), runtime_root + "/runtime.jar")
        assert adb("shell", "sha256sum " + runtime_root + "/runtime.jar").stdout.split()[0] == jar_hash
        adb("shell", "CLASSPATH=" + runtime_root + "/runtime.jar nohup app_process /system/bin "
            "io.github.mobileaidev.aiappbridge.uia.UiaRuntime " + runtime_root + " " + jar_hash
            + " > " + runtime_root + "/server.log 2>&1 < /dev/null &")
        for _ in range(80):
            result = adb("shell", "cat " + runtime_root + "/runtime.json", check=False)
            if result.returncode == 0:
                descriptor = json.loads(result.stdout)
                break
            time.sleep(0.1)
        if descriptor is None:
            raise AssertionError(adb("shell", "cat " + runtime_root + "/server.log", check=False).stdout)
        assert descriptor["dexSha256"] == jar_hash and descriptor["bootId"] == report["bootId"] and descriptor["running"] is True
        save("runtime-descriptor.json", {key: value for key, value in descriptor.items() if key != "token"})
        port = int(adb("forward", "tcp:0", "localabstract:" + descriptor["socketName"]).stdout.strip())
        unauthorized = rpc(port, "invalid", {"op": "status"})
        save("unauthorized.json", unauthorized)
        assert unauthorized["httpStatus"] == 401 and unauthorized["body"]["error"] == "uia_unauthorized"
        assert call("status")["runtimeEpoch"] == descriptor["runtimeEpoch"]
        snapshot = call("observe")
        assert snapshot["ok"] is True, snapshot
        first = make_request(snapshot)
        call("prepare", first)
        assert call("stop")["error"] == "uia_runtime_has_pending_actions"
        call("start", first)
        receipt, result = settled(first)
        assert receipt["ok"] is True and receipt["completion"] == "original_callback", receipt
        counter("sdk-after-click", before + 1)
        assert call("start", first)["receiptJson"] == result["receiptJson"]
        counter("sdk-after-duplicate", before + 1)

        cancelled = make_request(call("observe"))
        call("cancel", cancelled); call("prepare", cancelled); call("start", cancelled)
        receipt, _ = settled(cancelled)
        assert receipt["error"] == "cancelled" and receipt["dispatched"] is False
        counter("sdk-after-cancelled-delivery", before + 1)

        invalid = make_request(call("observe")); invalid["target"]["ref"] = str(uuid.uuid4())
        call("prepare", invalid); call("start", invalid)
        receipt, _ = settled(invalid)
        assert receipt["error"] == "uia_stale_reference" and receipt["dispatched"] is False

        interrupted = make_request(call("observe")); call("prepare", interrupted)
        child = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--child-submit"], input=encode({"port": port,
            "token": descriptor["token"], "payload": {"op": "start", "requestJson": encode(interrupted),
            "requestSha256": sha(encode(interrupted).encode())}}), capture_output=True, text=True, timeout=12)
        save("host-sigkill.json", {"exitCode": child.returncode, "response": json.loads(child.stdout), "stderr": child.stderr,
                                  "boundary": "after-start-response; admission at signal time is not independently asserted"})
        assert child.returncode == -signal.SIGKILL
        receipt, result = settled(interrupted)
        assert receipt["ok"] is True, receipt
        counter("sdk-after-host-sigkill", before + 2)
        record = json.loads(adb("shell", "cat " + descriptor["sessionPath"] + "/actions/" + sha(interrupted["actionId"].encode()) + ".json").stdout)
        save("offline-original-record.json", record)
        assert record["receiptJson"] == result["receiptJson"] and record["receiptSha256"] == result["receiptSha256"]

        background = make_request(call("observe"))
        cli("open-dialog", "tap-text", "--package-name", package, "--target-text", "Open Dialog", "--provider", "native", "--feedback", "off")
        dialog = True
        for index in range(20):
            tree = cli(f"dialog-precondition-{index}", "tree", "--package-name", package)
            if any(window.get("focused") is True and window.get("activityDecor") is False for window in tree["windows"]):
                break
            time.sleep(0.05)
        else:
            raise AssertionError("dialog focus was not independently established")
        call("prepare", background); call("start", background)
        receipt, _ = settled(background)
        assert receipt["error"] == "uia_foreground_changed" and receipt["dispatched"] is False, receipt
        cli("close-dialog", "keyevent", "--package-name", package, "--key-code", "4", "--feedback", "off"); dialog = False
        counter("sdk-after-focus-rejection", before + 2)
        report.update(ok=True, counterAfter=before + 2, originalActions=len(tracked))
    except Exception as error:
        report["failure"] = repr(error)
        raise
    finally:
        cleanup = []
        if descriptor is not None and port is not None:
            for request in tracked:
                try:
                    call("cancel", request)
                    _, result = settled(request)
                    call("acknowledge", request, receiptSha256=result["receiptSha256"])
                except Exception as error:
                    cleanup.append(repr(error))
            if not cleanup:
                try:
                    assert call("status")["pending"] == 0
                    assert call("stop")["ok"] is True
                    for _ in range(50):
                        stopped = json.loads(adb("shell", "cat " + runtime_root + "/runtime.json").stdout)
                        if stopped["running"] is False:
                            break
                        time.sleep(0.1)
                    assert stopped["running"] is False
                    for _ in range(30):
                        processes = adb("shell", "ps -A -o PID,NAME,ARGS").stdout
                        matched = [line for line in processes.splitlines() if line.split() and line.split()[0] == str(descriptor["pid"])]
                        if not matched:
                            break
                        time.sleep(0.1)
                    save("runtime-exit.json", {"running": stopped["running"], "matchingProcesses": matched})
                    assert not matched, matched
                except Exception as error:
                    cleanup.append(repr(error))
            adb("forward", "--remove", "tcp:" + str(port), check=False)
        if dialog:
            try:
                cli("cleanup-dialog", "keyevent", "--package-name", package, "--key-code", "4", "--feedback", "off")
            except Exception as error:
                cleanup.append(repr(error))
        (args.out / "runtime-server.log").write_text(adb("shell", "cat " + runtime_root + "/server.log", check=False).stdout)
        report.update(cleanupErrors=cleanup, rpcCalls=calls)
        if cleanup:
            report["ok"] = False
        save("report.json", report)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["ok"] is not True:
        raise SystemExit(1)


if __name__ == "__main__":
    if sys.argv[1:] == ["--child-submit"]:
        child_submit()
    else:
        main()
