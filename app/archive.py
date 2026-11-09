"""Durable caption archive: a local append-only log plus Elasticsearch.

Every final caption is written to <talk>/.lectern/<talk_id>/captions.jsonl
first (fsync'd), then indexed into Elasticsearch by a background worker.
The talk never waits on Elasticsearch: if it is down, captions queue up and
are indexed when it comes back. Stdlib only (urllib), no client library.

Indices
  lectern-talks     one doc per talk session (title, start, recording)
  lectern-captions  one doc per caption: text, slide, spoken_at, offset_ms
                    (ms into the recording), talk_id
"""
import json
import os
import queue
import re
import threading
import time
import urllib.error
import urllib.request

TALKS = "lectern-talks"
CAPTIONS = "lectern-captions"

CAPTION_MAPPING = {
    "settings": {
        "analysis": {
            "analyzer": {
                # Speech recognition writes "kubernetes", "Kubernetes", "kube-proxy"...
                # english stemming + lowercase + ascii folding keeps search forgiving.
                "caption_text": {
                    "type": "custom", "tokenizer": "standard",
                    "filter": ["lowercase", "asciifolding", "english_possessive", "english_stop", "english_stem"],
                },
                # Speech recognition splits and joins words unpredictably
                # ("Elasticsearch" / "elastic search"). Index each word and each
                # pair of words glued together, so either spelling matches.
                "caption_joined": {
                    "type": "custom", "tokenizer": "standard",
                    "filter": ["lowercase", "asciifolding", "glue_pairs"],
                },
            },
            "filter": {
                "english_possessive": {"type": "stemmer", "language": "possessive_english"},
                "english_stop": {"type": "stop", "stopwords": "_english_"},
                "english_stem": {"type": "stemmer", "language": "english"},
                "glue_pairs": {"type": "shingle", "min_shingle_size": 2, "max_shingle_size": 2,
                               "output_unigrams": True, "token_separator": ""},
            },
        },
    },
    "mappings": {
        "properties": {
            "talk_id": {"type": "keyword"},
            "take": {"type": "integer"},
            "take_id": {"type": "keyword"},
            "talk_title": {"type": "text", "fields": {"raw": {"type": "keyword"}}},
            "caption_id": {"type": "keyword"},
            "seq": {"type": "integer"},
            "text": {"type": "text", "analyzer": "caption_text",
                     "fields": {"exact": {"type": "text", "analyzer": "standard"},
                                "joined": {"type": "text", "analyzer": "caption_joined"}}},
            "slide": {"type": "integer"},
            "slide_id": {"type": "keyword"},
            "slide_title": {"type": "text"},
            "spoken_at": {"type": "date", "format": "epoch_millis"},
            "started_at": {"type": "date", "format": "epoch_millis"},
            "offset_ms": {"type": "long"},
            "lang": {"type": "keyword"},
        }
    },
}

TALK_MAPPING = {
    "mappings": {
        "properties": {
            "talk_id": {"type": "keyword"},
            "take": {"type": "integer"},
            "take_id": {"type": "keyword"},
            "title": {"type": "text", "fields": {"raw": {"type": "keyword"}}},
            "started_at": {"type": "date", "format": "epoch_millis"},
            "recording_started_at": {"type": "date", "format": "epoch_millis"},
            "recording": {"type": "keyword"},
            "slides": {"type": "integer"},
            "lang": {"type": "keyword"},
        }
    }
}


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:48] or "talk"


class ES:
    def __init__(self, url):
        self.url = url.rstrip("/")

    def req(self, method, path, body=None, ndjson=False, timeout=5):
        data = None
        headers = {}
        if body is not None:
            if ndjson:
                data = body.encode()
                headers["Content-Type"] = "application/x-ndjson"
            else:
                data = json.dumps(body).encode()
                headers["Content-Type"] = "application/json"
        r = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"error": raw.decode("utf-8", "replace")}

    def up(self):
        try:
            code, _ = self.req("GET", "/", timeout=2)
            return code == 200
        except OSError:
            return False

    def ensure_indices(self):
        for name, mapping in ((CAPTIONS, CAPTION_MAPPING), (TALKS, TALK_MAPPING)):
            code, _ = self.req("HEAD", "/" + name)
            if code == 200:
                # Index from before takes existed: drop it; it is rebuilt from the disk logs.
                _, m = self.req("GET", f"/{name}/_mapping")
                props = (m or {}).get(name, {}).get("mappings", {}).get("properties", {})
                if props.get("take_id", {}).get("type") != "keyword":
                    self.req("DELETE", "/" + name)
                    code = 404
            if code == 404:
                code, body = self.req("PUT", "/" + name, mapping)
                if code >= 300 and "resource_already_exists" not in json.dumps(body):
                    raise RuntimeError(f"create {name}: {body}")


class Archive:
    """Owns the talk session, the on-disk log, and the Elasticsearch writer."""

    def __init__(self, talk_root, title, slides, lang, es_url=None, resume=False, log=print):
        self.title, self.slides, self.lang, self.log = title, slides, lang, log
        day = time.strftime("%Y%m%d")
        self.talk_id = f"{slug(title)}-{day}"
        self.root = os.path.join(talk_root, ".lectern")
        self.talk_dir = os.path.join(self.root, self.talk_id)
        os.makedirs(self.talk_dir, exist_ok=True)
        self._migrate_legacy()
        self.lock = threading.Lock()
        last = max(self._takes(), default=0)
        self._open_take(last if (resume and last) else last + 1)

        self.es = ES(es_url) if es_url else None
        self.es_state = "off" if not es_url else "connecting"
        self.q = queue.Queue()
        if self.es:
            threading.Thread(target=self._writer, daemon=True).start()

    # ---------------- takes ----------------
    # Every launch (and every new recording) is a take: its own caption log,
    # recording and .vtt under .lectern/<talk_id>/take-NNN/. Nothing is overwritten.
    def _takes(self):
        out = []
        for name in os.listdir(self.talk_dir):
            m = re.fullmatch(r"take-(\d{3,})", name)
            if m and os.path.isdir(os.path.join(self.talk_dir, name)):
                out.append(int(m.group(1)))
        return sorted(out)

    def _migrate_legacy(self):
        """Logs written before takes existed become take 1."""
        legacy = [f for f in os.listdir(self.talk_dir) if os.path.isfile(os.path.join(self.talk_dir, f))]
        if legacy and not self._takes():
            dest = os.path.join(self.talk_dir, "take-001")
            os.makedirs(dest)
            for f in legacy:
                os.replace(os.path.join(self.talk_dir, f), os.path.join(dest, f))
            mp = os.path.join(dest, "talk.json")
            if os.path.isfile(mp):
                with open(mp) as fh:
                    meta = json.load(fh)
                meta.update(take=1, take_id=f"{self.talk_id}:1")
                if meta.get("recording") and "/" not in meta["recording"]:
                    meta["recording"] = f"{self.talk_id}/take-001/{meta['recording']}"
                with open(mp, "w") as fh:
                    json.dump(meta, fh, indent=2)

    def _open_take(self, n):
        self.take = n
        self.take_id = f"{self.talk_id}:{n}"
        self.dir = os.path.join(self.talk_dir, f"take-{n:03d}")
        os.makedirs(self.dir, exist_ok=True)
        self.log_path = os.path.join(self.dir, "captions.jsonl")
        self.meta_path = os.path.join(self.dir, "talk.json")
        self.meta = {"talk_id": self.talk_id, "take": n, "take_id": self.take_id, "title": self.title,
                     "started_at": int(time.time() * 1000), "recording_started_at": None, "recording": None,
                     "slides": len(self.slides), "lang": self.lang}
        if os.path.isfile(self.meta_path):
            try:
                with open(self.meta_path) as f:
                    self.meta.update(json.load(f))  # --resume: carry on with this take
            except ValueError:
                pass
        self.captions = self._read_log(self.log_path)
        self.seq = max((c["seq"] for c in self.captions), default=-1) + 1
        self._save_meta()

    def new_take(self):
        with self.lock:
            self._open_take(self.take + 1)
            meta = dict(self.meta)
        self.q.put(("talk", meta))
        return self.take

    def rel(self, filename):
        """Path of a file in this take, relative to .lectern/ (how /rec/ serves it)."""
        return f"{self.talk_id}/take-{self.take:03d}/{filename}"

    # ---------------- local durable log ----------------
    @staticmethod
    def _read_log(path):
        out = []
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                for line in f:
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        pass  # a torn last line after a crash
        return out

    def _save_meta(self):
        tmp = self.meta_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.meta, f, indent=2)
        os.replace(tmp, self.meta_path)

    def add_caption(self, text, caption_id, slide, spoken_at, started_at=None):
        with self.lock:
            rec_start = self.meta.get("recording_started_at")
            s = self.slides[slide] if 0 <= slide < len(self.slides) else {}
            doc = {
                "talk_id": self.talk_id, "take": self.take, "take_id": self.take_id,
                "talk_title": self.title, "caption_id": caption_id, "seq": self.seq,
                "text": text, "slide": slide, "slide_id": s.get("id"), "slide_title": s.get("title", ""),
                "spoken_at": spoken_at, "started_at": started_at or spoken_at,
                # A phrase that began just before recording started is clamped to 0.
                "offset_ms": (max(0, (started_at or spoken_at) - rec_start)
                              if rec_start and spoken_at >= rec_start else None),
                "lang": self.lang,
            }
            self.seq += 1
            self.captions.append(doc)
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(doc) + "\n")
                f.flush()
                os.fsync(f.fileno())
        self.q.put(("caption", doc))
        return doc

    def recording_started(self, at, filename):
        with self.lock:
            self.meta["recording_started_at"] = at
            self.meta["recording"] = self.rel(filename)
            self._save_meta()
        self.q.put(("talk", dict(self.meta)))

    # ---------------- Elasticsearch writer ----------------
    def _all_logs(self):
        """Every take of every talk on this laptop: (meta, captions) from disk."""
        out = []
        for talk in sorted(os.listdir(self.root)):
            tdir = os.path.join(self.root, talk)
            if not os.path.isdir(tdir):
                continue
            for take in sorted(os.listdir(tdir)):
                d = os.path.join(tdir, take)
                mp = os.path.join(d, "talk.json")
                if not (take.startswith("take-") and os.path.isfile(mp)):
                    continue
                try:
                    with open(mp) as f:
                        meta = json.load(f)
                except ValueError:
                    continue
                if "take_id" not in meta:
                    continue
                caps = self._read_log(os.path.join(d, "captions.jsonl"))
                for c in caps:  # captions logged before takes existed
                    c.setdefault("take", meta["take"])
                    c.setdefault("take_id", meta["take_id"])
                    c.setdefault("talk_title", meta.get("title", ""))
                out.append((meta, caps))
        return out

    def _writer(self):
        while True:
            if not self.es.up():
                self.es_state = "down (captions are safe on disk; will catch up)"
                time.sleep(3)
                continue
            try:
                self.es.ensure_indices()
                # Catch up from the on-disk logs of every take (idempotent ids),
                # so outages, restarts and a deleted index all heal themselves.
                failed = []
                for meta, caps in self._all_logs():
                    try:
                        for i in range(0, max(1, len(caps)), 500):
                            self._bulk(([("talk", meta)] if i == 0 else []) + [("caption", c) for c in caps[i:i + 500]])
                    except RuntimeError:
                        failed.append(meta.get("take_id"))  # one bad take must not block the rest
                if failed:
                    self.log(f"lectern: could not index {', '.join(map(str, failed))}; they stay on disk")
                self.es_state = "connected"
                # Then stream new captions in small batches.
                while True:
                    batch = [self.q.get()]
                    deadline = time.time() + 0.5
                    while time.time() < deadline:
                        try:
                            batch.append(self.q.get(timeout=max(0.01, deadline - time.time())))
                        except queue.Empty:
                            break
                    self._bulk(batch)
            except Exception as e:  # ES went away mid-stream: drain and retry from the logs
                self.es_state = f"error: {e}"[:200]
                while not self.q.empty():
                    self.q.get_nowait()
                time.sleep(2)

    def _bulk(self, items):
        if not items:
            return
        lines = []
        for kind, doc in items:
            if kind == "caption":
                lines.append(json.dumps({"index": {"_index": CAPTIONS, "_id": f"{doc['take_id']}:{doc['seq']}"}}))
            else:
                lines.append(json.dumps({"index": {"_index": TALKS, "_id": doc["take_id"]}}))
            lines.append(json.dumps(doc))
        code, body = self.es.req("POST", "/_bulk?refresh=wait_for", "\n".join(lines) + "\n", ndjson=True, timeout=15)
        if code >= 300 or (body and body.get("errors")):
            first = next((i for i in (body or {}).get("items", []) if list(i.values())[0].get("error")), None)
            raise RuntimeError(f"bulk failed ({code}): {json.dumps(first)[:300] if first else ''}")

    # ---------------- search ----------------
    def search(self, q, take_id=None, size=30):
        """Forgiving full-text search over captions.

        Speech recognition mishears words, so: stemmed english analysis,
        fuzzy matching on the stemmed field, a boost for exact phrases, and
        highlighted fragments to show the moment that matched.
        """
        if not self.es or self.es_state != "connected":
            return self._local_search(q, take_id, size)
        # Must match the spoken words (fuzzy, or with words glued/split);
        # exact phrases and slide titles only push results up.
        must = [{"bool": {"minimum_should_match": 1, "should": [
            {"match": {"text": {"query": q, "fuzziness": "AUTO", "prefix_length": 1, "minimum_should_match": "75%"}}},
            {"match": {"text.joined": {"query": q, "minimum_should_match": "75%", "boost": 1.5}}},
        ]}}]
        should = [{"match_phrase": {"text.exact": {"query": q, "slop": 2, "boost": 4}}},
                  {"match": {"slide_title": {"query": q, "boost": 0.5}}}]
        filt = [{"term": {"take_id": take_id}}] if take_id else []
        body = {
            "size": size,
            "query": {"bool": {"must": must, "should": should, "filter": filt}},
            "highlight": {"pre_tags": ["<mark>"], "post_tags": ["</mark>"],
                          "fields": {"text": {"number_of_fragments": 0},
                                     "text.joined": {"number_of_fragments": 0}}},
            "aggs": {"talks": {"terms": {"field": "take_id", "size": 50}}},
            "_source": ["talk_id", "take", "take_id", "talk_title", "text", "slide", "slide_title", "spoken_at", "offset_ms", "seq"],
        }
        code, res = self.es.req("POST", f"/{CAPTIONS}/_search", body)
        if code >= 300:
            return self._local_search(q, take_id, size)
        hits = []
        for h in res["hits"]["hits"]:
            d = h["_source"]
            hl = h.get("highlight", {})
            d["highlight"] = (hl.get("text") or hl.get("text.joined") or [None])[0]
            d["score"] = h["_score"]
            hits.append(d)
        return {"engine": "elasticsearch", "total": res["hits"]["total"]["value"], "hits": hits,
                "talks": [b["key"] for b in res.get("aggregations", {}).get("talks", {}).get("buckets", [])]}

    def _local_search(self, q, take_id, size):
        """Fallback when Elasticsearch is down: plain substring match on this talk's log."""
        words = [w for w in re.findall(r"\w+", q.lower()) if w]
        with self.lock:
            caps = list(self.captions)
        hits = [dict(c, highlight=None, score=0) for c in caps
                if all(w in c["text"].lower() for w in words) and (not take_id or c.get("take_id") == take_id)]
        return {"engine": "local (Elasticsearch unavailable)", "total": len(hits), "hits": hits[-size:], "talks": []}

    def talks(self):
        if self.es and self.es_state == "connected":
            code, res = self.es.req("POST", f"/{TALKS}/_search",
                                    {"size": 200, "sort": [{"started_at": "desc"}], "query": {"match_all": {}}})
            if code < 300:
                return [h["_source"] for h in res["hits"]["hits"]]
        return [m for m, _ in sorted(self._all_logs(), key=lambda x: -x[0].get("started_at", 0))]

    # ---------------- exports ----------------
    def vtt(self):
        """WebVTT captions timed against the recording."""
        with self.lock:
            caps = [c for c in self.captions if c.get("offset_ms") is not None and c["offset_ms"] >= 0]
        def ts(ms):
            ms = max(0, int(ms))
            return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}.{ms % 1000:03d}"
        out = ["WEBVTT", ""]
        for i, c in enumerate(caps):
            start = c["offset_ms"]
            end = c["spoken_at"] - self.meta["recording_started_at"]  # spoken_at in recording time
            if i + 1 < len(caps):
                end = min(max(end, start + 1200), caps[i + 1]["offset_ms"])
            end = max(end, start + 1200)
            out += [str(i + 1), f"{ts(start)} --> {ts(end)}", c["text"], ""]
        return "\n".join(out)
