// lectern phone view: live captions + the current slide, on the attendee's own device.
// Read-only: it only listens. Talks to the follow-along listener in serve.py.
(async () => {
  'use strict';
  const { buildCanvas, fit, readableFor } = window.Lectern;
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;

  // ---------- settings (per device) ----------
  const DEFAULTS = { layout: 'both', slidestyle: 'picture', capsize: 'm', colors: 'dark', interim: true, vibrate: false, sr: false };
  let prefs = { ...DEFAULTS };
  try { prefs = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('lectern-prefs') || '{}') }; } catch (e) {}
  if (!localStorage.getItem('lectern-prefs') && matchMedia('(prefers-contrast: more)').matches) prefs.colors = 'contrast';
  if (!localStorage.getItem('lectern-prefs') && matchMedia('(prefers-color-scheme: light)').matches) prefs.colors = 'light';
  const save = () => { try { localStorage.setItem('lectern-prefs', JSON.stringify(prefs)); } catch (e) {} };

  function applyPrefs() {
    document.body.dataset.layout = prefs.layout;
    root.dataset.capsize = prefs.capsize;
    root.dataset.colors = prefs.colors;
    document.querySelector('meta[name=theme-color]').content = prefs.colors === 'light' ? '#ffffff' : '#000000';
    $('cap-log').setAttribute('aria-live', prefs.sr ? 'polite' : 'off');
    for (const name of ['layout', 'slidestyle', 'capsize', 'colors']) {
      const el = document.querySelector(`input[name=${name}][value=${prefs[name]}]`);
      if (el) el.checked = true;
    }
    $('opt-interim').checked = prefs.interim;
    $('opt-vibrate').checked = prefs.vibrate;
    $('opt-sr').checked = prefs.sr;
  }
  document.querySelectorAll('.settings input[type=radio]').forEach((el) => el.addEventListener('change', () => {
    prefs[el.name] = el.value; save(); applyPrefs(); renderSlide(); renderInterim();
  }));
  $('opt-interim').addEventListener('change', (e) => { prefs.interim = e.target.checked; save(); renderInterim(); });
  $('opt-vibrate').addEventListener('change', (e) => { prefs.vibrate = e.target.checked; save(); });
  $('opt-sr').addEventListener('change', (e) => { prefs.sr = e.target.checked; save(); applyPrefs(); });
  function openSettings(open) {
    $('settings').hidden = !open;
    $('settings-btn').setAttribute('aria-expanded', String(open));
    if (open) $('settings').querySelector('input:checked').focus(); else $('settings-btn').focus();
  }
  $('settings-btn').addEventListener('click', () => openSettings($('settings').hidden));
  $('settings-done').addEventListener('click', () => openSettings(false));
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('settings').hidden) openSettings(false); });
  applyPrefs();

  // ---------- talk info ----------
  let info;
  for (;;) {
    try { const r = await fetch('/f/deck', { cache: 'no-store' }); if (r.ok) { info = await r.json(); break; } } catch (e) {}
    $('conn').textContent = 'waiting for the speaker…';
    await new Promise((res) => setTimeout(res, 2000));
  }
  $('title').textContent = info.title;
  document.title = `${info.title} · follow along`;
  if (!info.captions) { $('cap-off').hidden = false; $('download').hidden = true; }
  root.lang = (info.lang || 'en').split('-')[0];

  // ---------- slides ----------
  const cache = new Map(); // index -> slide
  let live = 0, furthest = info.furthest || 0, total = info.total, viewing = null, black = false; // viewing: null = follow live
  const shown = () => (viewing == null ? live : viewing);
  const maxViewable = () => (info.showAhead ? total - 1 : furthest);

  async function getSlide(i) {
    if (cache.has(i)) return cache.get(i);
    const r = await fetch(`/f/slide/${i}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const s = await r.json();
    cache.set(i, s);
    return s;
  }

  let canvas = null, renderSeq = 0;
  async function renderSlide() {
    const i = shown();
    const seq = ++renderSeq;
    const s = await getSlide(i);
    if (seq !== renderSeq) return;
    $('pos').textContent = `Slide ${i + 1} of ${total}`;
    $('prev').disabled = i <= 0;
    $('next').disabled = i >= maxViewable();
    $('live').hidden = viewing == null;
    $('browsing').hidden = viewing != null;
    $('browsing').textContent = viewing == null ? 'following live' : '';
    if (!s) return;
    const box = $('slide-box'), rd = $('readable');
    if (prefs.slidestyle === 'text') {
      box.hidden = true; rd.hidden = false;
      rd.replaceChildren(readableFor(s));
    } else {
      rd.hidden = true; box.hidden = false;
      box.replaceChildren();
      canvas = buildCanvas(s);
      box.appendChild(canvas);
      fit(canvas, box);
      const sec = canvas.firstElementChild;
      sec.setAttribute('role', 'img');
      sec.setAttribute('aria-label', `Slide ${i + 1}: ${(sec.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300)}`);
    }
    if (s.remarks) {
      $('remarks').hidden = false;
      $('remarks-text').replaceChildren(...s.remarks.split(/\n\s*\n/).map((t) => { const p = document.createElement('p'); p.textContent = t.replace(/\*+/g, ''); return p; }));
    } else $('remarks').hidden = true;
    $('paused').hidden = !(black && viewing == null);
  }
  addEventListener('resize', () => { if (canvas && !$('slide-box').hidden) fit(canvas, $('slide-box')); });

  function slideTitle(s) {
    if (!s) return '';
    const sec = window.Lectern.sectionFor(s);
    const h = sec.querySelector('h1, h2, h3');
    return (h ? h.textContent : sec.textContent).replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  $('prev').addEventListener('click', () => { const i = shown(); if (i > 0) { viewing = i - 1; renderSlide(); } });
  $('next').addEventListener('click', () => {
    const i = shown();
    if (i >= maxViewable()) return;
    viewing = i + 1;
    if (viewing === live) viewing = null;
    renderSlide();
  });
  $('live').addEventListener('click', () => { viewing = null; renderSlide(); });
  // Swipe on the slide to browse.
  let touchX = null;
  $('slide-pane').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  $('slide-pane').addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX; touchX = null;
    if (Math.abs(dx) > 60) (dx < 0 ? $('next') : $('prev')).click();
  });

  // ---------- captions ----------
  const log = $('cap-log');
  let lastSlideMark = null, interimEl = null, stick = true;
  const seenFinal = new Set();
  log.addEventListener('scroll', () => {
    stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    $('cap-latest').hidden = stick;
  });
  $('cap-latest').addEventListener('click', () => { stick = true; log.scrollTop = log.scrollHeight; $('cap-latest').hidden = true; });
  const scrollDown = () => { if (stick) log.scrollTop = log.scrollHeight; };

  function mark(slide) {
    if (slide === lastSlideMark) return;
    lastSlideMark = slide;
    const m = document.createElement('div');
    m.className = 'slide-mark';
    m.textContent = `Slide ${slide + 1}`;
    log.insertBefore(m, interimEl);
  }
  function addFinal(c) {
    if (!c.text || seenFinal.has(c.id + '|' + c.at)) return;
    seenFinal.add(c.id + '|' + c.at);
    mark(c.slide);
    const p = document.createElement('p');
    p.textContent = c.text;
    log.insertBefore(p, interimEl);
  }
  let interimText = '';
  function renderInterim() {
    const want = prefs.interim && interimText;
    if (!want) { if (interimEl) { interimEl.remove(); interimEl = null; } return; }
    if (!interimEl) { interimEl = document.createElement('p'); interimEl.className = 'interim'; interimEl.setAttribute('aria-hidden', 'true'); log.appendChild(interimEl); }
    interimEl.textContent = interimText;
  }
  async function loadTranscript() {
    if (!info.captions) return;
    try {
      const r = await fetch('/f/transcript', { cache: 'no-store' });
      const t = await r.json();
      t.final.forEach(addFinal);
      interimText = t.interim ? t.interim.text : '';
      renderInterim();
      scrollDown();
    } catch (e) {}
  }

  // ---------- search what's been said (this talk only) ----------
  const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  $('find-btn').hidden = !info.captions;
  $('find-btn').addEventListener('click', () => {
    const open = $('find').hidden;
    $('find').hidden = !open; $('find-btn').setAttribute('aria-expanded', String(open));
    if (open) $('find-q').focus(); else $('find-results').hidden = true;
  });
  $('find').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('find-q').value.trim();
    const ol = $('find-results');
    if (!q) { ol.hidden = true; return; }
    let res;
    try { res = await (await fetch(`/f/search?q=${encodeURIComponent(q)}`)).json(); } catch (err) { return; }
    ol.hidden = false;
    ol.innerHTML = res.hits.length ? '' : '<li>Nothing found yet.</li>';
    res.hits.forEach((h) => {
      const li = document.createElement('li');
      const text = h.highlight ? escH(h.highlight).replace(/&lt;(\/?)mark&gt;/g, '<$1mark>') : escH(h.text);
      li.innerHTML = `${text}<span class="w">Slide ${h.slide + 1} · ${new Date(h.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`;
      ol.appendChild(li);
    });
  });

  // ---------- live stream ----------
  function connect() {
    const es = new EventSource('/f/events');
    es.onopen = () => {
      $('conn').textContent = 'live'; $('conn').className = 'conn live';
      loadTranscript(); // fill any gap from a dropped connection
    };
    es.onerror = () => { $('conn').textContent = 'reconnecting…'; $('conn').className = 'conn lost'; };
    es.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'state') {
        const changed = m.index !== live;
        live = m.index; total = m.total; furthest = Math.max(furthest, m.furthest || 0); black = m.black;
        if (viewing === live) viewing = null;
        if (changed || viewing == null) renderSlide();
        else { $('next').disabled = shown() >= maxViewable(); }
        if (changed) {
          getSlide(live).then((s) => { $('announce').textContent = `Slide ${live + 1} of ${total}. ${slideTitle(s)}`; });
          if (prefs.vibrate && navigator.vibrate) navigator.vibrate(60);
        }
      } else if (m.t === 'take') {
        // The speaker started a new take: start the captions over.
        log.replaceChildren(); interimEl = null; interimText = ''; lastSlideMark = null; seenFinal.clear();
        $('find-results').hidden = true;
        $('announce').textContent = 'The speaker restarted. Captions start over.';
      } else if (m.t === 'caption') {
        if (m.final) { interimText = ''; addFinal(m); } else interimText = m.text;
        renderInterim();
        scrollDown();
      }
    };
  }
  await loadTranscript();
  connect();
  renderSlide();
})();
