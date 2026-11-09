#!/usr/bin/env python3
"""Local server for the offline presenter.

Serves the repo read-only on 127.0.0.1 (with HTTP Range support, so video
seeking works) and relays messages between the audience and speaker windows:

  GET  /events  Server-Sent Events stream of every message sent to /send
  POST /send    JSON message, broadcast to all /events listeners

Stdlib only. Usage: serve.py <repo-root> <port>
"""
import json
import os
import queue
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2])

listeners = set()
listeners_lock = threading.Lock()
last_state = None  # replayed to new listeners so a reloaded window catches up


def broadcast(raw):
    with listeners_lock:
        for q in list(listeners):
            q.put(raw)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet; errors still surface in the browser

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    # --- relay ---------------------------------------------------------
    def do_POST(self):
        global last_state
        if self.path != "/send":
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(min(n, 65536)).decode("utf-8", "replace")
        try:
            msg = json.loads(raw)
        except ValueError:
            self.send_error(400)
            return
        if msg.get("t") == "state":
            last_state = raw
        broadcast(raw)
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path == "/events":
            return self.events()
        if "Range" in self.headers:
            return self.ranged()
        return super().do_GET()

    def events(self):
        q = queue.Queue()
        with listeners_lock:
            listeners.add(q)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            if last_state:
                self.wfile.write(f"data: {last_state}\n\n".encode())
                self.wfile.flush()
            while True:
                try:
                    raw = q.get(timeout=15)
                    self.wfile.write(f"data: {raw}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with listeners_lock:
                listeners.discard(q)

    # --- byte ranges for <video> ----------------------------------------
    def ranged(self):
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            self.send_error(404)
            return
        size = os.path.getsize(path)
        spec = self.headers["Range"].replace("bytes=", "").split(",")[0].strip()
        start_s, _, end_s = spec.partition("-")
        try:
            if start_s:
                start = int(start_s)
                end = int(end_s) if end_s else size - 1
            else:  # suffix range: last N bytes
                start = max(0, size - int(end_s))
                end = size - 1
        except ValueError:
            self.send_error(400)
            return
        end = min(end, size - 1)
        if start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = f.read(min(1 << 16, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass


ThreadingHTTPServer.daemon_threads = True
ThreadingHTTPServer.request_queue_size = 128
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
