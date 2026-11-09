// lectern presenter.
//   ?view=audience  the projector: slides + clips, fullscreen
//   ?view=speaker   the laptop: previews, script, notes, timer, follow-along
// The two windows run in separate Chrome instances and talk through
// serve.py (/send + /events). The audience window owns the slide state.
(async () => {
  'use strict';

  const VIEW = new URLSearchParams(location.search).get('view') === 'speaker' ? 'speaker' : 'audience';
  const { buildCanvas, fit } = window.Lectern;

  const $ = (id) => document.getElementById(id);
  const boot = $('boot');

  function send(msg) {
    return fetch('/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) })
      .catch(() => {});
  }
  const fmt = (s) => {
    const neg = s < 0; s = Math.abs(Math.round(s));
    return `${neg ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- load the talk ----------
  let deck, slides, script;
  try {
    const r = await fetch('/api/deck', { cache: 'no-store' });
    if (!r.ok) throw new Error(`/api/deck: HTTP ${r.status}`);
    deck = await r.json();
    slides = deck.slides;
    script = deck.script ? parseVoiceover(deck.script) : { byId: {}, qa: '' };
  } catch (e) {
    boot.textContent = `Could not load the talk.\n\n${e.message}`;
    boot.classList.add('error');
    return;
  }
  boot.remove();
  const TALK_END = Math.round(deck.talkMinutes * 60);
  const HARD_STOP = Math.round(deck.slotMinutes * 60);
  const follow = deck.follow; // { url, qrOnSlides, shareScript } or null
  const captionsCfg = deck.captions || { enabled: false };

  // ---------- script file → per-slide script + target times ----------
  // Sections look like:  ## 3 · slide-id (2:15) · optional label
  function parseVoiceover(md) {
    const out = { byId: {}, qa: '' };
    const heads = [...md.matchAll(/^## (\d+) · ([A-Za-z0-9_-]+) \(([0-9:]+)\)(.*)$/gm)];
    heads.forEach((m, i) => {
      const start = m.index + m[0].length;
      let end = i + 1 < heads.length ? heads[i + 1].index : md.length;
      const rule = md.indexOf('\n---', start);
      if (rule !== -1 && rule < end) end = rule;
      const [mm, ss] = m[3].split(':').map(Number);
      out.byId[m[2]] = { num: m[1], target: mm * 60 + ss, extra: m[4].replace(/^\s*·\s*/, '').trim(), body: md.slice(start, end).trim() };
    });
    const qa = md.indexOf('## Q&A prep');
    if (qa !== -1) out.qa = md.slice(qa + '## Q&A prep'.length).trim();
    return out;
  }
  const scriptFor = (s) => script.byId[s.clip && s.clip.script ? s.clip.script : s.id] || null;
  const targetOf = (i) => { const sc = slides[i] && scriptFor(slides[i]); return sc ? sc.target : null; };

  function mdToHtml(text) {
    return text.split(/\n\s*\n/).map((para) => {
      let h = esc(para.trim());
      h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
      h = h.replace(/\[([^\]]+)\]/g, '<span class="dir">[$1]</span>');
      h = h.replace(/\n/g, '<br>');
      return `<p>${h}</p>`;
    }).join('');
  }

  // QR code as inline SVG (qrcode-generator, vendored)
  function qrSvg(text) {
    const q = window.qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }

  // ---------- clips ----------
  const videoCache = {};
  function clipVideo(slide) {
    const clip = slide.clip;
    if (!videoCache[clip.video]) {
      const v = document.createElement('video');
      v.src = '/talk/' + clip.video;
      if (clip.poster) v.poster = '/talk/' + clip.poster;
      v.preload = 'auto';
      v.muted = true;
      v.playsInline = true;
      videoCache[clip.video] = v;
    }
    return videoCache[clip.video];
  }

  if (VIEW === 'audience') audience(); else speaker();

  // ======================================================================
  // AUDIENCE
  // ======================================================================
  function audience() {
    $('audience').hidden = false;
    document.title = 'Audience';
    const stage = $('stage');
    let index = 0, black = false, current = null, qr = false, cc = !!captionsCfg.onProjector;

    // Live captions bar (captions come from the speaker window via /events)
    const ccLines = [];
    let ccInterim = '';
    function setCc(on) { cc = !!(on && captionsCfg.enabled); $('cc').classList.toggle('on', cc && (ccLines.length || ccInterim)); }
    function renderCc() {
      const box = $('cc').querySelector('.cc-text');
      box.innerHTML = '';
      ccLines.slice(-2).forEach((t) => { const d = document.createElement('div'); d.textContent = t; box.appendChild(d); });
      if (ccInterim) { const d = document.createElement('div'); d.className = 'interim'; d.textContent = ccInterim; box.appendChild(d); }
      $('cc').classList.toggle('on', cc && !!(ccLines.length || ccInterim));
    }
    function onCaption(m) {
      if (m.final) { ccInterim = ''; if (m.text) ccLines.push(m.text); ccLines.splice(0, Math.max(0, ccLines.length - 4)); }
      else ccInterim = m.text;
      renderCc();
    }
    if (captionsCfg.enabled) $('cc').hidden = false;

    if (follow && follow.url) {
      $('qr').hidden = false;
      $('qr').querySelector('.qr-code').innerHTML = qrSvg(follow.url);
      $('qr').querySelector('.qr-url').textContent = follow.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }
    const autoQr = (i) => !!(follow && follow.qrOnSlides.includes(slides[i].id));
    function setQr(on) {
      qr = !!(on && follow && follow.url);
      $('qr').classList.toggle('on', qr);
    }

    // Preload every clip so the first frame is instant.
    slides.forEach((s) => { if (s.clip) clipVideo(s).load(); });

    const curVideo = () => (slides[index].clip ? clipVideo(slides[index]) : null);
    function clipPhase(v) {
      if (!v) return null;
      if (v.ended) return 'ended';
      if (!v.paused) return 'playing';
      return v.currentTime > 0.05 ? 'paused' : 'ready';
    }

    // Don't announce a position until we've heard the server's last known
    // one; otherwise a reloaded window would reset the talk to slide 1.
    let ready = false;
    function publish() {
      if (!ready) return;
      const v = curVideo();
      send({
        t: 'state', index, total: slides.length, id: slides[index].id, black, qr, cc,
        clip: v ? { phase: clipPhase(v), time: v.currentTime || 0, dur: v.duration || 0 } : null,
      });
    }

    function show(i) {
      i = Math.max(0, Math.min(slides.length - 1, i));
      // Leaving a clip slide: stop and rewind so a revisit starts clean.
      const old = curVideo();
      if (old && i !== index) { old.pause(); old.currentTime = 0; }
      const changed = i !== index || !current;
      index = i;
      if (changed) setQr(autoQr(i));
      const next = buildCanvas(slides[index], { video: clipVideo });
      const prev = current;
      if (prev) next.style.opacity = '0'; // first slide appears instantly
      stage.appendChild(next);
      fit(next, stage);
      current = next;
      if (prev) {
        void next.offsetWidth; // commit opacity:0 so the fade runs
        next.style.opacity = '1';
        setTimeout(() => prev.remove(), 320);
      }
      publish();
    }

    function nextCmd() {
      const v = curVideo();
      const ph = clipPhase(v);
      if (ph === 'ready' || ph === 'paused') { v.play().catch(() => {}); return; }
      if (index < slides.length - 1) show(index + 1);
    }
    function prevCmd() {
      const v = curVideo();
      const ph = clipPhase(v);
      if (ph && ph !== 'ready') { v.pause(); v.currentTime = 0; publish(); return; }
      if (index > 0) show(index - 1);
    }
    function clipToggle() { const v = curVideo(); if (!v) return; if (v.paused) v.play().catch(() => {}); else v.pause(); }
    function clipRestart() { const v = curVideo(); if (!v) return; v.pause(); v.currentTime = 0; publish(); }
    function setBlack(on) { black = on; $('black').classList.toggle('on', black); publish(); }

    function run(cmd, arg) {
      switch (cmd) {
        case 'next': return nextCmd();
        case 'prev': return prevCmd();
        case 'goto': return show(arg);
        case 'first': return show(0);
        case 'last': return show(slides.length - 1);
        case 'black': return setBlack(!black);
        case 'qr': setQr(!qr); return publish();
        case 'cc': setCc(!cc); renderCc(); return publish();
        case 'clipToggle': return clipToggle();
        case 'clipRestart': return clipRestart();
        case 'hello': return publish();
      }
    }

    // Video events → speaker
    let lastTick = 0;
    Object.values(videoCache).forEach((v) => {
      ['play', 'pause', 'ended', 'seeked', 'loadedmetadata'].forEach((ev) => v.addEventListener(ev, publish));
      v.addEventListener('timeupdate', () => { const now = performance.now(); if (now - lastTick > 400) { lastTick = now; publish(); } });
      v.addEventListener('error', () => send({ t: 'error', msg: `Clip failed to load: ${v.src}` }));
    });

    // The server replays the last known state on connect, so a reloaded
    // audience window comes back on the slide it was showing.
    let resumed = false;
    const es = new EventSource('/events');
    const goLive = () => { if (!ready) { ready = true; publish(); } };
    setTimeout(goLive, 1500); // fresh start: nothing to resume
    es.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'followers' && !resumed) { resumed = true; goLive(); } // replay had no state
      if (m.t === 'cmd') run(m.cmd, m.arg);
      if (m.t === 'caption') onCaption(m);
      if (m.t === 'state' && !resumed) {
        resumed = true;
        if (m.index !== index) show(m.index);
        if (m.black) setBlack(true);
        if (typeof m.cc === 'boolean') setCc(m.cc);
        goLive();
      }
    };

    keyHandler(run, { audience: true });
    addEventListener('resize', () => { if (current) fit(current, stage); });

    // Hide the cursor when idle.
    let idleT;
    addEventListener('mousemove', () => { $('audience').classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => $('audience').classList.add('idle'), 1500); });

    setInterval(publish, 2000); // heartbeat so the speaker view knows we're alive
    const start = parseInt(new URLSearchParams(location.search).get('slide') || '1', 10) - 1;
    if (start > 0) { resumed = true; ready = true; }
    show(start);
  }

  // ======================================================================
  // SPEAKER
  // ======================================================================
  function speaker() {
    $('speaker').hidden = false;
    document.title = 'Speaker';
    let state = null, lastSeen = 0, lastError = '', followers = 0;
    const hasScript = Object.keys(script.byId).length > 0;

    // Script size, remembered per machine
    let size = 24;
    try { size = +localStorage.getItem('scriptSize') || 24; } catch (e) {}
    const applySize = () => document.documentElement.style.setProperty('--script-size', size + 'px');
    applySize();

    // ----- follow-along panel -----
    if (follow && follow.url) {
      $('sp-follow').hidden = false;
      $('sp-follow').querySelector('.f-code').innerHTML = qrSvg(follow.url);
      $('sp-follow').querySelector('.f-url').textContent = follow.url;
    }
    function renderFollow() {
      if (!follow) return;
      $('sp-follow').querySelector('.f-count').textContent = `${followers} ${followers === 1 ? 'phone' : 'phones'} following`;
      const q = $('sp-follow').querySelector('.f-qr');
      const on = !!(state && state.qr);
      q.textContent = on ? 'QR code is ON the projector · Q hides it' : 'Q shows the QR code on the projector';
      q.classList.toggle('on', on);
    }

    // ----- live captions (speech → text in this window, relayed to phones) -----
    // Chrome's Web Speech API. On-device recognition is used when Chrome has
    // the language model; otherwise Chrome sends audio to its cloud service.
    const cap = { on: false, rec: null, session: 0, mode: '', lastSent: 0, pending: null, last: '' };
    function capStatus(cls, label) {
      const el = $('sp-captions');
      el.className = cls;
      el.querySelector('.c-label').textContent = label;
    }
    function capShow(text) { $('sp-captions').querySelector('.c-text').textContent = text; }
    async function capStart() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { capStatus('error', 'Captions: this browser has no speech recognition'); return; }
      const lang = captionsCfg.lang || 'en-US';
      const rec = new SR();
      rec.lang = lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
      cap.mode = 'cloud';
      try {
        if (typeof SR.available === 'function') {
          const a = await SR.available({ langs: [lang], processLocally: true });
          if (a === 'available') { rec.processLocally = true; cap.mode = 'on-device'; }
          else if ((a === 'downloadable' || a === 'downloading') && typeof SR.install === 'function') {
            SR.install({ langs: [lang], processLocally: true }).catch(() => {});
            cap.mode = 'cloud (on-device model downloading)';
          }
        }
      } catch (e) { cap.mode = 'cloud'; }
      rec.onstart = () => capStatus('live', `CAPTIONS LIVE · ${lang} · ${cap.mode} · M to pause`);
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const text = r[0].transcript.trim();
          const id = `${cap.session}-${i}`;
          if (r.isFinal) { cap.pending = null; capSend(id, text, true); }
          else capInterim(id, text);
        }
      };
      rec.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          cap.on = false; capStatus('error', 'Captions: microphone blocked. Allow the mic for this window, then press M');
        } else capStatus('error', `Captions: ${e.error} (retrying)`);
      };
      rec.onend = () => {
        // Chrome ends a session after silence or ~1 min; keep it going.
        if (cap.on) setTimeout(() => { if (cap.on) { cap.session++; try { rec.start(); } catch (e) {} } }, 250);
        else capStatus('off', 'Captions paused · M to resume');
      };
      cap.rec = rec; cap.on = true; cap.session++;
      try { rec.start(); } catch (e) { capStatus('error', `Captions: ${e.message}`); }
    }
    function capSend(id, text, final) {
      cap.lastSent = performance.now();
      if (final && text) { cap.last = text; capShow(text); }
      else if (!final) capShow((cap.last ? cap.last + ' ' : '') + text);
      send({ t: 'caption', id, text, final });
    }
    function capInterim(id, text) {
      // At most ~4 interim updates a second so phones on bad wifi keep up.
      cap.pending = { id, text };
      const wait = 250 - (performance.now() - cap.lastSent);
      if (wait <= 0) { const p = cap.pending; cap.pending = null; capSend(p.id, p.text, false); }
      else if (!cap.timer) cap.timer = setTimeout(() => { cap.timer = null; if (cap.pending) { const p = cap.pending; cap.pending = null; capSend(p.id, p.text, false); } }, wait);
    }
    function capToggle() {
      if (!captionsCfg.enabled) return;
      if (cap.on) { cap.on = false; try { cap.rec.stop(); } catch (e) {} }
      else if (cap.rec) { cap.on = true; cap.session++; try { cap.rec.start(); } catch (e) {} }
      else capStart();
    }
    if (captionsCfg.enabled) { $('sp-captions').hidden = false; capStart(); }

    // ----- timer (survives reloads) -----
    let timer = { start: null, acc: 0 };
    try { timer = JSON.parse(localStorage.getItem('timer')) || timer; } catch (e) {}
    const saveTimer = () => { try { localStorage.setItem('timer', JSON.stringify(timer)); } catch (e) {} };
    const elapsed = () => timer.acc + (timer.start ? (Date.now() - timer.start) / 1000 : 0);
    function toggleTimer() {
      if (timer.start) { timer.acc = elapsed(); timer.start = null; } else timer.start = Date.now();
      saveTimer(); tick();
    }
    let resetArmed = 0;
    function resetTimer() {
      // Press R twice within 2s so a stray key can't wipe the clock mid-talk.
      if (Date.now() - resetArmed > 2000) { resetArmed = Date.now(); flash('Press R again to reset the timer'); return; }
      timer = { start: null, acc: 0 }; saveTimer(); tick(); flash('');
    }
    let flashT;
    function flash(msg) {
      clearTimeout(flashT);
      $('sp-goto').textContent = msg;
      if (msg) flashT = setTimeout(() => { $('sp-goto').textContent = gotoBuf ? `go to ${gotoBuf}` : ''; }, 2000);
    }

    function tick() {
      const t = elapsed();
      const el = $('sp-elapsed');
      el.textContent = fmt(t);
      el.classList.toggle('stopped', !timer.start);
      if (!timer.start && t === 0) el.textContent = 'T to start';
      $('sp-wall').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const pace = $('sp-pace');
      if (state && hasScript && (timer.start || t > 0)) {
        const lo = targetOf(state.index);
        let hi = TALK_END;
        for (let j = state.index + 1; j < slides.length; j++) { const tj = targetOf(j); if (tj != null && tj > (lo ?? -1)) { hi = tj; break; } }
        if (lo == null) { pace.textContent = ''; pace.className = ''; }
        else if (t < lo - 15) { pace.textContent = `AHEAD ${fmt(lo - t)}`; pace.className = 'ahead'; }
        else if (t > hi + 15) { pace.textContent = `BEHIND ${fmt(t - hi)}`; pace.className = 'behind'; }
        else { pace.textContent = 'ON PACE'; pace.className = 'ok'; }
      } else if (!hasScript && (timer.start || t > 0)) {
        // No script: just warn against the talk length.
        if (t > HARD_STOP) { pace.textContent = `OVER ${fmt(t - HARD_STOP)}`; pace.className = 'behind'; }
        else if (t > TALK_END) { pace.textContent = 'WRAP UP'; pace.className = 'behind'; }
        else { pace.textContent = `${fmt(TALK_END - t)} left`; pace.className = 'ok'; }
      } else { pace.textContent = ''; pace.className = ''; }

      // Audience connection + errors
      const alert = $('sp-alert');
      if (Date.now() - lastSeen > 5000) { alert.hidden = false; alert.className = ''; alert.textContent = 'Audience window not connected — slides on the projector are NOT following'; }
      else if (state && state.black) { alert.hidden = false; alert.className = 'warn'; alert.textContent = 'Projector is BLACK — press B to bring it back'; }
      else if (lastError) { alert.hidden = false; alert.className = ''; alert.textContent = lastError; }
      else alert.hidden = true;
    }
    setInterval(tick, 250);

    // ----- render -----
    let shownIndex = -1, curCanvas = null, nextCanvas = null;
    function render() {
      if (!state) return;
      const i = state.index;
      const s = slides[i];
      if (!s) return;
      if (i !== shownIndex) {
        shownIndex = i;
        const sc = scriptFor(s);
        $('sp-num').textContent = `${i + 1} / ${slides.length}`;
        $('sp-id').textContent = s.id + (s.clip ? '  ·  CLIP' : '');
        const lo = targetOf(i);
        $('sp-target').textContent = lo != null
          ? `slide target ${fmt(lo)} · Q&A ${fmt(TALK_END)} · stop ${fmt(HARD_STOP)}`
          : `talk ${fmt(TALK_END)} · stop ${fmt(HARD_STOP)}`;

        const box = $('sp-current');
        box.innerHTML = '';
        curCanvas = buildCanvas(s);
        box.appendChild(curCanvas);
        if (s.clip) box.insertAdjacentHTML('beforeend', '<div class="badge">CLIP</div>');

        const nb = $('sp-next');
        nb.innerHTML = '';
        nextCanvas = null;
        if (i + 1 < slides.length) {
          const n = slides[i + 1];
          nextCanvas = buildCanvas(n);
          nb.appendChild(nextCanvas);
          if (n.clip) nb.insertAdjacentHTML('beforeend', '<div class="badge">CLIP</div>');
          $('sp-next-label').textContent = `NEXT · ${n.id}`;
        } else {
          $('sp-next-label').textContent = 'NEXT · end of deck';
        }
        fitPreviews();

        let html = '';
        if (sc) {
          const head = `script · ${s.clip && s.clip.script ? s.clip.script : s.id} · ${fmt(sc.target)}${sc.extra ? ' · ' + sc.extra : ''}`;
          html = `<h4>${esc(head)}</h4>${mdToHtml(sc.body)}`;
        } else if (hasScript) {
          html = '<h4>No script section for this slide</h4>';
        } else if (s.notes) {
          html = `<h4>notes · ${esc(s.id)}</h4>${mdToHtml(s.notes)}`;
        } else {
          html = `<h4>${esc(s.id)} · no notes</h4>`;
        }
        if (i === slides.length - 1 && script.qa) html += `<div class="qa"><h4>Q&amp;A prep</h4>${mdToHtml(script.qa)}</div>`;
        $('sp-script').innerHTML = html;
        // With no script file the notes are already the main text.
        $('sp-notes-wrap').hidden = !hasScript;
        $('sp-notes').textContent = s.notes || '—';
        document.querySelector('#speaker .right').scrollTop = 0;
      }

      // Clip status
      const cb = $('sp-clip');
      if (state.clip) {
        cb.hidden = false;
        const c = state.clip;
        const label = { ready: '▶ READY — press → to PLAY', playing: '● PLAYING — → moves on', paused: '❚❚ PAUSED — → resumes', ended: '■ ENDED — → next slide' }[c.phase] || c.phase;
        $('sp-clip-text').textContent = `${label}    ${fmt(c.time)} / ${fmt(c.dur)}`;
        $('sp-clip-fill').style.width = c.dur ? `${(100 * c.time) / c.dur}%` : '0';
      } else cb.hidden = true;
      renderFollow();
      tick();
    }
    function fitPreviews() {
      if (curCanvas) fit(curCanvas, $('sp-current'));
      if (nextCanvas) fit(nextCanvas, $('sp-next'));
    }
    addEventListener('resize', fitPreviews);

    // ----- wire up -----
    const es = new EventSource('/events');
    es.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'state') { state = m; lastSeen = Date.now(); render(); }
      if (m.t === 'error') { lastError = m.msg; tick(); }
      if (m.t === 'followers') { followers = m.count; renderFollow(); }
    };
    es.onopen = () => send({ t: 'cmd', cmd: 'hello' });

    const cmd = (c, arg) => send({ t: 'cmd', cmd: c, arg });
    keyHandler(cmd, {
      speaker: true,
      timer: toggleTimer,
      mic: capToggle,
      reset: resetTimer,
      size: (d) => { size = Math.max(16, Math.min(40, size + d)); applySize(); try { localStorage.setItem('scriptSize', size); } catch (e) {} },
    });
    renderFollow();
    tick();
  }

  // ======================================================================
  // KEYS (clickers send PageDown/PageUp, arrows, or B / . for blank)
  // ======================================================================
  let gotoBuf = '';
  function keyHandler(run, opt) {
    addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave Cmd-Q etc. alone
      if (e.repeat && !['ArrowRight', 'ArrowLeft'].includes(e.key)) { e.preventDefault(); return; }
      const k = e.key;
      let handled = true;
      if (/^[0-9]$/.test(k)) { gotoBuf = (gotoBuf + k).slice(-2); showGoto(); }
      else if (k === 'Enter' && gotoBuf) { const n = parseInt(gotoBuf, 10); gotoBuf = ''; showGoto(); if (n >= 1) run('goto', n - 1); }
      else if (k === 'Escape') { gotoBuf = ''; showGoto(); }
      else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'n', 'Enter'].includes(k)) run('next');
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'].includes(k)) run('prev');
      else if (k === 'Home') run('first');
      else if (k === 'End') run('last');
      else if (k === 'b' || k === 'B' || k === '.') run('black');
      else if (k === 'q' || k === 'Q') run('qr');
      else if (k === 'c' || k === 'C') run('cc');
      else if ((k === 'm' || k === 'M') && opt.mic) opt.mic();
      else if (k === 'k' || k === 'K') run('clipToggle');
      else if (k === 'j' || k === 'J') run('clipRestart');
      else if ((k === 't' || k === 'T') && opt.timer) opt.timer();
      else if ((k === 'r' || k === 'R') && opt.reset) opt.reset();
      else if ((k === '+' || k === '=') && opt.size) opt.size(2);
      else if ((k === '-' || k === '_') && opt.size) opt.size(-2);
      else if ((k === 'f' || k === 'F') && opt.audience) { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }
      else if (k === 'F5' || k === 'Tab') { /* clicker "start show" button / stray tab: swallow */ }
      else handled = false;
      if (handled) e.preventDefault();
    });
  }
  function showGoto() { const el = $('sp-goto'); if (el) el.textContent = gotoBuf ? `go to ${gotoBuf}` : ''; }
})();
