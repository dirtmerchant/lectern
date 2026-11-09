# lectern

**Every conference talk, captioned live and in your hand.**

lectern is a presenter for conference speakers. Attendees scan a QR code on the screen and get **live captions** and **the current slide** on their own phone, with no app, no account and no venue setup.

Every caption is saved durably and indexed in **Elasticsearch**, timestamped against a recording of the talk, so anything said in any talk can be searched and replayed from that moment, with captions.

Built at the [WeMakeDevs Cloud Native Hackathon](https://www.wemakedevs.org/hackathons/cnh), Salt Lake City, Nov 9, 2026. Merge Forward and Elasticsearch ("Find the Right Talk") tracks.

## The problem

Most conference talks have no captions. Venues book captioners and interpreters for the keynote, and the breakout rooms, where most of the learning happens, get nothing. For deaf and hard-of-hearing attendees, that turns most of the schedule into a wall of sound. My two daughters are deaf, and for them a conference means skipping most talks or waiting weeks for a recording, after the hallway conversations and Q&A are long over.

lectern fixes this from the speaker's side, so it doesn't depend on venue budget or equipment. The speaker presents from their laptop as usual. The audience scans a QR code and follows along on their own phone, with their own caption size, contrast and layout. They can scroll back to catch up and save the full transcript afterward.

## The curb cut effect

Curb cuts were built for wheelchair users, and now everyone with a stroller, suitcase or bike uses them. lectern was built for deaf attendees, and it helps the whole room:

- the back row that can't read the slides
- non-native speakers who read faster than they listen
- note-takers, and anyone whose attention drifted for a minute
- parents and anyone who stepped out for a call
- the speaker, who gets a transcript for free

An accommodation for a few becomes a better talk for everyone.

## What attendees get

- **Live captions** on their phone as the speaker talks. Words still being spoken show in grey.
- **The current slide**, as shown on screen or reflowed as **large text** for low vision and screen readers.
- **Their own settings**:
  - caption size S to XL
  - dark, light or high-contrast (yellow on black) colors
  - captions-only, slides-only, or both (side by side in landscape)
- **Screen reader support**: slide changes are announced, and new captions can be read aloud (opt-in, so it doesn't talk over you).
- **Scroll back** through captions and earlier slides, then **Back to live**. They can never see slides the speaker hasn't reached.
- **Search what's been said** in the talk so far, from the phone.
- **Save the transcript**, grouped by slide.
- An optional vibration on slide change, touch targets of at least 48px, full keyboard use, and respect for reduced motion and high-contrast settings.

## What speakers get

- **A projector window**: slides and video clips fullscreen, an optional caption bar for the room (**C**), and a QR code to join (**Q**, or automatic on chosen slides).
- **A speaker window** on the laptop: current and next slide, script or notes, pace timer, captions status, and a count of phones following.
- Clicker support, black-out screen (**B**), and recovery: a window that reloads comes back on the right slide.
- **Recording (V)**: the projector window plus the mic, saved on the laptop. Captions are timestamped against it and exported as a `.vtt` file, ready to upload with the video.
- **Camera bubble (W)**: the speaker's face on the slides, so it lands in the recording, and people who lip-read can see it on the big screen.
- **Archive** at `http://127.0.0.1:8765/archive`: search everything said in every talk, click a result, and the recording plays from that moment with captions.
- Slides in **Markdown**, or HTML slide decks.
- Runs **offline**. No cloud service, no accounts, no install beyond Python and Chrome.

## Quick start

Requirements: macOS, Python 3.9+ (standard library only), Google Chrome. Optional: Docker, for the Elasticsearch archive.

```bash
git clone https://github.com/dirtmerchant/lectern && cd lectern

./present.sh examples/pitch        # present the example deck
./present.sh init my-talk          # start your own talk from a template
./present.sh my-talk               # present it
```

For the searchable archive, start Elasticsearch once. `present.sh` finds it automatically:

```bash
docker compose -f elasticsearch/compose.yaml up -d   # local, single node, localhost only
```

`present.sh` checks everything first (files, displays, ports), then opens the projector window fullscreen on the external display and the speaker window on the laptop. With one display it opens both side by side for rehearsal. The terminal prints the phone URL, and the QR code on the projector points to it.

Other options:

```bash
./present.sh --check my-talk       # preflight only
./present.sh --serve my-talk       # server only; open the printed URLs in any browser (any OS)
./present.sh --no-follow my-talk   # no phone access
```

Displays must be **extended, not mirrored**, or the audience sees your notes. Phones must be on the same network as the laptop. If the venue wifi blocks devices from seeing each other, run a phone hotspot from the laptop or your phone.

### Keys (speaker window; the clicker drives it)

| Key | Action |
|---|---|
| → / Space / PgDn | next (on a clip slide, the first press plays the clip) |
| ← / PgUp | back (rewinds a started clip first) |
| Q | QR code on the projector |
| C | captions on the projector |
| M | pause / resume the captions mic |
| V | start / stop recording the talk |
| W | camera bubble on the slides |
| B | black screen |
| K / J | pause / restart clip |
| T | start / pause timer · R twice resets it |
| number + Enter | jump to slide |
| + / − | script text size |

## Writing a talk

`./present.sh init my-talk` creates two files.

**`slides.md`**: slides are separated by a line containing only `---`. Text after `Note:` is speaker notes, shown only on your laptop.

```markdown
# My talk

Your name · Conference 2026

Note:
Only I can see this.

---

## One idea per slide

- Short bullets
- **Bold** for the word that matters
```

**`talk.json`**:

```json
{
  "title": "My talk",
  "slides": "slides.md",
  "talkMinutes": 20,
  "slotMinutes": 25,
  "captions": { "enabled": true, "lang": "en-US", "onProjector": false },
  "followAlong": { "enabled": true, "qrOnSlides": ["slide-1"], "showAhead": false, "shareScript": false }
}
```

| Setting | Meaning |
|---|---|
| `slides` | a `.md` file, or a `deck.json` with `slides/<id>.html` (HTML slide format) |
| `script` | optional script file. Sections like `## 3 · slide-id (2:15)` give per-slide text and pace targets |
| `clips` | optional `{ "slide-id": { "video": "a.mp4", "poster": "a.png" } }` |
| `captions.lang` | speech recognition language, for example `en-US`, `es-MX` |
| `captions.onProjector` | start with the caption bar on the projector |
| `followAlong.qrOnSlides` | slide ids that show the QR code automatically (Markdown slides are `slide-1`, `slide-2`, …, or set `<!-- id: name -->`) |
| `followAlong.showAhead` | let phones browse slides the speaker hasn't reached (off by default) |
| `followAlong.shareScript` | send your prepared script to phones as "the speaker's prepared words" (off by default) |

## How it works

```
 speaker's laptop                                          audience phones
┌─────────────────────────────────────────────┐
│ speaker window ──mic──▶ speech recognition  │
│   │  (on-device where Chrome supports it)   │
│   ▼                                         │
│ serve.py ── 127.0.0.1:8765 (full control) ◀─┼── projector window
│   │                                         │
│   └──────── 0.0.0.0:8766 (read-only) ───────┼──▶ 📱 📱 📱  live captions + slide
└─────────────────────────────────────────────┘
```

- **`app/serve.py`** (Python, standard library only) runs two listeners:
  - **Presenter, `127.0.0.1` only.** The two Chrome windows talk through it (Server-Sent Events plus a small `/send` relay). It has full control and serves the talk files.
  - **Follow-along, on the local network, read-only.**
    - It answers GET requests only, and serves only an allowlist of the phone page's own files, slide images, and JSON for one slide at a time.
    - Speaker notes are stripped **on the server**, so they never reach a phone.
    - Slides past the furthest one the speaker has shown are refused.
    - The script is never sent unless `shareScript` is on.
    - Nothing on this port can change the slides.
- **Captions** come from the Web Speech API in the speaker window. Each phrase goes to the server, which keeps a transcript tagged with the slide it was spoken on and relays it to phones. Updates are throttled to about four a second so phones on weak wifi keep up. A reconnecting phone catches up from the transcript.
- **`app/render.js`** draws slides on a 1920×1080 canvas scaled to any screen, and builds the reflowed large-text version for phones. The presenter and the phone page share it.
- **`app/follow.*`** is the phone page: plain HTML/CSS/JS, no framework, no build step.
- **Vendored libraries**, so it works offline: [marked](https://github.com/markedjs/marked) 12.0.2 (MIT) and [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 (MIT). Fonts: IBM Plex Sans and JetBrains Mono (SIL Open Font License).

### The caption archive (Elasticsearch)

Captions are the record of what was said, so they're written twice:

1. **To disk first.** Each final caption is appended and fsync'd to `<talk>/.lectern/<talk-id>/captions.jsonl` before anything else happens. A crash loses nothing, and a restarted server resumes the transcript, so phones pick up where they left off.
2. **Then to Elasticsearch**, by a background worker using the bulk API. The talk never waits on it. If Elasticsearch is down, captions queue up and the worker catches up from the disk log when it returns. Each document's id is `talk-id:sequence`, so replaying is idempotent. You can delete the index mid-talk and it rebuilds.

Indices:

- `lectern-captions`: one document per caption, holding the text, slide number and title, when it was spoken, `offset_ms` into the recording, talk id, and language.
- `lectern-talks`: one per talk session, holding the title, start time and recording file.

**Search is built for speech recognition, which mishears words:**

- **Stemmed English analysis**, so "cuts" finds "cut" and "daughters" finds "daughter".
- **Fuzzy matching**, so a typo like "dauters" still finds "daughters", and close mishearings match.
- **A shingle subfield (`text.joined`)** that indexes each pair of adjacent words glued together, so "elastic search" finds "Elasticsearch" and the other way round.
- **An exact-phrase boost** and a slide-title boost to rank the best moment first.
- **Highlighted matches**, plus a count of results per talk.

If Elasticsearch is unavailable, search falls back to a plain match over the current talk's disk log.

**Recording.** **V** in the speaker window records the projector window (picked automatically by its title) plus the mic, with `MediaRecorder`. Chunks are uploaded every 2 seconds into the same folder. On stop, lectern writes `recording-HHMMSS.vtt` from the archived captions and, if `ffmpeg` is installed, remuxes the file so it can be seeked.

### Privacy

Where Chrome has an on-device speech model for the language, audio stays on the laptop. The speaker window shows which mode is active: "on-device" or "cloud". Otherwise Chrome uses its cloud speech service. Captions, the transcript and recordings are stored on the laptop, under the talk folder in `.lectern/` (ignored by git), and in the local Elasticsearch if you run it. The provided compose file binds Elasticsearch to localhost only. Nothing is sent anywhere else. Phones can search only the current talk.

### Limits

- Speech recognition makes mistakes, especially with jargon and names. The phone page says so.
- Captions cover the speaker's mic only, not audience questions. Repeat questions into the mic.
- Display placement in `present.sh` is macOS only. Elsewhere, use `--serve` and open the windows yourself.

## Built before vs. during the hackathon

- **Before (Nov 8, 2026):** a two-window offline presenter I wrote for my ArgoCon NA 2026 talk. It's the first commit in this repo (`7614e10`), imported unchanged and labeled as such.
- **During (Nov 9, 2026):** everything after that commit:
  - any deck via `talk.json`
  - Markdown slides
  - live captions and the transcript
  - the Elasticsearch caption archive, recording, synced `.vtt` export, the archive search page, and phone search
  - the camera bubble
  - the read-only phone server and its security model
  - the captions-first phone page and its accessibility settings
  - QR code join
  - `init` templates
  - this README

See `git log` for the full history.

## AI disclosure

Built with [Claude Code](https://claude.com/claude-code) as a pair programmer. I set the design, the accessibility requirements and the security model, and I reviewed and tested the code. Commits written with Claude carry a `Co-Authored-By` line.

## License

MIT. See [LICENSE](LICENSE).
