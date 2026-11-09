#!/usr/bin/env python3
"""Local server for lectern. Stdlib only.

Two listeners:

  Presenter (127.0.0.1:PORT), private, full control
    /app/*        presenter app files
    /talk/*       any file in the talk folder (slides, clips, script)
    /api/deck     the whole deck: slides, notes, clips, script, follow URL
    /events       Server-Sent Events: every message sent to /send
    POST /send    JSON message, relayed to all presenter windows

  Follow-along (0.0.0.0:FOLLOW_PORT), public, read-only, for audience phones
    /             the phone page
    /f/<file>     the phone app's own files (allowlist)
    /f/deck       title + slide count + how far the speaker has got
    /f/slide/<n>  one slide, notes stripped. Slides the speaker hasn't
                  reached yet are refused unless followAlong.showAhead is set.
    /f/events     slide position + live captions
    /f/transcript captions so far (JSON); /f/transcript.txt to save
    /talk/*       images only
  Nothing else. No POST. Speaker notes never leave the laptop; the script
  is shared only if followAlong.shareScript is true.

Captions are made in the speaker window (Web Speech API, on-device where
Chrome supports it) and posted to /send as {t: "caption", id, text, final}.

Usage: serve.py <app-dir> <talk-dir> <port> <follow-port, 0 = off>
"""
import json
import os
import queue
import re
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from mimetypes import guess_type
from urllib.parse import parse_qs, unquote, urlsplit

APP = os.path.realpath(sys.argv[1])
TALK_DIR = os.path.realpath(sys.argv[2])
PORT = int(sys.argv[3])
FOLLOW_PORT = int(sys.argv[4]) if len(sys.argv) > 4 else 0

MAX_FOLLOWERS = 1000
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif"}
FOLLOW_FILES = {"follow.html", "follow.js", "follow.css", "render.js", "theme.css",
                "vendor/marked.min.js", "fonts/fonts.css"}


# ---------------------------------------------------------------------------
# Talk loading
# ---------------------------------------------------------------------------
class TalkError(Exception):
    pass


def load_talk(talk_dir):
    cfg_path = os.path.join(talk_dir, "talk.json")
    try:
        with open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
    except FileNotFoundError:
        raise TalkError(f"no talk.json in {talk_dir}")
    except ValueError as e:
        raise TalkError(f"talk.json is not valid JSON: {e}")

    root = os.path.realpath(os.path.join(talk_dir, cfg.get("root", ".")))
    clips = cfg.get("clips") or {}
    for cid, c in clips.items():
        if not isinstance(c, dict) or "video" not in c:
            raise TalkError(f"clips.{cid} needs a \"video\" path")

    src = cfg.get("slides")
    if not src:
        raise TalkError("talk.json needs \"slides\": a .md file or a deck.json")
    src_path = inside(root, src)
    if not src_path or not os.path.isfile(src_path):
        raise TalkError(f"slides file not found: {src}")

    if src.endswith(".md"):
        slides = slides_from_markdown(root, src_path)
    elif src.endswith(".json"):
        slides = slides_from_deck_json(root, src_path)
    else:
        raise TalkError("\"slides\" must end in .md or .json")
    if not slides:
        raise TalkError("the deck has no slides")

    for s in slides:
        c = clips.get(s["id"])
        if c:
            s["clip"] = {"video": c["video"], "poster": c.get("poster"), "script": c.get("script")}

    script = None
    if cfg.get("script"):
        sp = inside(root, cfg["script"])
        if not sp or not os.path.isfile(sp):
            raise TalkError(f"script file not found: {cfg['script']}")
        with open(sp, encoding="utf-8") as f:
            script = f.read()

    follow = cfg.get("followAlong", True)
    if isinstance(follow, bool):
        follow = {"enabled": follow}
    caps = cfg.get("captions", True)
    if isinstance(caps, bool):
        caps = {"enabled": caps}
    arch = cfg.get("archive") or {}
    for s in slides:
        s["title"] = slide_title(s)
    return {
        "title": cfg.get("title") or "Untitled talk",
        "talkMinutes": float(cfg.get("talkMinutes", 20)),
        "slotMinutes": float(cfg.get("slotMinutes", 25)),
        "root": root,
        "slides": slides,
        "script": script,
        "follow": {
            "enabled": bool(follow.get("enabled", True)),
            "showAhead": bool(follow.get("showAhead", False)),
            "qrOnSlides": list(follow.get("qrOnSlides", [])),
            "shareScript": bool(follow.get("shareScript", False)),
        },
        "captions": {
            "enabled": bool(caps.get("enabled", True)),
            "lang": str(caps.get("lang", "en-US")),
            "onProjector": bool(caps.get("onProjector", False)),
        },
        "remarks": script_sections(script) if script else {},
        # Elasticsearch for the caption archive: env wins over talk.json; none = local log only.
        "elasticsearch": os.environ.get("LECTERN_ES") or arch.get("elasticsearch"),
    }


def slide_title(s):
    if s["kind"] == "md":
        m = re.search(r"^#{1,3}\s+(.+)$", s["src"], re.M)
        return m.group(1).strip() if m else ""
    m = re.search(r"<h[1-3]\b[^>]*>([\s\S]*?)</h[1-3]>", s["src"], re.I)
    return strip_tags(m.group(1)) if m else ""


def script_sections(md):
    """Script sections '## 3 · slide-id (2:15)' -> {slide-id: text}, stage directions removed."""
    heads = list(re.finditer(r"^## \d+ · ([A-Za-z0-9_-]+) \([0-9:]+\).*$", md, re.M))
    out = {}
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(md)
        rule = md.find("\n---", m.end())
        if rule != -1 and rule < end:
            end = rule
        body = re.sub(r"\[[^\]]*\]", "", md[m.end():end])
        body = re.sub(r"\n{3,}", "\n\n", body).strip()
        out[m.group(1)] = body
    return out


def inside(root, rel):
    """Resolve rel under root; None if it escapes root."""
    p = os.path.realpath(os.path.join(root, rel))
    return p if p == root or p.startswith(root + os.sep) else None


def url_base(root, file_path):
    d = os.path.relpath(os.path.dirname(file_path), root)
    return "/talk/" if d == "." else "/talk/" + d.replace(os.sep, "/") + "/"


def slides_from_deck_json(root, path):
    """Claude Slides format: deck.json {order: [...]} + slides/<id>.html."""
    with open(path, encoding="utf-8") as f:
        deck = json.load(f)
    slides_dir = os.path.join(os.path.dirname(path), "slides")
    out = []
    for sid in deck.get("order", []):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", sid):
            raise TalkError(f"bad slide id in deck.json: {sid!r}")
        fp = os.path.join(slides_dir, sid + ".html")
        if not os.path.isfile(fp):
            raise TalkError(f"missing slide file: {os.path.relpath(fp, root)}")
        with open(fp, encoding="utf-8") as f:
            html = f.read()
        m = re.search(r"<section\b[^>]*>", html, re.I)
        if not m:
            raise TalkError(f"{os.path.relpath(fp, root)} has no <section>")
        if re.search(r"\bhidden\b", re.sub(r"\"[^\"]*\"|'[^']*'", '""', m.group(0)), re.I):
            continue  # hidden slide
        notes = " ".join(strip_tags(a) for a in ASIDE.findall(html)).strip()
        out.append({"id": sid, "kind": "html", "src": html, "notes": notes, "base": url_base(root, fp)})
    return out


ASIDE = re.compile(r"<aside\b[^>]*>([\s\S]*?)</aside\s*>", re.I)


def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s)).strip()


def public_html(html):
    html = ASIDE.sub("", html)
    # Belt and braces: an unclosed <aside> drops everything after it.
    i = html.lower().find("<aside")
    return html if i == -1 else html[:i]


MD_SPLIT = re.compile(r"^---[ \t]*$", re.M)
MD_NOTE = re.compile(r"^(?:Note|Notes):[ \t]*", re.M | re.I)
MD_ID = re.compile(r"<!--\s*id:\s*([A-Za-z0-9_-]{1,64})\s*-->")


def slides_from_markdown(root, path):
    """slides.md: slides separated by a line of ---; 'Note:' starts speaker notes."""
    with open(path, encoding="utf-8") as f:
        text = f.read().replace("\r\n", "\n")
    # Optional front matter-ish preamble is not supported; keep it simple.
    parts = [p.strip("\n") for p in MD_SPLIT.split(text)]
    out, seen = [], set()
    for n, part in enumerate(p for p in parts if p.strip()):
        m = MD_NOTE.search(part)
        body, notes = (part[:m.start()], part[m.end():]) if m else (part, "")
        idm = MD_ID.search(body)
        sid = idm.group(1) if idm else f"slide-{n + 1}"
        if sid in seen:
            raise TalkError(f"duplicate slide id in slides.md: {sid}")
        seen.add(sid)
        out.append({"id": sid, "kind": "md", "src": body.strip(), "notes": notes.strip(), "base": url_base(root, path)})
    return out


def public_slide(s, i):
    p = {"i": i, "id": s["id"], "kind": s["kind"], "base": s["base"]}
    p["src"] = public_html(s["src"]) if s["kind"] == "html" else s["src"]
    if TALK["follow"]["shareScript"]:
        key = (s.get("clip") or {}).get("script") or s["id"]
        if TALK["remarks"].get(key):
            p["remarks"] = TALK["remarks"][key]
    clip = s.get("clip")
    if clip:
        poster = clip.get("poster")
        p["clip"] = {"poster": poster if poster and os.path.splitext(poster)[1].lower() in IMAGE_EXT else None}
    return p


# ---------------------------------------------------------------------------
# State shared between the listeners
# ---------------------------------------------------------------------------
try:
    TALK = load_talk(TALK_DIR)
except TalkError as e:
    print(f"lectern: {e}", file=sys.stderr)
    sys.exit(2)

lock = threading.Lock()
private_listeners = set()
public_listeners = set()
last_state = None        # raw JSON, replayed to presenter windows that reconnect
public_state = None      # filtered dict, replayed to phones
furthest = 0             # highest slide index the speaker has shown
interim = None           # the caption line still being spoken

sys.path.insert(0, APP)
from archive import Archive  # noqa: E402

ARCHIVE = Archive(TALK["root"], TALK["title"], TALK["slides"], TALK["captions"]["lang"],
                  es_url=TALK["elasticsearch"])
# Final captions, resumed from the durable log if this talk ran earlier today.
transcript = [{"id": c["caption_id"], "text": c["text"], "slide": c["slide"], "at": c["spoken_at"]}
              for c in ARCHIVE.captions]
rec = {"file": None, "fh": None}  # the recording in progress


def lan_ip():
    override = os.environ.get("PRESENT_FOLLOW_HOST")
    if override:
        return override
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent; picks the outbound interface
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


FOLLOW_ON = bool(FOLLOW_PORT) and TALK["follow"]["enabled"]
FOLLOW_URL = None
if FOLLOW_ON:
    ip = lan_ip()
    FOLLOW_URL = f"http://{ip}:{FOLLOW_PORT}/" if ip else f"http://localhost:{FOLLOW_PORT}/"


def broadcast(listeners, raw):
    with lock:
        for q in list(listeners):
            q.put(raw)


def on_state(msg, raw):
    global last_state, public_state, furthest
    with lock:
        last_state = raw
        idx = int(msg.get("index", 0))
        furthest = max(furthest, idx)
        clip = msg.get("clip") or None
        public_state = {
            "t": "state", "index": idx, "total": len(TALK["slides"]), "furthest": furthest,
            "black": bool(msg.get("black")),
            "clip": {"phase": clip.get("phase")} if isinstance(clip, dict) else None,
        }
        pub = json.dumps(public_state)
    broadcast(public_listeners, pub)


def on_caption(msg):
    global interim
    text = str(msg.get("text", ""))[:2000].strip()
    cid = str(msg.get("id", ""))[:64]
    final = bool(msg.get("final"))
    with lock:
        slide = public_state["index"] if public_state else 0
        now = int(time.time() * 1000)
        entry = {"id": cid, "text": text, "slide": slide, "at": now}
        if final:
            interim = None
            if text:
                transcript.append(entry)
        else:
            interim = entry
    if final and text:
        try:
            started = int(msg.get("started") or now)
        except (TypeError, ValueError):
            started = now
        ARCHIVE.add_caption(text, cid, slide, now, started_at=min(started, now))
    pub = json.dumps({"t": "caption", "final": final, **entry})
    broadcast(public_listeners, pub)
    return pub


def transcript_text():
    with lock:
        lines = list(transcript)
    out, cur = [f"{TALK['title']}", "Live captions, made by speech recognition. Expect mistakes.", ""], None
    for e in lines:
        if e["slide"] != cur:
            cur = e["slide"]
            out += ["", f"[Slide {cur + 1}]"]
        out.append(e["text"])
    return "\n".join(out).strip() + "\n"


def archive_status():
    return {"t": "archive", "es": ARCHIVE.es_state, "saved": len(ARCHIVE.captions),
            "talk_id": ARCHIVE.talk_id, "recording": rec["file"]}


def status_loop():
    last = None
    while True:
        with lock:
            n = len(public_listeners)
        cur = (n, json.dumps(archive_status()))
        if cur != last:
            if not last or cur[0] != last[0]:
                broadcast(private_listeners, json.dumps({"t": "followers", "count": n}))
            broadcast(private_listeners, cur[1])
            last = cur
        time.sleep(1)


def finish_recording():
    """Close the file, write the synced captions next to it, fix seeking with ffmpeg if present."""
    with lock:
        fh, name = rec["fh"], rec["file"]
        rec["fh"], rec["file"] = None, None
    if not fh:
        return None
    fh.close()
    path = os.path.join(ARCHIVE.dir, name)
    with open(os.path.splitext(path)[0] + ".vtt", "w", encoding="utf-8") as f:
        f.write(ARCHIVE.vtt())
    def remux():
        import shutil
        import subprocess
        if not shutil.which("ffmpeg"):
            return
        tmp = path + ".tmp.webm"
        r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-c", "copy", tmp],
                           capture_output=True)
        if r.returncode == 0:
            os.replace(tmp, path)  # MediaRecorder files have no seek index; this adds one
        elif os.path.exists(tmp):
            os.remove(tmp)
    threading.Thread(target=remux, daemon=True).start()
    return name


# ---------------------------------------------------------------------------
# HTTP plumbing
# ---------------------------------------------------------------------------
class Base(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "lectern"
    sys_version = ""

    def log_message(self, fmt, *args):
        pass

    def path_only(self):
        return unquote(urlsplit(self.path).path)

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def not_found(self):
        self.send_json({"error": "not found"}, 404)

    def send_file(self, path):
        if not path or not os.path.isfile(path):
            return self.not_found()
        size = os.path.getsize(path)
        ctype = guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            spec = rng[6:].split(",")[0].strip()
            a, _, b = spec.partition("-")
            try:
                if a:
                    start, end = int(a), (int(b) if b else size - 1)
                else:
                    start, end = max(0, size - int(b)), size - 1
            except ValueError:
                return self.send_json({"error": "bad range"}, 400)
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
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

    def stream(self, listeners, replay):
        q = queue.Queue(maxsize=256)
        with lock:
            if listeners is public_listeners and len(listeners) >= MAX_FOLLOWERS:
                return self.send_json({"error": "too many followers"}, 503)
            listeners.add(q)
        self.close_connection = True
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            for raw in replay:
                self.wfile.write(f"data: {raw}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    raw = q.get(timeout=15)
                    self.wfile.write(f"data: {raw}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with lock:
                listeners.discard(q)


class Presenter(Base):
    def do_GET(self):
        p = self.path_only()
        if p == "/" or p == "/app" or p == "/app/":
            self.send_response(302)
            self.send_header("Location", "/app/index.html?view=speaker")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif p == "/events":
            with lock:
                replay = [last_state] if last_state else []
                replay.append(json.dumps({"t": "followers", "count": len(public_listeners)}))
            replay.append(json.dumps(archive_status()))
            self.stream(private_listeners, replay)
        elif p == "/api/deck":
            self.send_json({
                "title": TALK["title"], "talkMinutes": TALK["talkMinutes"], "slotMinutes": TALK["slotMinutes"],
                "slides": TALK["slides"], "script": TALK["script"],
                "follow": {"url": FOLLOW_URL, "qrOnSlides": TALK["follow"]["qrOnSlides"],
                           "shareScript": TALK["follow"]["shareScript"]} if FOLLOW_ON else None,
                "captions": TALK["captions"],
                "talkId": ARCHIVE.talk_id,
            })
        elif p == "/archive":
            self.send_file(os.path.join(APP, "archive.html"))
        elif p == "/api/search":
            qs = parse_qs(urlsplit(self.path).query)
            q = (qs.get("q") or [""])[0].strip()[:200]
            talk = (qs.get("talk") or [None])[0]
            self.send_json(ARCHIVE.search(q, talk) if q else {"hits": [], "total": 0, "engine": "", "talks": []})
        elif p == "/api/talks":
            self.send_json({"current": ARCHIVE.talk_id, "es": ARCHIVE.es_state, "talks": ARCHIVE.talks()})
        elif p == "/api/vtt":
            body = ARCHIVE.vtt().encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/vtt; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif p.startswith("/rec/"):
            # /rec/<talk_id>/<file>: recordings kept under <talk>/.lectern/
            self.send_file(inside(os.path.join(TALK["root"], ".lectern"), p[5:]))
        elif p.startswith("/app/"):
            self.send_file(inside(APP, p[5:]))
        elif p.startswith("/talk/"):
            self.send_file(inside(TALK["root"], p[6:]))
        else:
            self.not_found()

    do_HEAD = do_GET

    def do_POST(self):
        p = self.path_only()
        if p == "/rec/start":
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", "0") or 0), 4096)) or b"{}")
            finish_recording()
            name = time.strftime("recording-%H%M%S.webm")
            at = int(body.get("at") or time.time() * 1000)
            with lock:
                rec["file"], rec["fh"] = name, open(os.path.join(ARCHIVE.dir, name), "ab")
            ARCHIVE.recording_started(at, name)
            return self.send_json({"file": name, "talk_id": ARCHIVE.talk_id})
        if p == "/rec/chunk":
            n = int(self.headers.get("Content-Length", "0") or 0)
            if n > 64 * 1024 * 1024:
                return self.send_json({"error": "chunk too big"}, 413)
            data = self.rfile.read(n)
            with lock:
                fh = rec["fh"]
                if fh:
                    fh.write(data)
                    fh.flush()
            return self.send_json({"ok": bool(fh)}, 200 if fh else 409)
        if p == "/rec/stop":
            self.rfile.read(int(self.headers.get("Content-Length", "0") or 0))
            return self.send_json({"file": finish_recording()})
        if p != "/send":
            return self.not_found()
        n = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(min(n, 65536)).decode("utf-8", "replace")
        try:
            msg = json.loads(raw)
        except ValueError:
            return self.send_json({"error": "bad json"}, 400)
        if not isinstance(msg, dict):
            return self.send_json({"error": "bad message"}, 400)
        if msg.get("t") == "state":
            on_state(msg, raw)
        elif msg.get("t") == "caption":
            if not TALK["captions"]["enabled"]:
                return self.send_json({"error": "captions off"}, 403)
            raw = on_caption(msg)
        broadcast(private_listeners, raw)
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()


class Follow(Base):
    def do_GET(self):
        p = self.path_only()
        if p == "/":
            self.send_file(os.path.join(APP, "follow.html"))
        elif p == "/f/events":
            with lock:
                replay = [json.dumps(public_state)] if public_state else []
            self.stream(public_listeners, replay)
        elif p == "/f/deck":
            with lock:
                f = furthest
            self.send_json({"title": TALK["title"], "total": len(TALK["slides"]), "furthest": f,
                            "showAhead": TALK["follow"]["showAhead"],
                            "captions": TALK["captions"]["enabled"], "lang": TALK["captions"]["lang"]})
        elif p == "/f/transcript":
            with lock:
                data = {"final": list(transcript), "interim": interim}
            self.send_json(data)
        elif p == "/f/search":
            # Attendees can search what's been said in this talk (never other talks).
            q = (parse_qs(urlsplit(self.path).query).get("q") or [""])[0].strip()[:200]
            res = ARCHIVE.search(q, ARCHIVE.talk_id, size=20) if q else {"hits": [], "total": 0}
            hits = [{"text": h["text"], "highlight": h.get("highlight"), "slide": h["slide"], "at": h["spoken_at"]}
                    for h in res["hits"]]
            self.send_json({"total": res.get("total", 0), "engine": res.get("engine", ""), "hits": hits})
        elif p == "/f/transcript.txt":
            body = transcript_text().encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="transcript.txt"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif p.startswith("/f/slide/"):
            try:
                i = int(p[len("/f/slide/"):])
            except ValueError:
                return self.not_found()
            with lock:
                f = furthest
            if not 0 <= i < len(TALK["slides"]):
                return self.not_found()
            if i > f and not TALK["follow"]["showAhead"]:
                return self.send_json({"error": "the speaker hasn't reached this slide yet"}, 403)
            self.send_json(public_slide(TALK["slides"][i], i))
        elif p.startswith("/f/"):
            rel = p[3:]
            ok = rel in FOLLOW_FILES or (rel.startswith("fonts/") and rel.endswith(".woff2"))
            self.send_file(inside(APP, rel) if ok else None)
        elif p.startswith("/talk/"):
            rel = p[6:]
            if os.path.splitext(rel)[1].lower() not in IMAGE_EXT or any(part.startswith(".") for part in rel.split("/")):
                return self.not_found()
            self.send_file(inside(TALK["root"], rel))
        else:
            self.not_found()

    do_HEAD = do_GET

    def do_POST(self):
        self.send_json({"error": "read-only"}, 405)

    do_PUT = do_DELETE = do_PATCH = do_POST


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 256
    allow_reuse_address = True


def main():
    servers = [Server(("127.0.0.1", PORT), Presenter)]
    if FOLLOW_ON:
        servers.append(Server(("0.0.0.0", FOLLOW_PORT), Follow))
    threading.Thread(target=status_loop, daemon=True).start()
    print(f"lectern: {TALK['title']} · {len(TALK['slides'])} slides", flush=True)
    print(f"lectern: captions saved to {os.path.relpath(ARCHIVE.dir)}"
          + (f" and Elasticsearch at {TALK['elasticsearch']}" if TALK["elasticsearch"] else " (no Elasticsearch configured)"),
          flush=True)
    if FOLLOW_URL:
        print(f"lectern: follow along at {FOLLOW_URL}", flush=True)
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
