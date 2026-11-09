#!/usr/bin/env bash
# lectern: present any talk with live captions and slides on the audience's phones.
#   projector -> audience window, fullscreen (slides, clips, optional captions)
#   laptop    -> speaker window (current/next slide, script or notes, timer, captions mic)
#   phones    -> http://<laptop-ip>:8766  (read-only: slides + live captions)
#
# Usage:
#   ./present.sh [talk-dir]          present (talk-dir holds talk.json; default .)
#   ./present.sh --check [talk-dir]  preflight only, opens nothing
#   ./present.sh --serve [talk-dir]  server only: open the printed URLs in any browser
#   ./present.sh --stage [talk-dir]  recording layout: projector + a live phone side by side
#                                    in one window, speaker view beside it (laptop screen only)
#   ./present.sh init <dir>          start a new talk from a template
#
# Env overrides:
#   PRESENT_AUDIENCE=<n>     display number for the projector (see the list it prints)
#   PRESENT_SPEAKER=<n>      display number for the speaker view
#   PRESENT_PORT=<port>      presenter port, localhost only (default 8765)
#   PRESENT_FOLLOW_PORT=<p>  phone port on your network (default 8766, 0 turns it off)
#   PRESENT_FOLLOW_HOST=<ip> address to put in the QR code (default: auto)
#   PRESENT_CHROME=<path>    Chrome binary
#   LECTERN_ES=<url>         Elasticsearch for the caption archive
#                            (default: talk.json "archive", else http://127.0.0.1:9200 if it's running)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/app"
PORT="${PRESENT_PORT:-8765}"
FOLLOW_PORT="${PRESENT_FOLLOW_PORT:-8766}"
CHROME="${PRESENT_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILES="${TMPDIR:-/tmp}/lectern-present"

bold=$'\033[1m'; red=$'\033[31m'; grn=$'\033[32m'; yel=$'\033[33m'; rst=$'\033[0m'
ok()   { echo "  ${grn}✓${rst} $*"; }
warn() { echo "  ${yel}!${rst} $*"; }
die()  { echo "  ${red}✗ $*${rst}"; exit 1; }

# --- init ---------------------------------------------------------------------
if [[ "${1:-}" == "init" ]]; then
  dir="${2:-}"
  [[ -n "$dir" ]] || die "usage: ./present.sh init <dir>"
  [[ -e "$dir/talk.json" ]] && die "$dir/talk.json already exists"
  mkdir -p "$dir"
  cp "$HERE/templates/talk.json" "$HERE/templates/slides.md" "$dir/"
  echo "${grn}New talk in $dir${rst}"
  echo "  Edit $dir/slides.md (slides split on ---, speaker notes after 'Note:')"
  echo "  Then: ./present.sh $dir"
  exit 0
fi

MODE=present
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --check) MODE=check ;;
    --serve) MODE=serve ;;
    --stage) MODE=stage ;;
    --no-follow) FOLLOW_PORT=0 ;;
    *) die "unknown option $1" ;;
  esac
  shift
done
TALK="$(cd "${1:-.}" 2>/dev/null && pwd)" || die "no such folder: ${1:-.}"

echo "${bold}Preflight${rst}"

# --- talk ---------------------------------------------------------------------
[[ -f "$TALK/talk.json" ]] || die "no talk.json in $TALK  (start one with: ./present.sh init <dir>)"
summary=$(python3 - "$APP" "$TALK" <<'EOF'
import os, sys, importlib.util
app, talk = sys.argv[1], sys.argv[2]
sys.argv = ["serve.py", app, talk, "0", "0"]
spec = importlib.util.spec_from_file_location("serve", os.path.join(app, "serve.py"))
src = open(spec.origin).read().split("# State shared between the listeners")[0]
ns = {"__name__": "lectern_check"}
exec(compile(src, spec.origin, "exec"), ns)
try:
    t = ns["load_talk"](talk)
except ns["TalkError"] as e:
    print("ERR " + str(e)); sys.exit(0)
miss = []
for s in t["slides"]:
    c = s.get("clip")
    if c:
        for p in (c["video"], c.get("poster")):
            if p and not os.path.isfile(os.path.join(t["root"], p)):
                miss.append(p)
if miss:
    print("ERR missing clip files: " + ", ".join(miss)); sys.exit(0)
clips = sum(1 for s in t["slides"] if s.get("clip"))
print(f"OK {t['title']}|{len(t['slides'])} slides, {clips} clips|{'script' if t['script'] else 'no script (notes only)'}|"
      f"{'captions ' + t['captions']['lang'] if t['captions']['enabled'] else 'captions off'}|"
      f"{'on' if t['follow']['enabled'] else 'off'}")
EOF
)
[[ "$summary" == OK* ]] || die "${summary#ERR }"
IFS='|' read -r title counts scriptinfo capinfo followinfo <<<"${summary#OK }"
ok "$title: $counts, $scriptinfo"
ok "$capinfo"
[[ "$followinfo" == off ]] && FOLLOW_PORT=0

# --- caption archive ----------------------------------------------------------------
if [[ -z "${LECTERN_ES:-}" ]] && ! grep -q '"elasticsearch"' "$TALK/talk.json" \
   && curl -sf -m 2 http://127.0.0.1:9200/ >/dev/null 2>&1; then
  export LECTERN_ES=http://127.0.0.1:9200
fi
if [[ -n "${LECTERN_ES:-}" ]]; then
  if curl -sf -m 2 "$LECTERN_ES/" >/dev/null 2>&1; then ok "caption archive: disk + Elasticsearch at $LECTERN_ES"
  else warn "Elasticsearch at $LECTERN_ES not answering: captions go to disk and catch up when it's back"; fi
else
  ok "caption archive: disk only (start Elasticsearch: docker compose -f elasticsearch/compose.yaml up -d)"
fi

# --- ports --------------------------------------------------------------------
busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
busy "$PORT" && die "port $PORT is busy (already presenting?). Close it, or PRESENT_PORT=8799 ./present.sh"
ok "port $PORT free"
if [[ "$FOLLOW_PORT" != 0 ]]; then
  busy "$FOLLOW_PORT" && die "port $FOLLOW_PORT is busy. PRESENT_FOLLOW_PORT=8798 ./present.sh, or --no-follow"
  ok "phones: port $FOLLOW_PORT free (open to your network, read-only)"
fi

# --- browser + displays (present mode) ------------------------------------------
if [[ $MODE != serve ]]; then
  [[ -x "$CHROME" ]] || die "Chrome not found at $CHROME (set PRESENT_CHROME, or use --serve)"
  ok "Chrome found"
  if [[ "$(uname)" != Darwin ]]; then
    die "display placement needs macOS. Use --serve and open the two URLs yourself"
  fi
  screens=$(osascript -l JavaScript <<'EOF'
ObjC.import('AppKit');
const s = $.NSScreen.screens, n = s.count, mainH = s.objectAtIndex(0).frame.size.height, out = [];
for (let i = 0; i < n; i++) {
  const sc = s.objectAtIndex(i), f = sc.frame;
  let name = 'Display ' + (i + 1);
  try { name = ObjC.unwrap(sc.localizedName) || name; } catch (e) {}
  const y = mainH - (f.origin.y + f.size.height);
  out.push([i + 1, f.origin.x, y, f.size.width, f.size.height, /built-in/i.test(name) ? 1 : 0, name].join(' '));
}
out.join('\n');
EOF
)
  count=$(echo "$screens" | wc -l | tr -d ' ')
  echo "  Displays:"
  echo "$screens" | while read -r i x y w h b name; do echo "    $i) $name  ${w%.*}x${h%.*}$([[ $b == 1 ]] && echo '  (laptop)')"; done
  if system_profiler SPDisplaysDataType 2>/dev/null | grep -q "Mirror: On"; then
    warn "Displays are MIRRORED. The audience would see your speaker notes."
    warn "Turn mirroring off: System Settings > Displays > (projector) > Use as: Extended display"
  fi
  builtin_idx=$(echo "$screens" | awk '$6==1{print $1; exit}')
  sp="${PRESENT_SPEAKER:-${builtin_idx:-1}}"
  au="${PRESENT_AUDIENCE:-$(echo "$screens" | awk -v sp="$sp" '$1!=sp{print $1; exit}')}"
  geom() { echo "$screens" | awk -v i="$1" '$1==i{printf "%d %d %d %d", $2, $3, $4, $5}'; }
  if [[ $MODE == stage ]]; then
    [[ "$FOLLOW_PORT" == 0 ]] && die "--stage needs the phone view (followAlong on)"
    read -r X Y W H <<<"$(geom "$sp")"
    AU_POS="$X,$((Y + 25))"; AU_SIZE="$((W * 70 / 100)),$((H - 25))"
    SP_POS="$((X + W * 70 / 100)),$((Y + 25))"; SP_SIZE="$((W * 30 / 100)),$((H - 25))"
    AU_FS=()
    ok "stage layout on display $sp: record the left window (or the whole screen)"
  elif [[ -z "$au" || "$count" -lt 2 ]]; then
    warn "Only one display: rehearsal mode (both windows on this screen, audience not fullscreen)"
    read -r X Y W H <<<"$(geom 1)"
    AU_POS="$X,$((Y + 25))"; AU_SIZE="$((W * 55 / 100)),$((W * 55 / 100 * 9 / 16 + 30))"
    SP_POS="$((X + W * 55 / 100)),$((Y + 25))"; SP_SIZE="$((W * 45 / 100)),$((H - 25))"
    AU_FS=()
  else
    read -r X Y W H <<<"$(geom "$au")"; AU_POS="$X,$Y"; AU_SIZE="$W,$H"
    read -r X Y W H <<<"$(geom "$sp")"; SP_POS="$X,$((Y + 25))"; SP_SIZE="$W,$((H - 25))"
    AU_FS=(--start-fullscreen)
    ok "projector -> display $au, speaker view -> display $sp"
  fi
fi

if [[ $MODE == check ]]; then echo "${grn}Preflight passed.${rst}"; exit 0; fi

# --- run ------------------------------------------------------------------------
pids=()
cleanup() {
  for p in "${pids[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

python3 "$APP/serve.py" "$APP" "$TALK" "$PORT" "$FOLLOW_PORT" & pids+=($!)
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/api/deck" >/dev/null && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/api/deck" >/dev/null || die "local server did not start"

URL="http://127.0.0.1:$PORT/app/index.html"
if [[ $MODE == serve ]]; then
  echo
  echo "${bold}Serving.${rst} Open these in a browser (Chrome, for captions):"
  echo "  speaker:  $URL?view=speaker"
  echo "  audience: $URL?view=audience"
  echo "  Ctrl-C to stop."
  wait
  exit 0
fi

command -v caffeinate >/dev/null && { caffeinate -dimsu & pids+=($!); }  # no display sleep during the talk

FLAGS=(--no-first-run --no-default-browser-check --disable-features=Translate,MediaRouter
       --hide-crash-restore-bubble --disable-session-crashed-bubble --noerrdialogs
       --autoplay-policy=no-user-gesture-required --disable-sync --disable-extensions)
mkdir -p "$PROFILES/audience" "$PROFILES/speaker"

# Both windows only ever load this local app, so auto-allow camera/mic prompts
# (camera bubble, captions mic) instead of showing them in front of the audience.
"$CHROME" "${FLAGS[@]}" --user-data-dir="$PROFILES/audience" --use-fake-ui-for-media-stream \
  --window-position="$AU_POS" --window-size="$AU_SIZE" ${AU_FS[@]+"${AU_FS[@]}"} \
  --app="$([[ $MODE == stage ]] && echo "${URL%index.html}stage.html" || echo "$URL?view=audience")" >/dev/null 2>&1 & pids+=($!)
sleep 1.5
# Speaker opens last so it has keyboard focus: the clicker drives it.
# The speaker window only ever loads this local page; auto-allow its mic so
# captions start without a permission prompt in front of the audience.
# The recorder (V) captures the projector window, picked by its title.
CAPTURE="$([[ $MODE == stage ]] && echo "lectern stage" || echo "Audience")"
"$CHROME" "${FLAGS[@]}" --user-data-dir="$PROFILES/speaker" --use-fake-ui-for-media-stream \
  --auto-select-desktop-capture-source="$CAPTURE" \
  --window-position="$SP_POS" --window-size="$SP_SIZE" \
  --app="$URL?view=speaker" >/dev/null 2>&1 & sp_pid=$!; pids+=($sp_pid)

echo
echo "${bold}Presenting.${rst} Keep the speaker window focused; the clicker drives it."
echo "  Q shows the QR code · C captions on the projector · M pauses the captions mic"
echo "  V records the talk · W camera bubble on the slides · archive: http://127.0.0.1:$PORT/archive"
echo "  T starts the timer · B blacks the projector · close the speaker window (or Ctrl-C) to quit"
echo "  Before going on: turn on Do Not Disturb, quit Slack/Mail, plug in power."

# Exit when the speaker window closes; cleanup closes everything else.
wait "$sp_pid" 2>/dev/null || true
