import asyncio
import json
import sys
import math
import traceback
import time
from types import SimpleNamespace


_real_stdout = sys.stdout
_input_parse_ms = 0
HELD = {
    "pause_requested",
    "paused_manual",
    "paused_live",
    "paused_ambiguous",
}


def send(message):
    # Match the Host UTF-8 JSON byte budget; ASCII escaping can triple it.
    frame = json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
    _real_stdout.buffer.write(frame.encode("utf-8", errors="backslashreplace"))
    _real_stdout.buffer.flush()


def read_message():
    global _input_parse_ms
    line = sys.stdin.readline()
    if not line:
        return None
    started = time.perf_counter()
    message = json.loads(line)
    _input_parse_ms = (time.perf_counter() - started) * 1000
    return message


class HostContext:
    def __init__(self, inputs, control):
        self.inputs = inputs
        self._control = control
        self._next_id = 0

    def _id(self, prefix):
        self._next_id += 1
        return f"{prefix}{self._next_id}"

    def _apply_control(self, payload):
        if payload:
            self._control = payload

    def _hold_if_paused(self):
        while self._control.get("status") in HELD:
            message = read_message()
            if message is None:
                raise RuntimeError("channel_closed")
            if message.get("type") == "control":
                self._apply_control(message.get("control"))
                continue
            raise RuntimeError("unexpected_frame")

    def _read_reply(self, message_id):
        while True:
            reply = read_message()
            if reply is None:
                raise RuntimeError("channel_closed")
            if reply.get("type") == "control":
                self._apply_control(reply.get("control"))
                continue
            if reply.get("id") == message_id:
                self._apply_control(reply.get("control"))
                return reply
            raise RuntimeError("unexpected_frame")

    def _sync_control(self):
        message_id = self._id("s")
        send({"type": "control-point", "id": message_id})
        self._read_reply(message_id)

    def _safe_point(self):
        self._sync_control()
        self._hold_if_paused()

    def call(self, command, args=None, options=None):
        self._safe_point()
        message_id = self._id("c")
        send({"type": "call", "id": message_id, "command": command, "args": args or {}, "options": options or {}})
        reply = self._read_reply(message_id)
        self._safe_point()
        return reply["value"]

    def assert_(self, assertion):
        self._safe_point()
        message_id = self._id("a")
        send({"type": "assert", "id": message_id, "assertion": assertion})
        reply = self._read_reply(message_id)
        self._safe_point()
        return reply["value"]

    def progress(self, event):
        self._safe_point()
        send({"type": "progress", "event": event})
        self._safe_point()

    def checkpoint(self, name, state):
        self._safe_point()
        message_id = self._id("k")
        send({"type": "checkpoint", "id": message_id, "name": name, "state": state})
        reply = self._read_reply(message_id)
        self._safe_point()
        return reply["value"]

    def askAgent(self, request):
        self._safe_point()
        message_id = self._id("q")
        send({"type": "ask", "id": message_id, "request": request})
        reply = self._read_reply(message_id)
        self._safe_point()
        return reply["value"]

    def controlPoint(self):
        self._sync_control()
        return self._control

    def resume(self):
        checkpoint = self._control.get("checkpoint")
        if not checkpoint:
            return None
        return checkpoint["state"]


def load_namespace(path, source_name=None):
    namespace = {}
    with open(path, "r", encoding="utf-8") as handle:
        exec(compile(handle.read(), source_name or path, "exec"), namespace, namespace)
    return namespace


def validate_json(value, location="", parents=None):
    parents = set() if parents is None else parents

    def invalid(reason):
        error = TypeError(f"{location or '/'}: {reason}")
        error.code = "extraction_type_error"
        error.value_path = location
        raise error

    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, (int, float)):
        if (isinstance(value, int) and abs(value) > 9007199254740991) or (isinstance(value, float) and
                (not math.isfinite(value) or value.is_integer() and abs(value) > 9007199254740991)):
            invalid("expected a finite number in the safe integer range")
        return
    if type(value) not in (list, dict):
        invalid(f"unsupported JSON type: {type(value).__name__}")
    if id(value) in parents:
        invalid("cyclic value")
    parents.add(id(value))
    entries = enumerate(value) if isinstance(value, list) else value.items()
    for key, item in entries:
        if isinstance(value, dict) and not isinstance(key, str):
            invalid("object keys must be strings")
        suffix = str(key).replace("~", "~0").replace("/", "~1")
        validate_json(item, f"{location}/{suffix}", parents)
    parents.remove(id(value))


def bounded(value, size):
    return str(value).encode("utf-8", errors="replace")[:size].decode("utf-8", errors="ignore")


def diagnostic(error):
    frames = traceback.extract_tb(error.__traceback__)
    stack = "Traceback (most recent call last):\n" + "".join(traceback.format_list(frames[-20:])) + "".join(traceback.format_exception_only(type(error), error))
    result = {"type": type(error).__name__, "message": bounded(error, 2048),
              "stack": bounded(stack, 8192), "stackTruncated": len(frames) > 20 or len(stack.encode("utf-8")) > 8192}
    if isinstance(error, SyntaxError) and error.filename:
        result["location"] = {"file": bounded(error.filename, 1024), "line": error.lineno, "column": error.offset}
    elif frames:
        frame = frames[-1]
        result["location"] = {"file": bounded(frame.filename, 1024), "line": frame.lineno}
    if hasattr(error, "value_path"):
        result["valuePath"] = bounded(error.value_path, 1024)
    return result


def main():
    artifact_path = sys.argv[1]
    send({"type": "ready"})
    start = read_message()
    sys.stdout = sys.stderr
    extraction = start.get("extraction") is not None
    ctx = SimpleNamespace(inputs=start["inputs"]) if extraction else HostContext(start.get("inputs") or {}, start.get("control") or {"status": "running", "pauseReason": None})
    entry = start.get("entrypoint") or "main"
    try:
        execution_started = time.perf_counter()
        input_parse_ms = _input_parse_ms
        namespace = load_namespace(artifact_path, start.get("sourceName"))
        loaded = namespace.get(entry)
        if not callable(loaded):
            send({"type": "fail", "error": "unsupported_entrypoint"})
            sys.exit(1)
        result = loaded(ctx)
        if asyncio.iscoroutine(result):
            result = asyncio.run(result)
        if extraction:
            validate_json(result)
            if len(json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")) > 256 * 1024:
                error = ValueError("Extraction result exceeds 256 KiB.")
                error.code = "extraction_output_too_large"
                raise error
        frame = {"type": "return", "result": result}
        if extraction:
            frame["timings"] = {"inputParseMs": input_parse_ms, "executionMs": (time.perf_counter() - execution_started) * 1000}
        send(frame)
    except Exception as error:
        detail = diagnostic(error)
        send({"type": "fail", "error": getattr(error, "code", "extraction_failed") if extraction else detail["message"],
              "message": detail["message"], "diagnostic": detail})
        sys.exit(1)


if __name__ == "__main__":
    main()
