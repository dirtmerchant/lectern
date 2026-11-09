#!/usr/bin/env bash
# Opens the deck for presenting, fully offline:
#   projector  -> audience window, fullscreen (slides + recorded clips)
#   laptop     -> speaker window (current/next slide, VOICEOVER.md script, notes, timer)
#
# Usage: tools/present.sh            # or: make present
#        tools/present.sh --check    # preflight only, opens nothing
#
# Env overrides:
#   PRESENT_AUDIENCE=<n>  display number for the projector (see the list it prints)
#   PRESENT_SPEAKER=<n>   display number for the speaker view
#   PRESENT_PORT=<port>   local server port (default 8765)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PRESENT_PORT:-8765}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILES="${TMPDIR:-/tmp}/argocon-present"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

bold=$'\033[1m'; red=$'\033[31m'; grn=$'\033[32m'; yel=$'\033[33m'; rst=$'\033[0m'
ok()   { echo "  ${grn}✓${rst} $*"; }
warn() { echo "  ${yel}!${rst} $*"; }
die()  { echo "  ${red}✗ $*${rst}"; exit 1; }

echo "${bold}Preflight${rst}"

# --- files -------------------------------------------------------------------
[[ -f "$ROOT/deck/deck.json" ]] || die "deck/deck.json missing"
missing=$(cd "$ROOT" && python3 - <<'EOF'
import json, os
deck = json.load(open("deck/deck.json"))
clips = json.load(open("tools/present/clips.json"))
miss = [f"deck/slides/{i}.html" for i in deck["order"] if not os.path.isfile(f"deck/slides/{i}.html")]
for c in clips.values():
    miss += [p for p in (c["video"], c["poster"]) if not os.path.isfile(p)]
print("\n".join(miss))
EOF
)
[[ -z "$missing" ]] || die "missing files:"$'\n'"$missing"
ok "deck: $(python3 -c "import json;print(len(json.load(open('$ROOT/deck/deck.json'))['order']))" ) slides, 3 clips, VOICEOVER.md"
[[ -f "$ROOT/VOICEOVER.md" ]] || warn "VOICEOVER.md missing: speaker view will have notes only"
[[ -x "$CHROME" ]] || die "Google Chrome not found at /Applications/Google Chrome.app"
ok "Chrome found"

# --- displays ----------------------------------------------------------------
# One line per display: index x y w h builtin name   (top-left origin, points)
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

if [[ -z "$au" || "$count" -lt 2 ]]; then
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

# --- port --------------------------------------------------------------------
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "port $PORT is busy (presenter already running?). Close it, or PRESENT_PORT=8799 make present"
fi
ok "port $PORT free"

if [[ $CHECK_ONLY == 1 ]]; then echo "${grn}Preflight passed.${rst}"; exit 0; fi

# --- run ---------------------------------------------------------------------
pids=()
cleanup() {
  for p in "${pids[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

python3 "$ROOT/tools/present/serve.py" "$ROOT" "$PORT" & pids+=($!)
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/deck/deck.json" >/dev/null && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/deck/deck.json" >/dev/null || die "local server did not start"

caffeinate -dimsu & pids+=($!)   # no display sleep / screensaver during the talk

URL="http://127.0.0.1:$PORT/tools/present/index.html"
FLAGS=(--no-first-run --no-default-browser-check --disable-features=Translate,MediaRouter
       --hide-crash-restore-bubble --disable-session-crashed-bubble --noerrdialogs
       --autoplay-policy=no-user-gesture-required --disable-sync --disable-extensions)
mkdir -p "$PROFILES/audience" "$PROFILES/speaker"

"$CHROME" "${FLAGS[@]}" --user-data-dir="$PROFILES/audience" \
  --window-position="$AU_POS" --window-size="$AU_SIZE" ${AU_FS[@]+"${AU_FS[@]}"} \
  --app="$URL?view=audience" >/dev/null 2>&1 & pids+=($!)
sleep 1.5
# Speaker opens last so it has keyboard focus: the clicker drives it.
"$CHROME" "${FLAGS[@]}" --user-data-dir="$PROFILES/speaker" \
  --window-position="$SP_POS" --window-size="$SP_SIZE" \
  --app="$URL?view=speaker" >/dev/null 2>&1 & sp_pid=$!; pids+=($sp_pid)

echo
echo "${bold}Presenting.${rst} Keep the speaker window focused; the clicker drives it."
echo "  T starts the timer · B blacks the projector · close the speaker window (or Ctrl-C here) to quit"
echo "  Before going on: turn on Do Not Disturb, quit Slack/Mail, plug in power."

# Exit when the speaker window closes; cleanup closes everything else.
wait "$sp_pid" 2>/dev/null || true
