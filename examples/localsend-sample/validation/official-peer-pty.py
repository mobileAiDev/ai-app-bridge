#!/usr/bin/env python3
"""Give the unmodified official LocalSend CLI a terminal, controlled by JSON lines."""
import argparse
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--log', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not args.command or args.command[0] != '--':
        parser.error('provide -- followed by the official CLI command')
    with open(args.log, 'xb') as transcript:
        pid, master = pty.fork()
        if pid == 0:
            os.execvp(args.command[1], args.command[1:])
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 160, 0, 0))
        pending = b''
        stdin_open = True
        closing_at = None
        try:
            while True:
                ready, _, _ = select.select([master] + ([0] if stdin_open else []), [], [], 0.2)
                if master in ready:
                    try:
                        data = os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        data = b''
                    if not data:
                        break
                    transcript.write(data)
                    transcript.flush()
                    emit({'output': data.decode('utf-8', errors='replace')})
                if 0 in ready:
                    data = os.read(0, 65536)
                    if not data:
                        stdin_open = False
                        closing_at = time.monotonic()
                        os.write(master, b'\x03')
                    pending += data
                    while b'\n' in pending:
                        line, pending = pending.split(b'\n', 1)
                        request = json.loads(line)
                        os.write(master, request['keys'].encode('utf-8'))
                if closing_at is not None and time.monotonic() - closing_at > 5:
                    os.kill(pid, signal.SIGTERM)
                    break
        finally:
            os.close(master)
            _, status = os.waitpid(pid, 0)
            emit({'exitCode': os.waitstatus_to_exitcode(status)})


if __name__ == '__main__':
    main()
