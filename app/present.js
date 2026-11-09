// Offline presenter for the ArgoCon deck.
//   ?view=audience  the projector: slides + clips, fullscreen
//   ?view=speaker   the laptop: previews, script, notes, timer
// The two windows run in separate Chrome instances and talk through
// serve.py (/send + /events). The audience window owns the slide state.
(async () => {
  'use strict';

  const VIEW = new URLSearchParams(location.search).get('view') === 'speaker' ? 'speaker' : 'audience';
  const TALK_END = 20 * 60 + 30;   // VOICEOVER.md: ~20.5 min talk
  const HARD_STOP = 25 * 60;       // slot length

  const $ = (id) => document.getElementById(id);
  const boot = $('boot');

  async function getText(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.text();
  }
  function send(msg) {
    return fetch('/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) })
      .catch(() => {});
  }
  const fmt = (s) => {
    const neg = s < 0; s = Math.abs(Math.round(s));
    return `${neg ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- load deck ----------
  let slides, clips, script;
  try {
    const deck = JSON.parse(await getText('/deck/deck.json'));
    clips = JSON.parse(await getText('/tools/present/clips.json'));
    const parser = new DOMParser();
    slides = [];
    for (const id of deck.order) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`bad slide id: ${id}`);
      const doc = parser.parseFromString(await getText(`/deck/slides/${id}.html`), 'text/html');
      const section = doc.querySelector('section');
      if (!section) throw new Error(`deck/slides/${id}.html has no <section>`);
      if (section.hasAttribute('hidden')) continue;
      const aside = section.querySelector(':scope > aside');
      const notes = aside ? aside.textContent.trim() : '';
      if (aside) aside.remove();
      slides.push({ id, section, notes, clip: clips[id] || null });
    }
    script = parseVoiceover(await getText('/VOICEOVER.md'));
  } catch (e) {
    boot.textContent = `Could not load the deck.\n\n${e.message}`;
    boot.classList.add('error');
    return;
  }
  boot.remove();

  // ---------- VOICEOVER.md → per-slide script + target times ----------
  function parseVoiceover(md) {
    const out = { byId: {}, qa: '' };
    const heads = [...md.matchAll(/^## (\d+) · ([A-Za-z0-9-]+) \(([0-9:]+)\)(.*)$/gm)];
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
  const scriptFor = (s) => script.byId[s.clip ? s.clip.script : s.id] || null;
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

  // ---------- slide rendering ----------
  const videoCache = {};
  function clipVideo(clip) {
    if (!videoCache[clip.video]) {
      const v = document.createElement('video');
      v.src = '/' + clip.video;
      v.poster = '/' + clip.poster;
      v.preload = 'auto';
      v.muted = true;
      v.playsInline = true;
      videoCache[clip.video] = v;
    }
    return videoCache[clip.video];
  }

  function connectorSvg(el) {
    const n = (a) => parseFloat(el.getAttribute(a));
    const [x1, y1, x2, y2] = [n('x1'), n('y1'), n('x2'), n('y2')];
    const color = el.style.color || '#000';
    const w = parseFloat(el.style.borderWidth) || 2;
    const dashed = /dash/.test(el.style.borderStyle) ? `${w * 3} ${w * 2}` : /dot/.test(el.style.borderStyle) ? `${w} ${w * 1.5}` : '';
    const head = el.getAttribute('head') || 'end';
    const L = Math.max(14, w * 4.5), H = L * 0.55;
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const tri = (x, y, sx, sy) => `${x},${y} ${x - sx * L - sy * H},${y - sy * L + sx * H} ${x - sx * L + sy * H},${y - sy * L - sx * H}`;
    let ax = x1, ay = y1, bx = x2, by = y2, polys = '';
    if (head === 'end' || head === 'both') { bx -= ux * L * 0.9; by -= uy * L * 0.9; polys += `<polygon points="${tri(x2, y2, ux, uy)}" fill="${color}"/>`; }
    if (head === 'both') { ax += ux * L * 0.9; ay += uy * L * 0.9; polys += `<polygon points="${tri(x1, y1, -ux, -uy)}" fill="${color}"/>`; }
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('style', 'position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none');
    svg.innerHTML = `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${color}" stroke-width="${w}"${dashed ? ` stroke-dasharray="${dashed}"` : ''}/>${polys}`;
    return svg;
  }

  // live = audience (real <video>); otherwise a still poster for previews
  function buildCanvas(slide, live) {
    const canvas = document.createElement('div');
    canvas.className = 'canvas';
    const sec = slide.section.cloneNode(true);
    sec.removeAttribute('id');
    // Slides format: a section/div with no display is a flex column;
    // display:flex with no direction is a row (plain CSS).
    [sec, ...sec.querySelectorAll('div')].forEach((d) => {
      if (!d.style.display) { d.style.display = 'flex'; if (!d.style.flexDirection) d.style.flexDirection = 'column'; }
    });
    sec.querySelectorAll('x-connector').forEach((c) => c.replaceWith(connectorSvg(c)));
    // "one padding per table": a padding on any cell applies to every cell
    sec.querySelectorAll('table').forEach((t) => {
      const padded = [...t.querySelectorAll('th,td')].find((c) => c.style.padding);
      if (padded) t.querySelectorAll('th,td').forEach((c) => { c.style.padding = padded.style.padding; });
    });
    sec.querySelectorAll('img[data-video]').forEach((img) => {
      if (!slide.clip) return;
      if (live) {
        const v = clipVideo(slide.clip);
        v.setAttribute('style', img.getAttribute('style') || '');
        img.replaceWith(v);
      } else {
        img.src = '/' + slide.clip.poster;
      }
    });
    canvas.appendChild(sec);
    return canvas;
  }

  // Slides format: an over-full slide shrinks its flow text (never below
  // 60%) instead of overflowing. Needs the canvas attached to measure.
  function shrinkToFit(canvas) {
    const sec = canvas.firstElementChild;
    if (!sec || sec.dataset.fitted) return;
    sec.dataset.fitted = '1';
    const cs = getComputedStyle(sec);
    const limit = sec.clientHeight - parseFloat(cs.paddingBottom) + 2;
    const flow = [...sec.children].filter((c) => getComputedStyle(c).position !== 'absolute');
    const bottom = () => Math.max(0, ...flow.map((c) => c.offsetTop + c.offsetHeight));
    if (bottom() <= limit) return;
    const texts = flow.flatMap((c) => [c, ...c.querySelectorAll('h1,h2,h3,p,li,td,th,ul,ol,table')])
      .filter((el) => /^(H1|H2|H3|P|LI|TD|TH|UL|OL|TABLE)$/.test(el.tagName));
    const orig = texts.map((el) => parseFloat(getComputedStyle(el).fontSize));
    for (let f = 0.97; f >= 0.6; f -= 0.03) {
      texts.forEach((el, i) => { el.style.fontSize = `${(orig[i] * f).toFixed(1)}px`; });
      if (bottom() <= limit) return;
    }
  }

  function fit(canvas, box) {
    shrinkToFit(canvas);
    const s = Math.min(box.clientWidth / 1920, box.clientHeight / 1080);
    const x = (box.clientWidth - 1920 * s) / 2, y = (box.clientHeight - 1080 * s) / 2;
    canvas.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  }

  if (VIEW === 'audience') audience(); else speaker();

  // ======================================================================
  // AUDIENCE
  // ======================================================================
  function audience() {
    $('audience').hidden = false;
    document.title = 'Audience';
    const stage = $('stage');
    let index = 0, black = false, current = null;

    // Preload every clip so the first frame is instant.
    slides.forEach((s) => { if (s.clip) clipVideo(s.clip).load(); });

    const curVideo = () => (slides[index].clip ? clipVideo(slides[index].clip) : null);
    function clipPhase(v) {
      if (!v) return null;
      if (v.ended) return 'ended';
      if (!v.paused) return 'playing';
      return v.currentTime > 0.05 ? 'paused' : 'ready';
    }

    function publish() {
      const v = curVideo();
      send({
        t: 'state', index, total: slides.length, id: slides[index].id, black,
        clip: v ? { phase: clipPhase(v), time: v.currentTime || 0, dur: v.duration || 0 } : null,
      });
    }

    function show(i) {
      i = Math.max(0, Math.min(slides.length - 1, i));
      // Leaving a clip slide: stop and rewind so a revisit starts clean.
      const old = curVideo();
      if (old && i !== index) { old.pause(); old.currentTime = 0; }
      index = i;
      const next = buildCanvas(slides[index], true);
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
      // Preview slides never hold the live <video>, so nothing else to move.
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
    es.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'cmd') run(m.cmd, m.arg);
      if (m.t === 'state' && !resumed) { resumed = true; if (m.index !== index) show(m.index); }
    };

    keyHandler(run, { audience: true });
    addEventListener('resize', () => { if (current) fit(current, stage); });

    // Hide the cursor when idle.
    let idleT;
    addEventListener('mousemove', () => { $('audience').classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => $('audience').classList.add('idle'), 1500); });

    setInterval(publish, 2000); // heartbeat so the speaker view knows we're alive
    const start = parseInt(new URLSearchParams(location.search).get('slide') || '1', 10) - 1;
    if (start > 0) resumed = true;
    show(start);
  }

  // ======================================================================
  // SPEAKER
  // ======================================================================
  function speaker() {
    $('speaker').hidden = false;
    document.title = 'Speaker';
    let state = null, lastSeen = 0, lastError = '';

    // Script size, remembered per machine
    let size = 24;
    try { size = +localStorage.getItem('scriptSize') || 24; } catch (e) {}
    const applySize = () => document.documentElement.style.setProperty('--script-size', size + 'px');
    applySize();

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
      if (state && (timer.start || t > 0)) {
        const lo = targetOf(state.index);
        let hi = TALK_END;
        for (let j = state.index + 1; j < slides.length; j++) { const tj = targetOf(j); if (tj != null && tj > (lo ?? -1)) { hi = tj; break; } }
        if (lo == null) { pace.textContent = ''; pace.className = ''; }
        else if (t < lo - 15) { pace.textContent = `AHEAD ${fmt(lo - t)}`; pace.className = 'ahead'; }
        else if (t > hi + 15) { pace.textContent = `BEHIND ${fmt(t - hi)}`; pace.className = 'behind'; }
        else { pace.textContent = 'ON PACE'; pace.className = 'ok'; }
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
      if (i !== shownIndex) {
        shownIndex = i;
        const sc = scriptFor(s);
        $('sp-num').textContent = `${i + 1} / ${slides.length}`;
        $('sp-id').textContent = s.id + (s.clip ? '  ·  CLIP' : '');
        const lo = targetOf(i);
        $('sp-target').textContent = lo != null ? `slide target ${fmt(lo)} · Q&A ${fmt(TALK_END)} · stop ${fmt(HARD_STOP)}` : '';

        const box = $('sp-current');
        box.innerHTML = '';
        curCanvas = buildCanvas(s, false);
        box.appendChild(curCanvas);
        if (s.clip) box.insertAdjacentHTML('beforeend', '<div class="badge">CLIP</div>');

        const nb = $('sp-next');
        nb.innerHTML = '';
        nextCanvas = null;
        if (i + 1 < slides.length) {
          const n = slides[i + 1];
          nextCanvas = buildCanvas(n, false);
          nb.appendChild(nextCanvas);
          if (n.clip) nb.insertAdjacentHTML('beforeend', '<div class="badge">CLIP</div>');
          $('sp-next-label').textContent = `NEXT · ${n.id}`;
        } else {
          $('sp-next-label').textContent = 'NEXT · end of deck';
        }
        fitPreviews();

        let html = '';
        if (sc) {
          const head = `script · ${s.clip ? s.clip.script : s.id} · ${fmt(sc.target)}${sc.extra ? ' · ' + sc.extra : ''}`;
          html = `<h4>${esc(head)}</h4>${mdToHtml(sc.body)}`;
        } else {
          html = '<h4>No VOICEOVER.md section for this slide</h4>';
        }
        if (i === slides.length - 1 && script.qa) html += `<div class="qa"><h4>Q&amp;A prep</h4>${mdToHtml(script.qa)}</div>`;
        $('sp-script').innerHTML = html;
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
    };
    es.onopen = () => send({ t: 'cmd', cmd: 'hello' });

    const cmd = (c, arg) => send({ t: 'cmd', cmd: c, arg });
    keyHandler(cmd, {
      speaker: true,
      timer: toggleTimer,
      reset: resetTimer,
      size: (d) => { size = Math.max(16, Math.min(40, size + d)); applySize(); try { localStorage.setItem('scriptSize', size); } catch (e) {} },
    });
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
