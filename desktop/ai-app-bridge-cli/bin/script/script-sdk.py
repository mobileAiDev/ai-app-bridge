import asyncio
import json
import sys


_real_stdout = sys.stdout
HELD = {
    "pause_requested",
    "paused_manual",
    "paused_live",
    "paused_ambiguous",
}


def send(message):
    _real_stdout.write(json.dumps(message) + "\n")
    _real_stdout.flush()


def read_message():
    line = sys.stdin.readline()
    if not line:
        return None
    return json.loads(line)


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


def load_namespace(path):
    namespace = {}
    with open(path, "r", encoding="utf-8") as handle:
        exec(handle.read(), namespace, namespace)
    return namespace


def main():
    artifact_path = sys.argv[1]
    send({"type": "ready"})
    start = read_message()
    sys.stdout = sys.stderr
    ctx = HostContext(start.get("inputs") or {}, start.get("control") or {"status": "running", "pauseReason": None})
    entry = start.get("entrypoint") or "main"
    try:
        namespace = load_namespace(artifact_path)
        loaded = namespace.get(entry)
        if not callable(loaded):
            send({"type": "fail", "error": "unsupported_entrypoint"})
            sys.exit(1)
        result = loaded(ctx)
        if asyncio.iscoroutine(result):
            result = asyncio.run(result)
        send({"type": "return", "result": result})
    except Exception as error:
        send({"type": "fail", "error": str(error)})
        sys.exit(1)


if __name__ == "__main__":
    main()
