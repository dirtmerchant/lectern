// Slide rendering shared by the presenter (index.html) and the phone view (follow.html).
// A slide from the server: { id, kind: 'html' | 'md', src, base, clip? }.
// Everything renders onto a fixed 1920×1080 canvas that is scaled to fit its box.
(() => {
  'use strict';

  const parser = new DOMParser();
  const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

  // Relative image/video URLs resolve against the slide file's folder under /talk/.
  function rewriteUrls(root, base) {
    root.querySelectorAll('img[src], video[src], source[src]').forEach((el) => {
      const src = el.getAttribute('src');
      if (src && !ABSOLUTE.test(src)) el.setAttribute('src', base + src);
    });
  }

  // Parse a slide into a detached <section>, notes (<aside>) removed.
  function sectionFor(slide) {
    let sec;
    if (slide.kind === 'md') {
      sec = document.createElement('section');
      sec.className = 'md-slide';
      sec.innerHTML = window.marked.parse(slide.src, { gfm: true, breaks: false });
      const first = sec.firstElementChild;
      if (first && first.tagName === 'H1') sec.classList.add('title-slide');
      if (slide.clip && !sec.querySelector('img[data-video]')) {
        const ph = document.createElement('img');
        ph.setAttribute('data-video', '');
        ph.className = 'clip-placeholder';
        sec.appendChild(ph);
      }
    } else {
      const doc = parser.parseFromString(slide.src, 'text/html');
      sec = doc.querySelector('section');
      if (!sec) { sec = document.createElement('section'); sec.textContent = `Slide ${slide.id} has no <section>`; }
      sec = document.importNode(sec, true);
    }
    sec.querySelectorAll('aside').forEach((a) => a.remove());
    sec.querySelectorAll('script').forEach((s) => s.remove());
    rewriteUrls(sec, slide.base || '/talk/');
    return sec;
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

  // opts.video(slide) -> a live <video> element, or omit for a still poster.
  function buildCanvas(slide, opts = {}) {
    const canvas = document.createElement('div');
    canvas.className = 'canvas';
    const sec = sectionFor(slide);
    sec.removeAttribute('id');
    if (slide.kind !== 'md') {
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
    }
    sec.querySelectorAll('img[data-video]').forEach((img) => {
      if (!slide.clip) return;
      if (opts.video) {
        const v = opts.video(slide);
        v.setAttribute('style', img.getAttribute('style') || '');
        if (img.className) v.className = img.className;
        img.replaceWith(v);
      } else if (slide.clip.poster) {
        img.src = '/talk/' + slide.clip.poster;
        img.alt = 'Video clip';
      } else {
        img.alt = 'Video clip (plays on the main screen)';
        img.classList.add('clip-missing');
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
    const texts = flow.flatMap((c) => [c, ...c.querySelectorAll('h1,h2,h3,p,li,td,th,ul,ol,table,pre')])
      .filter((el) => /^(H1|H2|H3|P|LI|TD|TH|UL|OL|TABLE|PRE)$/.test(el.tagName));
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

  // Reflowed, style-free version of a slide for reading on a phone or with a
  // screen reader: keeps headings, lists, tables, images; drops layout.
  function readableFor(slide) {
    const sec = sectionFor(slide);
    const out = document.createElement('div');
    out.className = 'readable';
    sec.querySelectorAll('x-connector, svg, style').forEach((el) => el.remove());
    sec.querySelectorAll('[style]').forEach((el) => el.removeAttribute('style'));
    sec.querySelectorAll('img[data-video]').forEach((img) => {
      const p = document.createElement('p');
      p.className = 'clip-note';
      p.textContent = '▶ A video clip is playing on the main screen.';
      img.replaceWith(p);
    });
    sec.querySelectorAll('img').forEach((img) => { if (!img.alt) img.alt = ''; });
    // Unwrap layout-only divs/spans so text flows naturally.
    sec.querySelectorAll('div, span').forEach((el) => {
      if (!el.textContent.trim() && !el.querySelector('img, table')) { el.remove(); return; }
    });
    out.append(...sec.childNodes);
    return out;
  }

  window.Lectern = { sectionFor, buildCanvas, fit, readableFor };
})();
