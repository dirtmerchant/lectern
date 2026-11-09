# lectern

Every talk, captioned, in your hand.

Note:
Scan the QR code now. Judges' phones join live; the count shows on the speaker view.

---

## My two daughters are deaf

A conference talk is a wall of sound.

- Captions are rare, and usually only on the main stage
- Interpreters are booked for a keynote, not track 3
- Slides alone tell half the story

Note:
Tell this in your own words. Why this matters to you.

---

## Scan. Read along. That's it.

- **Live captions** on your own phone, as the speaker talks
- **The current slide**, as shown or as large text
- **Your settings**: caption size, high contrast, screen reader
- **Scroll back** and **save the transcript**

Note:
Demo the phone: change caption size, switch to large text, go back a slide, Back to live.

---

## The curb cut effect

Built for deaf and hard-of-hearing attendees. Useful for everyone:

- The back row, and anyone who can't see the screen
- Non-native speakers who read faster than they listen
- Anyone taking notes, or who stepped out for a minute
- The speaker, who gets a transcript for free

---

## How it works

- Runs on the speaker's laptop. No cloud service, no accounts, no app to install
- Captions come from the laptop mic, on-device where Chrome supports it
- Every caption saved to **Elasticsearch**, timestamped against the recording: search any talk, jump to the moment
- Phones get a **read-only** page: speaker notes never leave the laptop
- Phones can't skip ahead of the speaker
- Any Markdown deck: `./present.sh init my-talk`

Note:
Security model: two listeners. Presenter on localhost with full control; phones on a separate read-only port.

---

## Built today on yesterday's presenter

- **Before:** a two-window presenter I wrote for my ArgoCon talk
- **Today:** any deck, live captions, phone follow-along, QR join, accessibility settings, Elasticsearch archive, recording
- Built with Claude Code, disclosed in the README

---

## Try it now

<div style="display:flex;align-items:center;gap:96px;margin-top:24px">
<img src="repo-qr.svg" alt="QR code linking to github.com/dirtmerchant/lectern" style="width:520px;height:520px;max-height:none;border-radius:24px;flex:none">
<div style="display:flex;flex-direction:column;gap:28px">
<p style="font-size:64px;font-weight:600;line-height:1.15">Scan for the code</p>
<p style="font-family:'JetBrains Mono',monospace;font-size:44px;color:#E8833A">github.com/<br>dirtmerchant/<br>lectern</p>
<p style="font-size:36px;color:#9AA4AE">Open source · MIT</p>
</div>
</div>

Note:
Don't read the URL. Point at the code and let them scan.
