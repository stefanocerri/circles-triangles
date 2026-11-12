// Serializza la pagina corrente (DOM + stili calcolati + geometria) in JSON per il plugin Figma.
// Iniettato dall'estensione; espone window.__h2f() che restituisce l'oggetto catturato.
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const r2 = (v) => Math.round(v * 100) / 100;
  const px = (v) => parseFloat(v) || 0;
  const sx = () => window.scrollX, sy = () => window.scrollY;

  // ---------- colori (qualsiasi sintassi CSS -> rgba 0..1) ----------
  const cctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 })
    .getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();
  function color(str) {
    if (!str || str === 'transparent' || str === 'none') return null;
    if (colorCache.has(str)) return colorCache.get(str);
    let c;
    const m = str.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
    if (m) c = { r: m[1] / 255, g: m[2] / 255, b: m[3] / 255, a: m[4] === undefined ? 1 : +m[4] };
    else {
      cctx.clearRect(0, 0, 1, 1);
      cctx.fillStyle = '#000';
      cctx.fillStyle = str;
      cctx.fillRect(0, 0, 1, 1);
      const d = cctx.getImageData(0, 0, 1, 1).data;
      c = { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a: d[3] / 255 };
    }
    if (c.a === 0) c = null;
    colorCache.set(str, c);
    return c;
  }

  function splitTop(s, sep) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === sep && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // ---------- immagini ----------
  const images = {}; // url -> null (riempito dall'estensione con i byte)
  const videos = {}; // url -> null (idem)
  let streamVideos = 0;
  function addImage(url) {
    if (!url || url === 'about:blank') return null;
    if (url.startsWith('blob:')) return null; // gestite da inlineCanvas
    if (!(url in images)) images[url] = null;
    return url;
  }
  function inlineCanvas(source, w, h) {
    try {
      const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
      c.getContext('2d').drawImage(source, 0, 0, w, h);
      const url = c.toDataURL('image/png');
      images[url] = null;
      return url;
    } catch (e) { return null; } // canvas "tainted" da origine esterna
  }

  // ---------- sfondi, bordi, ombre ----------
  function gradient(str, w, h) {
    const m = str.match(/^(repeating-)?(linear|radial)-gradient\((.*)\)$/);
    if (!m) return null;
    const args = splitTop(m[3], ',');
    let angle = 180;
    if (m[2] === 'linear') {
      const a = args[0];
      const dirs = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270, 'to top right': 45, 'to right top': 45, 'to bottom right': 135, 'to right bottom': 135, 'to bottom left': 225, 'to left bottom': 225, 'to top left': 315, 'to left top': 315 };
      if (/deg$/.test(a)) { angle = px(a); args.shift(); }
      else if (/turn$/.test(a)) { angle = px(a) * 360; args.shift(); }
      else if (/rad$/.test(a)) { angle = px(a) * 180 / Math.PI; args.shift(); }
      else if (a in dirs) { angle = dirs[a]; args.shift(); }
    } else if (!color(splitTop(args[0], ' ')[0])) args.shift(); // forma/posizione del radial
    const len = m[2] === 'linear'
      ? Math.abs(w * Math.sin(angle * Math.PI / 180)) + Math.abs(h * Math.cos(angle * Math.PI / 180))
      : Math.max(w, h);
    const stops = [];
    for (const a of args) {
      const t = splitTop(a, ' ');
      const c = color(t[0]) || { r: 0, g: 0, b: 0, a: 0 };
      const pos = t.slice(1).map((p) => (p.endsWith('%') ? px(p) / 100 : px(p) / (len || 1)));
      if (!pos.length) stops.push({ c, p: null });
      for (const p of pos) stops.push({ c, p });
    }
    if (stops.length < 2) return null;
    if (stops[0].p === null) stops[0].p = 0;
    if (stops[stops.length - 1].p === null) stops[stops.length - 1].p = 1;
    for (let i = 1; i < stops.length; i++) { // distribuisce le posizioni mancanti
      if (stops[i].p !== null) continue;
      let j = i; while (stops[j].p === null) j++;
      const a = stops[i - 1].p, b = stops[j].p;
      for (let k = i; k < j; k++) stops[k].p = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    }
    return { t: m[2] === 'linear' ? 'lin' : 'rad', angle, stops: stops.map((s) => ({ c: s.c, p: Math.min(1, Math.max(0, s.p)) })) };
  }

  function fills(cs, w, h) {
    const out = [];
    const bg = color(cs.backgroundColor);
    if (bg) out.push({ t: 'color', c: bg });
    if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      const layers = splitTop(cs.backgroundImage, ',').reverse(); // in Figma l'ultimo fill sta sopra
      const sizes = splitTop(cs.backgroundSize, ',').reverse();
      const reps = splitTop(cs.backgroundRepeat, ',').reverse();
      layers.forEach((l, i) => {
        const u = l.match(/^url\(["']?(.*?)["']?\)$/);
        if (u) {
          const size = sizes[i] || 'auto', rep = reps[i] || 'repeat';
          const mode = size === 'cover' ? 'FILL' : size === 'contain' ? 'FIT' : /no-repeat/.test(rep) || size.includes('100%') ? 'FILL' : 'TILE';
          const url = addImage(u[1]);
          if (url) out.push({ t: 'img', url, mode });
        } else {
          const g = gradient(l, w, h);
          if (g) out.push(g);
        }
      });
    }
    return out;
  }

  function border(cs) {
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    const ws = sides.map((s) => (cs[`border${s}Style`] === 'none' || cs[`border${s}Style`] === 'hidden' ? 0 : px(cs[`border${s}Width`])));
    let c = null;
    sides.forEach((s, i) => { if (ws[i] && !c) c = color(cs[`border${s}Color`]); });
    if (!c || !ws.some(Boolean)) return null;
    return { w: ws, c };
  }

  function radius(cs, w, h) {
    const corners = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'];
    const r = corners.map((k) => {
      const v = cs[`border${k}Radius`].split(' ')[0];
      return v.endsWith('%') ? (px(v) / 100) * Math.min(w, h) : px(v);
    });
    return r.some(Boolean) ? r.map((v) => r2(Math.min(v, Math.min(w, h) / 2))) : null;
  }

  function shadows(str) {
    if (!str || str === 'none') return [];
    return splitTop(str, ',').map((s) => {
      const toks = splitTop(s, ' ');
      const lens = [];
      let c = null, inset = false;
      for (const t of toks) {
        if (t === 'inset') inset = true;
        else if (/^-?[\d.]+(px)?$/.test(t)) lens.push(px(t));
        else c = color(t);
      }
      return c && { c, x: lens[0] || 0, y: lens[1] || 0, blur: lens[2] || 0, spread: lens[3] || 0, inset };
    }).filter(Boolean);
  }

  // ---------- testo ----------
  const BLOCKISH = /^(block|list-item|table-cell|flow-root|table-caption)$/;
  const ATOMIC = /^(IMG|SVG|VIDEO|CANVAS|INPUT|TEXTAREA|SELECT|BUTTON|IFRAME|OBJECT|EMBED|PICTURE)$/i;

  function isPureInline(el, cs) {
    if (el.tagName === 'BR') return true;
    if (cs.display !== 'inline' || ATOMIC.test(el.tagName) || el.shadowRoot) return false;
    for (const ch of el.childNodes) {
      if (ch.nodeType === 3) continue;
      if (ch.nodeType !== 1) continue;
      const ccs = getComputedStyle(ch);
      if (ccs.display === 'none') continue;
      if (!isPureInline(ch, ccs)) return false;
    }
    return true;
  }

  function families(cs) {
    return splitTop(cs.fontFamily, ',').map((f) => f.replace(/^["']|["']$/g, '').trim());
  }

  function segStyle(cs, el) {
    const tr = cs.textTransform;
    return {
      ff: families(cs),
      fw: parseInt(cs.fontWeight, 10) || 400,
      it: cs.fontStyle !== 'normal',
      fs: px(cs.fontSize),
      c: color(cs.color) || { r: 0, g: 0, b: 0, a: 1 },
      lh: cs.lineHeight === 'normal' ? null : px(cs.lineHeight),
      ls: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing),
      deco: /underline/.test(cs.textDecorationLine) ? 'UNDERLINE' : /line-through/.test(cs.textDecorationLine) ? 'STRIKETHROUGH' : null,
      tc: tr === 'uppercase' ? 'UPPER' : tr === 'lowercase' ? 'LOWER' : tr === 'capitalize' ? 'TITLE' : null,
    };
  }

  // Effetti sul testo che Figma non sa rifare: quei testi vanno importati come immagine dal sito.
  function synthItalic(fam) {
    const faces = [...document.fonts].filter((f) => f.family.replace(/["']/g, '').toLowerCase() === fam.toLowerCase());
    return faces.length > 0 && !faces.some((f) => f.style !== 'normal');
  }
  function textFx(cs) {
    const r = [];
    if (cs.fontVariationSettings && cs.fontVariationSettings !== 'normal') r.push('assi variabili');
    if (cs.fontStyle !== 'normal' && families(cs)[0] && synthItalic(families(cs)[0])) r.push('corsivo simulato');
    if (/^matrix\(/.test(cs.transform)) {
      const m = cs.transform.match(/-?[\d.]+(e-?\d+)?/g).map(Number);
      if (Math.abs(m[1] + m[2]) > 0.01 || Math.abs(m[0] - m[3]) > 0.01) r.push('skew/scala');
    }
    if (parseFloat(cs.webkitTextStrokeWidth) > 0) r.push('contorno');
    if (cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text') r.push('riempimento sfumato');
    return r;
  }

  // Unisce una sequenza di nodi inline in un unico layer di testo con range di stile.
  function textLeaf(run, parentCs) {
    let text = '';
    const segs = [];
    const fx = new Set(textFx(parentCs));
    const push = (str, el, raw) => {
      const cs = getComputedStyle(el);
      textFx(cs).forEach((r) => fx.add(r));
      if (!raw && !/pre/.test(cs.whiteSpace)) {
        str = str.replace(/[ \t\n\r\f]+/g, ' ');
        if (str.startsWith(' ') && (text === '' || /[ \n]$/.test(text))) str = str.slice(1);
      }
      if (!str) return;
      const st = segStyle(cs, el);
      const prev = segs[segs.length - 1];
      if (prev && JSON.stringify(prev.s) === JSON.stringify(st)) prev.e += str.length;
      else segs.push({ b: text.length, e: text.length + str.length, s: st });
      text += str;
    };
    const walk = (node) => {
      if (node.nodeType === 3) return push(node.data, node.parentElement);
      if (node.nodeType !== 1) return;
      if (node.tagName === 'BR') {
        if (text.endsWith(' ')) { text = text.slice(0, -1); segs.forEach((s) => { s.e = Math.min(s.e, text.length); }); }
        return push('\n', node.parentElement, true);
      }
      if (getComputedStyle(node).display === 'none') return;
      const pseudo = (p) => {
        const m = getComputedStyle(node, p).content.match(/^"(.*)"$/);
        if (m && m[1]) push(m[1].replace(/\\"/g, '"'), node);
      };
      pseudo('::before');
      node.childNodes.forEach(walk);
      pseudo('::after');
    };
    run.forEach(walk);
    const trimmed = text.replace(/ +$/, '');
    if (!trimmed.replace(/\s/g, '').length) return null;
    segs.forEach((s) => { s.e = Math.min(s.e, trimmed.length); });
    for (let i = segs.length - 1; i >= 0; i--) if (segs[i].b >= segs[i].e) segs.splice(i, 1); // segmento fatto solo di spazi finali o prima di un <br>
    const range = document.createRange();
    range.setStartBefore(run[0]);
    range.setEndAfter(run[run.length - 1]);
    const rect = range.getBoundingClientRect();
    if (rect.width < 0.5 || rect.height < 0.5) return null;
    const tops = new Set();
    for (const r of range.getClientRects()) if (r.width > 0.5) tops.add(Math.round(r.top / 4));
    const lines = Math.max(1, tops.size);
    let y = rect.top, h = rect.height;
    const lh = segs[0].s.lh;
    if (lh && lines === 1 && Math.abs(h - lh) > 1) { y += (h - lh) / 2; h = lh; } // allinea al line-height
    const ta = parentCs.textAlign;
    return {
      type: 'text',
      name: trimmed.replace(/\s+/g, ' ').slice(0, 40),
      x: r2(rect.left + sx()), y: r2(y + sy()), w: r2(rect.width), h: r2(h),
      text: trimmed,
      segs: segs.filter((s) => s.e > s.b),
      align: ta === 'center' ? 'CENTER' : ta === 'right' || ta === 'end' ? 'RIGHT' : ta === 'justify' ? 'JUSTIFIED' : 'LEFT',
      multi: lines > 1,
      blend: blendOf(parentCs),
      shadows: shadows(parentCs.textShadow).map((s) => Object.assign(s, { spread: 0 })),
      fx: fx.size ? [...fx] : undefined,
    };
  }

  // ---------- SVG inline ----------
  const SHAPES = /^(path|circle|rect|ellipse|line|polyline|polygon|text|tspan|use)$/i;
  function svgNode(el, rect) {
    const clone = el.cloneNode(true);
    const orig = [el, ...el.querySelectorAll('*')], cl = [clone, ...clone.querySelectorAll('*')];
    orig.forEach((o, i) => {
      if (!SHAPES.test(o.tagName) && o !== el) return;
      const cs = getComputedStyle(o), c = cl[i];
      if (cs.fill && !cs.fill.startsWith('url')) c.setAttribute('fill', cs.fill);
      if (cs.stroke && !cs.stroke.startsWith('url')) c.setAttribute('stroke', cs.stroke);
      if (cs.stroke !== 'none') c.setAttribute('stroke-width', cs.strokeWidth);
      if (cs.opacity !== '1') c.setAttribute('opacity', cs.opacity);
      if (cs.fillOpacity !== '1') c.setAttribute('fill-opacity', cs.fillOpacity);
    });
    clone.querySelectorAll('use').forEach((u) => {
      const href = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
      const ref = href.startsWith('#') && document.getElementById(href.slice(1));
      if (!ref) return;
      const g = document.createElementNS(NS, 'g');
      g.innerHTML = ref.innerHTML;
      if (ref.tagName.toLowerCase() === 'symbol' && ref.getAttribute('viewBox') && !clone.getAttribute('viewBox')) clone.setAttribute('viewBox', ref.getAttribute('viewBox'));
      for (const a of ['fill', 'stroke', 'stroke-width']) if (u.getAttribute(a)) g.setAttribute(a, u.getAttribute(a));
      u.replaceWith(g);
    });
    if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${px(el.getAttribute('width')) || rect.width} ${px(el.getAttribute('height')) || rect.height}`);
    clone.setAttribute('width', r2(rect.width));
    clone.setAttribute('height', r2(rect.height));
    clone.setAttribute('xmlns', NS);
    clone.removeAttribute('class');
    clone.removeAttribute('style');
    return new XMLSerializer().serializeToString(clone);
  }

  // ---------- nodi ----------
  function nameFor(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls = typeof el.className === 'string' && el.className.trim().split(/\s+/)[0];
    return cls ? `${tag}.${cls}` : tag;
  }

  function childList(el) {
    if (el.shadowRoot) return [...el.shadowRoot.childNodes];
    if (el.tagName === 'SLOT') return el.assignedNodes({ flatten: true });
    return [...el.childNodes];
  }

  function children(el, cs) {
    const out = [];
    let run = [];
    const flush = () => { if (run.length) { const t = textLeaf(run, cs); if (t) out.push(t); run = []; } };
    for (const ch of childList(el)) {
      if (ch.nodeType === 3) { run.push(ch); continue; }
      if (ch.nodeType !== 1) continue;
      const ccs = getComputedStyle(ch);
      if (ccs.display === 'none') continue;
      if (ccs.display === 'contents' || ch.tagName === 'SLOT') {
        flush();
        out.push(...children(ch, cs));
        continue;
      }
      if (isPureInline(ch, ccs)) { run.push(ch); continue; }
      flush();
      const n = capture(ch, ccs);
      if (n) out.push(n);
    }
    flush();
    return out;
  }

  function formText(el, cs, box) {
    let str = '', col = cs.color;
    const tag = el.tagName;
    if (tag === 'SELECT') str = el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '';
    else if (tag === 'TEXTAREA' || tag === 'INPUT') {
      str = el.value;
      if (!str && el.placeholder) { str = el.placeholder; col = getComputedStyle(el, '::placeholder').color; }
    }
    if (!str || /^(checkbox|radio|range|color|file|hidden)$/.test(el.type)) return null;
    const st = segStyle(cs, el);
    st.c = color(col) || st.c;
    const lh = st.lh || st.fs * 1.2;
    const ta = cs.textAlign;
    return {
      type: 'text', name: str.slice(0, 40), text: str,
      x: box.x, y: r2(tag === 'TEXTAREA' ? box.y : box.y + (box.h - lh) / 2), w: box.w, h: r2(tag === 'TEXTAREA' ? box.h : lh),
      segs: [{ b: 0, e: str.length, s: st }],
      align: ta === 'center' ? 'CENTER' : ta === 'right' || ta === 'end' ? 'RIGHT' : 'LEFT',
      multi: tag === 'TEXTAREA', fill: true,
    };
  }

  const blendOf = (cs) => (cs.mixBlendMode && cs.mixBlendMode !== 'normal' ? cs.mixBlendMode.toUpperCase().replace(/-/g, '_') : null);

  // Rotazione 2D: misura il sottoalbero senza transform (coordinate locali), ricorda angolo e centro reale.
  function rotationOf(el, cs) {
    const t = cs.transform;
    if (!t || t === 'none' || el.tagName.toUpperCase() === 'SVG') return null;
    const m = t.match(/^matrix\(([^)]+)\)$/);
    if (!m) return null;
    const [a, b] = m[1].split(',').map(Number);
    const deg = (Math.atan2(b, a) * 180) / Math.PI;
    if (Math.abs(deg) < 0.5) return null;
    const r = el.getBoundingClientRect();
    return { deg: r2(deg), cx: r2(r.left + r.width / 2 + sx()), cy: r2(r.top + r.height / 2 + sy()) };
  }

  // Animazioni CSS/WAAPI infinite (scritte che scorrono, icone che ruotano, pulsazioni): ferme al primo fotogramma
  // per la cattura, keyframe in px/gradi relativi al primo, che il plugin rifà con Figma Motion.
  const pausedAnims = [];
  const angle = (s) => { let r = 0; String(s || '').replace(/rotate[zZ]?\((-?[\d.]+)(deg|turn|rad|grad)?\)|^(-?[\d.]+)(deg|turn|rad|grad)$/g, (m, v, u, v2, u2) => { const k = { turn: 360, rad: 180 / Math.PI, grad: 0.9 }[u || u2] || 1; r += parseFloat(v || v2) * k; }); return r; };
  function loopAnims(el) {
    if (!el.getAnimations || capturingStates) return null;
    for (const a of el.getAnimations()) {
      const t = a.effect && a.effect.getComputedTiming();
      if (!t || t.iterations !== Infinity || !(t.duration > 0) || a.playState !== 'running' || !a.effect.getKeyframes) continue;
      const kf = a.effect.getKeyframes();
      if (!kf.some((k) => k.transform || k.rotate || k.translate || k.scale || k.opacity !== undefined)) continue;
      a.pause(); a.currentTime = t.delay || 0; pausedAnims.push(a);
      const prev = el.style.cssText, keys = [];
      let last = {};
      try {
        kf.forEach((k) => {
          ['transform', 'rotate', 'translate', 'scale'].forEach((p) => { if (k[p] !== undefined) last[p] = k[p]; });
          el.style.cssText = prev;
          for (const p in last) el.style.setProperty(p, last[p], 'important');
          const m = (getComputedStyle(el).transform.match(/^matrix\(([^)]+)\)$/) || [0, '1,0,0,1,0,0'])[1].split(',').map(Number);
          const sx = Math.hypot(m[0], m[1]), r = angle(last.transform) + angle(last.rotate);
          const o = { t: k.computedOffset, e: k.easing, x: r2(m[4]), y: r2(m[5]), r: r2(r || (Math.atan2(m[1], m[0]) * 180) / Math.PI), sx: r2(sx), sy: r2((m[0] * m[3] - m[1] * m[2]) / (sx || 1)) };
          if (k.opacity !== undefined) o.op = +k.opacity;
          keys.push(o);
        });
      } finally { el.style.cssText = prev; }
      return { dur: t.duration / 1000, dir: t.direction, keys };
    }
    return null;
  }

  function capture(el, cs) {
    const anim = noAnim ? null : loopAnims(el);
    // sticky solo in basso (top: auto): Figma sa attaccare solo in alto, e a inizio pagina il browser lo mostra
    // spostato in fondo alla finestra invece che al suo posto: lo catturo come elemento normale
    // ...tranne quando il suo contenitore è quasi tutta la pagina: allora sul sito è una barra sempre in fondo allo schermo → fixed in basso
    const bottomSticky = cs.position === 'sticky' && cs.top === 'auto';
    const wholeB = bottomSticky && cs.bottom !== 'auto' && el.parentElement && el.parentElement.getBoundingClientRect().height >= 0.8 * Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const prevCss = bottomSticky && !wholeB ? el.style.cssText : null;
    if (prevCss !== null) el.style.setProperty('position', 'relative', 'important');
    let n;
    try { n = capture1(el, cs); } finally { if (prevCss !== null) el.style.cssText = prevCss; }
    if (n && wholeB) { n.pos = 'fixed'; n.abs = true; delete n.stickyEnd; }
    // fixed attaccati al fondo dello schermo (bottom: Npx, nella metà bassa): in Figma vincolo Bottom
    if (n && n.pos === 'fixed' && cs.bottom !== 'auto') {
      const r = el.getBoundingClientRect();
      if (r.top > innerHeight / 2) n.pinB = Math.max(0, r2(innerHeight - r.bottom));
    }
    if (n && anim) n.anim = anim;
    if (n && el.dataset) { // marcature delle interazioni (componenti Figma)
      if (el.dataset.h2fIa) n.ia = el.dataset.h2fIa;
      if (el.dataset.h2fAct) n.act = el.dataset.h2fAct;
      if (el.dataset.h2fAnchor) n.anchor = el.dataset.h2fAnchor;
    }
    return n;
  }
  function capture1(el, cs) {
    // le frecce dei caroselli spesso sono a opacità 0 finché non passi col mouse: servono comunque come area cliccabile
    if (cs.visibility === 'hidden' || (cs.opacity === '0' && !(el.dataset && el.dataset.h2fAct) && !el.querySelector('[data-h2f-act]'))) return null;
    const rot = rotationOf(el, cs);
    if (rot) {
      const prev = el.style.cssText;
      el.style.setProperty('transform', 'none', 'important');
      try {
        const n = capture2(el, getComputedStyle(el));
        if (n) Object.assign(n, { rot: rot.deg, cx: rot.cx, cy: rot.cy, abs: true });
        return n;
      } finally { el.style.cssText = prev; }
    }
    return capture2(el, cs);
  }

  function lazySrc(el) {
    const s = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-srcset') || el.getAttribute('srcset') || '';
    const first = s.split(',').pop().trim().split(/\s+/)[0]; // ultima voce di srcset = più grande
    try { return first ? new URL(first, location.href).href : null; } catch (e) { return null; }
  }

  // Ordine di disegno tra fratelli (CSS painting order semplificato):
  // z negativo < blocchi non posizionati (0) < posizionati z:auto (1) < z positivo (1+z)
  function zKey(el, cs) {
    const pcs = el.parentElement ? getComputedStyle(el.parentElement) : null;
    const flexItem = pcs && /flex|grid/.test(pcs.display);
    const positioned = cs.position !== 'static' || (flexItem && cs.zIndex !== 'auto');
    if (!positioned) return 0;
    const z = cs.zIndex === 'auto' ? 0 : +cs.zIndex;
    return z < 0 ? z - 1 : 1 + z;
  }

  // banner dei cookie più diffusi: non fanno parte del design
  const CONSENT = '#iubenda-cs-banner,#CybotCookiebotDialog,#onetrust-consent-sdk,#onetrust-banner-sdk,#didomi-host,#usercentrics-root,#axeptio_overlay,.cky-consent-container,#cookie-law-info-bar,.cc-window,.cmplz-cookiebanner,#cookiescript_injected,.qc-cmp2-container,#termly-code-snippet-support';

  // ::before / ::after posizionati con sfondo o bordo (es. seconda foto che appare al passaggio del mouse)
  function pseudoBox(el, p, rect, ecs) {
    const c = getComputedStyle(el, p);
    if (c.content === 'none' || c.content === 'normal' || c.display === 'none' || !/absolute|fixed/.test(c.position)) return null;
    const pw = rect.width - px(ecs.borderLeftWidth) - px(ecs.borderRightWidth), ph = rect.height - px(ecs.borderTopWidth) - px(ecs.borderBottomWidth);
    const L = parseFloat(c.left), T = parseFloat(c.top), R = parseFloat(c.right), B = parseFloat(c.bottom);
    const w = parseFloat(c.width) || pw - (L || 0) - (R || 0), h = parseFloat(c.height) || ph - (T || 0) - (B || 0);
    if (!(w > 0.5 && h > 0.5)) return null;
    const f = fills(c, w, h), b = border(c);
    if (!f.length && !b) return null;
    if (+c.opacity === 0 && !f.some((x) => x.t === 'img')) return null; // invisibile e senza immagine: inutile
    const x = rect.left + px(ecs.borderLeftWidth) + (isNaN(L) ? pw - (R || 0) - w : L);
    const y = rect.top + px(ecs.borderTopWidth) + (isNaN(T) ? ph - (B || 0) - h : T);
    return { type: 'frame', name: nameFor(el) + p, x: r2(x + sx()), y: r2(y + sy()), w: r2(w), h: r2(h), abs: true, z: c.zIndex === 'auto' ? 1 : (+c.zIndex < 0 ? +c.zIndex - 1 : 1 + +c.zIndex),
      fills: f, border: b, radius: radius(c, w, h), shadows: [], opacity: +c.opacity, kids: [], pad: [0, 0, 0, 0] };
  }

  function capture2(el, cs) {
    if (el.matches(CONSENT)) return null;
    // popup fissi che non fanno parte del design: banner cookie/consenso propri del sito, "Accedi con Google"
    if (cs.position === 'fixed' && (/cookie|consenso|consent|gdpr/i.test((el.textContent || '').slice(0, 400)) || el.id === 'google-one-tap-wrapper' || el.querySelector('iframe[src*="accounts.google.com"]'))) return null;
    // testo solo per screen reader (.sr-only, .visually-hidden): 1px, ritagliato
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') return null;
    const rect = el.getBoundingClientRect();
    const z = zKey(el, cs);
    const tag = el.tagName.toUpperCase();
    const x = r2(rect.left + sx()), y = r2(rect.top + sy()), w = r2(rect.width), h = r2(rect.height);
    const abs = cs.position === 'absolute' || cs.position === 'fixed';
    const pos = cs.position === 'sticky' || cs.position === 'fixed' ? cs.position : null;
    // fin dove può "attaccarsi" uno sticky: la fine del suo contenitore
    const stickyEnd = pos === 'sticky' && el.parentElement ? r2(el.parentElement.getBoundingClientRect().bottom + sy()) : undefined;

    if (tag === 'SVG') {
      if (w < 0.5 || h < 0.5) return null;
      return { type: 'svg', name: nameFor(el), x, y, w, h, svg: svgNode(el, rect), abs, pos, stickyEnd, z, opacity: +cs.opacity, blend: blendOf(cs) };
    }

    const bw = ['Top', 'Right', 'Bottom', 'Left'].map((s) => px(cs[`border${s}Width`]));
    const pad = ['Top', 'Right', 'Bottom', 'Left'].map((s, i) => r2(px(cs[`padding${s}`]) + bw[i]));
    const content = { x: r2(x + pad[3]), y: r2(y + pad[0]), w: r2(w - pad[1] - pad[3]), h: r2(h - pad[0] - pad[2]) };

    const n = {
      type: 'frame', name: nameFor(el), x, y, w, h, abs, pos, stickyEnd, z,
      blend: blendOf(cs),
      blur: px((cs.filter.match(/blur\(([^)]+)\)/) || [])[1]),
      bgBlur: px(((cs.backdropFilter || '').match(/blur\(([^)]+)\)/) || [])[1]),
      gray: px((cs.filter.match(/grayscale\(([^)]+)\)/) || [])[1]) * (/grayscale\([\d.]+%\)/.test(cs.filter) ? 0.01 : 1),
      fills: fills(cs, w, h),
      border: border(cs),
      radius: radius(cs, w, h),
      shadows: shadows(cs.boxShadow),
      opacity: +cs.opacity,
      clip: cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || /^(IMG|VIDEO|CANVAS|IFRAME)$/.test(tag),
      display: cs.display,
      dir: cs.flexDirection,
      wrap: cs.flexWrap !== 'nowrap',
      justify: cs.justifyContent,
      alignItems: cs.alignItems,
      grow: px(cs.flexGrow),
      pad,
      kids: [],
    };

    if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS') {
      let url = null;
      if (tag === 'IMG') url = el.currentSrc || (el.src && !/^data:image\/gif/.test(el.src) ? el.src : null) || lazySrc(el) || el.src;
      else if (tag === 'VIDEO') {
        const src = el.currentSrc || el.src || (el.querySelector('source') && el.querySelector('source').src);
        if (src && !src.startsWith('blob:') && !/\.m3u8/.test(src)) { videos[src] = null; n.video = src; } else if (src) streamVideos++; // streaming (HLS/MSE): non scaricabile
        url = el.poster || null;
        if (!url && el.readyState >= 2) url = inlineCanvas(el, el.videoWidth || w, el.videoHeight || h); // frame corrente
        else url = addImage(url);
      }
      if (tag === 'CANVAS' || (url && url.startsWith('blob:'))) url = inlineCanvas(el, Math.round(w * 2) || 1, Math.round(h * 2) || 1);
      else if (tag === 'IMG') url = addImage(url);
      const fit = cs.objectFit;
      if (url) n.fills.push({ t: 'img', url, mode: fit === 'contain' || fit === 'scale-down' ? 'FIT' : 'FILL', tag: 'img' });
      else if (!n.fills.length) n.fills.push({ t: 'color', c: { r: 0.9, g: 0.9, b: 0.9, a: 1 } });
      n.isImg = true;
      return w < 0.5 || h < 0.5 ? null : n;
    }
    if (tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT') {
      n.fills.push({ t: 'color', c: { r: 0.93, g: 0.93, b: 0.93, a: 1 } });
      return n;
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (/^(checkbox|radio)$/.test(el.type) && !n.border) n.border = { w: [1, 1, 1, 1], c: { r: 0.46, g: 0.46, b: 0.46, a: 1 } };
      if (el.type === 'radio' && !n.radius) n.radius = [w / 2, w / 2, w / 2, w / 2];
      const t = formText(el, cs, content);
      if (t) n.kids.push(t);
      return n;
    }

    // scorrimento orizzontale vero (trackpad, scroll-snap): lo provo davvero; se scorre, in Figma il frame scorrerà in orizzontale
    let sx0 = null;
    if (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 20) {
      sx0 = el.scrollLeft;
      el.scrollTo({ left: sx0 + el.clientWidth, behavior: 'instant' }); // un'intera larghezza: con lo scroll-snap "mandatory" pochi px tornano indietro
      if (el.scrollLeft === sx0) el.scrollTo({ left: sx0 - el.clientWidth, behavior: 'instant' }); // già in fondo: prova indietro
      // negli stati dei caroselli lo scorrimento è proprio la differenza da catturare: lì resta dov'è
      if (el.scrollLeft !== sx0) { n.scrollX = true; n.clip = true; el.scrollTo({ left: capturingStates ? sx0 : 0, behavior: 'instant' }); } // dall'inizio: niente card irraggiungibili a sinistra
      else sx0 = null;
    }
    n.kids = children(el, cs);
    if (sx0 !== null) el.scrollTo({ left: sx0, behavior: 'instant' });
    const pb = pseudoBox(el, '::before', rect, cs), pa = pseudoBox(el, '::after', rect, cs);
    if (pb) n.kids.unshift(pb);
    if (pa) n.kids.push(pa);
    const hasBox = n.fills.length || n.border || n.shadows.length;
    const kids = n.kids;

    // Elemento di solo testo senza box visivo -> diventa direttamente il layer di testo
    if (!hasBox && kids.length === 1 && kids[0].type === 'text' && BLOCKISH.test(cs.display) && n.opacity === 1 && !pos) {
      if (content.w < 2 || content.h < 2) return null; // etichette nascoste
      return Object.assign(kids[0], { name: nameFor(el), tw: kids[0].w, x: content.x, w: content.w, abs, z, fill: true, blend: kids[0].blend || n.blend });
    }
    if (kids.length === 1 && kids[0].type === 'text' && BLOCKISH.test(cs.display)) {
      Object.assign(kids[0], { tw: kids[0].w, x: content.x, w: content.w, fill: true });
    }
    if (!hasBox && !kids.length) return null;
    // Wrapper trasparente con un solo figlio della stessa misura -> salta il livello
    if (!hasBox && kids.length === 1 && n.opacity === 1 && !n.clip && !n.blend && !pos && kids[0].type !== 'text') {
      const k = kids[0];
      if (Math.abs(k.x - x) < 1 && Math.abs(k.y - y) < 1 && Math.abs(k.w - w) < 1 && Math.abs(k.h - h) < 1) {
        k.abs = k.abs || abs;
        k.z = Math.max(k.z || 0, z);
        return k;
      }
    }
    return n;
  }

  // Siti con scroll su un div interno (body overflow:hidden): lo "srotoliamo" per avere la pagina intera.
  function mainScroller() {
    let best = null;
    for (const e of document.querySelectorAll('body *')) {
      if (e.scrollHeight < e.clientHeight + 100 || e.clientHeight < innerHeight * 0.6 || e.clientWidth < innerWidth * 0.6) continue;
      if (!/auto|scroll|overlay/.test(getComputedStyle(e).overflowY)) continue;
      if (!best || e.scrollHeight > best.scrollHeight) best = e;
    }
    return best;
  }

  window.__h2fScrollTo = (y) => (mainScroller() || window).scrollTo({ top: y, behavior: 'instant' });

  // Animazioni "reveal" allo scroll: ricorda lo stato in cui ogni elemento era visibile,
  // perché tornando in cima molti siti li ri-nascondono (opacity 0, righe traslate fuori maschera).
  const revealed = new WeakMap();
  function recordVisible() {
    for (const e of document.querySelectorAll('body *')) {
      const r = e.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || !r.width) continue;
      const c = getComputedStyle(e);
      const op = +c.opacity;
      const ident = c.transform === 'none' || c.transform === 'matrix(1, 0, 0, 1, 0, 0)';
      const prev = revealed.get(e) || { op: 0, ident: false };
      revealed.set(e, { op: Math.max(prev.op, op), ident: prev.ident || (ident && op > 0.05) });
    }
  }
  function applyRevealed(marks) {
    for (const e of document.querySelectorAll('body *')) {
      const best = revealed.get(e);
      if (!best) continue;
      const c = getComputedStyle(e);
      const hidden = +c.opacity < 0.05 && best.op > 0.05;
      const unrevealed = best.ident && /^matrix\(1, 0, 0, 1,/.test(c.transform) && c.transform !== 'matrix(1, 0, 0, 1, 0, 0)';
      if (!hidden && !unrevealed) continue;
      marks.push([e, e.style.cssText]);
      // fade-in: in Figma non si rifanno, l'elemento resta subito visibile
      if (hidden) e.style.setProperty('opacity', '1', 'important');
      if (unrevealed || (hidden && best.ident)) e.style.setProperty('transform', 'none', 'important');
      e.style.setProperty('transition', 'none', 'important');
    }
  }

  // animazioni finite (CSS animation/transition, Web Animations) ancora in corso
  const running = () => document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().endTime !== Infinity);
  // porta a fine corsa i reveal: CSS/WAAPI finiti, GSAP non legato allo scroll (scrub), AOS
  function finishAnimations() {
    running().forEach((a) => { try { a.finish(); } catch (e) { /* già concluse o non finibili */ } });
    const g = window.gsap;
    if (g && g.globalTimeline) {
      const scrubbed = new Set(((window.ScrollTrigger && window.ScrollTrigger.getAll()) || []).filter((t) => t.vars && (t.vars.scrub || t.vars.pin)).map((t) => t.animation).filter(Boolean));
      g.globalTimeline.getChildren(false, true, true).forEach((t) => { if (!scrubbed.has(t) && t.repeat() !== -1 && t.progress() < 1) t.progress(1); });
    }
    document.querySelectorAll('.aos-init:not(.aos-animate)').forEach((e) => e.classList.add('aos-animate'));
  }

  window.__h2fScroll = async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const settle = async (max) => { for (const t = Date.now(); running().length && Date.now() - t < max;) await wait(100); };
    const sc = mainScroller();
    const H = () => (sc ? sc.scrollHeight : document.documentElement.scrollHeight);
    const go = (y) => (sc ? sc.scrollTo({ top: y, behavior: 'instant' }) : scrollTo({ top: y, behavior: 'instant' }));
    for (let y = 0; y < H() && y < 40000; y += innerHeight * 0.8) { go(y); await wait(300); await settle(1500); recordVisible(); }
    go(0);
    await wait(600);
  };

  // @font-face leggibili + fogli cross-origin da scaricare dall'estensione (per lo script dei font).
  function fontFaces() {
    const faces = [], sheets = [];
    const walk = (rules, base) => {
      for (const r of rules) {
        if (r.type === CSSRule.FONT_FACE_RULE) {
          const m = r.style.getPropertyValue('src').match(/url\(["']?([^"')]+)["']?\)/g) || [];
          const urls = m.map((u) => new URL(u.replace(/^url\(["']?|["']?\)$/g, ''), base).href);
          if (urls.length) faces.push({ family: r.style.getPropertyValue('font-family').replace(/["']/g, '').trim(), weight: r.style.getPropertyValue('font-weight') || '400', style: r.style.getPropertyValue('font-style') || 'normal', range: r.style.getPropertyValue('unicode-range') || '', urls });
        } else if (r.cssRules) walk(r.cssRules, base);
        if (r.styleSheet) { try { walk(r.styleSheet.cssRules, r.styleSheet.href || base); } catch (e) { if (r.styleSheet.href) sheets.push(r.styleSheet.href); } }
      }
    };
    for (const s of document.styleSheets) {
      try { walk(s.cssRules, s.href || location.href); } catch (e) { if (s.href) sheets.push(s.href); }
    }
    const seen = new Set();
    return { faces: faces.filter((f) => { const k = f.family + f.weight + f.style + f.urls[0]; return !seen.has(k) && seen.add(k); }), sheets: [...new Set(sheets)] };
  }

  // ---------- interazioni: caroselli e hover -> varianti di componente in Figma ----------
  const NEXT = /(^|[^a-z])(next|succ|avanti|forward|right|destr)|[›»→]/i;
  const PREV = /(^|[^a-z])(prev|preced|indietro|left|sinistr)|[‹«←]/i;
  const CAROUSEL = '[aria-roledescription="carousel"],.swiper,.swiper-container,.slick-slider,.splide,.flickity-enabled,.glide,.owl-carousel,.keen-slider,.embla,[data-carousel],.carousel';
  const SLIDE = '[aria-roledescription="slide"],.swiper-slide,.slick-slide:not(.slick-cloned),.splide__slide,.glide__slide,.carousel-item,.owl-item:not(.cloned)';
  const words = (e) => [e.getAttribute('aria-label'), e.getAttribute('title'), typeof e.className === 'string' ? e.className : '', (e.textContent || '').trim().slice(0, 2),
    Object.keys(e.dataset || {}).join(' ')].join(' ');
  // mai cliccare link che portano via dalla pagina
  const clickable = (e) => e && (e.tagName !== 'A' || !e.getAttribute('href') || /^(#|javascript:)/.test(e.getAttribute('href')));
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  function arrowsOf(root, others) {
    for (let s = root, i = 0; s && i < 3; s = s.parentElement, i++) {
      const btns = [...s.querySelectorAll('button,[role=button],a')].filter((b) => clickable(b) && !b.closest(SLIDE) && !others.some((o) => o !== root && o.contains(b) && !o.contains(root)));
      const next = btns.find((b) => NEXT.test(words(b)) && !PREV.test(words(b)));
      const prev = btns.find((b) => PREV.test(words(b)) && !NEXT.test(words(b)));
      if (next) return { next, prev };
    }
    return {};
  }
  function lca(a, b) { for (let e = a; e; e = e.parentElement) if (e.contains(b)) return e; return document.body; }
  // firma visiva di un gruppo: immagini mostrate + posizioni di tracce/scroll
  function sigOf(g) {
    const out = [];
    for (const e of [g, ...g.querySelectorAll('*')].slice(0, 3000)) {
      if (e.tagName === 'IMG') out.push(e.currentSrc || e.src);
      if (e.scrollLeft || e.scrollTop) out.push(e.scrollLeft + ',' + e.scrollTop);
      const c = getComputedStyle(e);
      if (c.transform !== 'none' && c.transform !== 'matrix(1, 0, 0, 1, 0, 0)') out.push(c.transform);
      if (c.opacity !== '1') out.push('o' + c.opacity);
    }
    return out.join('|');
  }

  let carousels = [], noAnim = false;
  let capturingStates = false;
  function detectCarousels() {
    carousels = [];
    const roots = new Set([...document.querySelectorAll(CAROUSEL)].filter(visible));
    // caroselli senza classi note: una freccia "avanti" accanto a una traccia più larga del contenitore
    for (const b of document.querySelectorAll('button,[role=button]')) {
      if (!NEXT.test(words(b)) || !visible(b)) continue;
      for (let e = b.parentElement, i = 0; e && i < 4; e = e.parentElement, i++) {
        if ([e, ...e.querySelectorAll('*')].some((t) => t.scrollWidth > t.clientWidth + 20 && /hidden|auto|scroll/.test(getComputedStyle(t).overflowX))) { roots.add(e); break; }
      }
    }
    let n = 0;
    const all = [...roots].filter((root) => ![...roots].some((o) => o !== root && o.contains(root))); // solo i più esterni
    for (const root of all) {
      const { next, prev } = arrowsOf(root, all);
      // miniature/slide che controllano un'altra zona (galleria prodotto): una variante per slide
      const slideBtns = [...root.querySelectorAll(SLIDE)].map((s) => (s.matches('button,[role=button]') ? s : s.querySelector('[aria-controls],[data-carousel-item-button]'))).filter(clickable).filter(Boolean);
      const scroller = [...root.querySelectorAll('*')].find((t) => t.scrollWidth > t.clientWidth + 20 && /auto|scroll/.test(getComputedStyle(t).overflowX));
      const declared = root.matches(CAROUSEL);
      if (!next && slideBtns.length < 2 && !scroller && !declared) continue; // senza comandi: solo se dichiarato carosello (può avanzare da solo)
      let group = root;
      for (const b of [next, prev].filter(Boolean)) if (!root.contains(b)) group = lca(group, b); // frecce fuori dal carosello
      for (const b of [next, prev, ...slideBtns].filter(Boolean)) {
        const t = b.getAttribute('aria-controls') && document.getElementById(b.getAttribute('aria-controls'));
        if (t && !root.contains(t)) group = lca(group, t);
      }
      // la zona controllata (immagine grande) entra nel componente, ma senza inglobare altri caroselli
      if (group.getBoundingClientRect().height > innerHeight * 2.5 || all.some((o) => o !== root && group.contains(o))) group = root;
      const id = 'c' + n++;
      group.dataset.h2fIa = id;
      if (next) next.dataset.h2fAct = 'next';
      if (prev) prev.dataset.h2fAct = 'prev';
      slideBtns.forEach((b, j) => { if (!b.dataset.h2fAct) b.dataset.h2fAct = 'go:' + j; });
      carousels.push({ id, group, next, prev, slideBtns, scroller, name: nameFor(root) });
      if (n >= 10) break;
    }
  }

  // hover: le regole :hover del CSS duplicate su una classe, così si può "passare col mouse" da codice
  function hoverStates(skip) {
    const rules = [];
    const walk = (list) => { for (const r of list) { if (r.selectorText && r.selectorText.includes(':hover')) rules.push(r); else if (r.cssRules) walk(r.cssRules); } };
    for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch (e) { /* foglio cross-origin */ } }
    if (!rules.length) return {};
    let css = '';
    const cand = new Set();
    for (const r of rules) {
      const parts = splitTop(r.selectorText, ',').filter((p) => p.includes(':hover'));
      css += parts.map((p) => p.replace(/:hover/g, '.h2f-hover')).join(',') + '{' + r.style.cssText + '}\n';
      for (const p of parts) {
        const base = p.slice(0, p.indexOf(':hover')).trim();
        try {
          if (base && !/[>+~]$/.test(base)) document.querySelectorAll(base).forEach((e) => cand.add(e));
          else document.querySelectorAll(p.replace(/:hover/g, '').replace(/^[\s>+~]+/, '') || '*').forEach((e) => e.parentElement && cand.add(e.parentElement));
        } catch (e) { /* selettore non valido fuori contesto */ }
      }
    }
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const sigH = (el) => [el, ...el.querySelectorAll('*')].slice(0, 400).map((e) => {
      const c = getComputedStyle(e), a = getComputedStyle(e, '::after'), b = getComputedStyle(e, '::before');
      return [e.currentSrc || '', c.opacity, c.visibility, c.display, c.objectFit, c.transform, c.filter, c.backgroundImage, a.opacity, a.backgroundImage, b.opacity].join(',');
    }).join('|');
    const list = [...cand].filter((e) => e.querySelector('img,video,picture') && visible(e) && e.getBoundingClientRect().height < innerHeight * 1.5 && !skip.some((g) => e.contains(g)) && !e.querySelector('[data-h2f-act]') && !(e.dataset && e.dataset.h2fAct)); // dentro un carosello va bene (componente annidato), ma non sopra i suoi comandi
    const outer = list.filter((e) => !list.some((o) => o !== e && o.contains(e)));
    const out = {};
    let n = 0;
    try {
      for (const el of outer.slice(0, 80)) {
        const before = sigH(el);
        const chain = [];
        for (let e = el; e && e !== document.documentElement; e = e.parentElement) { e.classList.add('h2f-hover'); chain.push(e); }
        try {
          finishAnimations();
          if (sigH(el) === before) continue;
          const st = capture(el, getComputedStyle(el));
          if (!st) continue;
          const id = 'h' + n++;
          el.dataset.h2fIa = id;
          delete st.ia;
          out[id] = { kind: 'hover', name: nameFor(el), states: [st] };
        } finally {
          chain.forEach((e) => e.classList.remove('h2f-hover'));
          finishAnimations();
        }
      }
    } finally { style.remove(); }
    return out;
  }

  // stati dei caroselli (asincrono: clic, attesa del rendering del sito, cattura)
  window.__h2fInteractive = async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const settle = async () => { await wait(500); try { finishAnimations(); } catch (e) { /* */ } await wait(50); };
    const out = {};
    // stato di lavoro per carosello: firme già viste e stati catturati
    const recs = carousels.map((c) => {
      const g = c.group, r = { c, g, first: sigOf(g), states: [], map: {} };
      r.seen = [r.first];
      r.snap = () => { capturingStates = true; try { const st = capture(g, getComputedStyle(g)); if (st) delete st.ia; return st; } finally { capturingStates = false; } };
      r.add = () => { const sg = sigOf(g); let i = r.seen.indexOf(sg); if (i < 0) { const st = r.snap(); if (!st) return -1; r.seen.push(sg); r.states.push(st); i = r.seen.length - 1; } return i; };
      return r;
    });
    // autoplay: senza toccare niente, quali caroselli cambiano da soli e ogni quanto (una finestra unica per tutti).
    // Per quelli senza comandi gli stati sono proprio quelli che passano da soli.
    const auto = {};
    if (recs.length) {
      const last = recs.map((r) => r.first), changes = recs.map(() => []), t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        await wait(200);
        recs.forEach((r, i) => {
          const sg = sigOf(r.g);
          if (sg === last[i]) return;
          last[i] = sg; changes[i].push(Date.now() - t0);
          if (!r.c.next && r.c.slideBtns.length < 2 && !r.c.scroller) { try { finishAnimations(); } catch (e) { /* */ } r.add(); }
        });
      }
      // cambi ravvicinati (< 700ms) = un solo avanzamento in transizione; l'intervallo è tra l'inizio di due avanzamenti
      recs.forEach((r, i) => {
        const starts = changes[i].filter((t, j, a) => j === 0 || t - a[j - 1] > 700);
        if (starts.length >= 2) auto[r.c.id] = starts[1] - starts[0]; else if (starts.length === 1) auto[r.c.id] = starts[0];
      });
    }
    for (const r of recs) {
      const c = r.c, g = r.g, first = r.first, seen = r.seen, states = r.states, map = r.map, add = r.add;
      try {
        if (c.slideBtns.length >= 2) {
          for (let j = 0; j < Math.min(c.slideBtns.length, 10); j++) { c.slideBtns[j].click(); await settle(); map[j] = add(); }
          const home = Object.keys(map).find((j) => map[j] === 0);
          if (home !== undefined) { c.slideBtns[home].click(); await settle(); }
        } else if (c.next) {
          let k = 0;
          for (; k < 9; k++) { c.next.click(); await settle(); if (add() === 0 || seen.length > 10) break; }
          for (let i = 0; i <= k + 1 && sigOf(g) !== first; i++) { (c.prev || c.next).click(); await settle(); }
        } else if (c.scroller) {
          const sc = c.scroller, x0 = sc.scrollLeft;
          for (let k = 1; k < 10 && sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 2; k++) { sc.scrollTo({ left: x0 + k * sc.clientWidth, behavior: 'instant' }); await settle(); add(); }
          sc.scrollTo({ left: x0, behavior: 'instant' });
        }
      } catch (e) { /* carosello che non risponde: resta statico */ }
      if (states.length) out[c.id] = { kind: 'carousel', name: c.name, states, map, autoplay: auto[c.id] };
    }
    return { groups: out, images, videos };
  };

  // keep=true: lascia la pagina srotolata/rivelata per gli screenshot dei testi (poi __h2fRestore)
  let kept = null;
  window.__h2fRestore = () => { if (kept) kept.reverse().forEach(([e, css]) => { e.style.cssText = css; }); kept = null; scrollTo({ top: 0, behavior: 'instant' }); };
  // porta il documento a y per uno screenshot; hide nasconde fixed/sticky che coprirebbero il contenuto
  window.__h2fShot = (y, hide) => {
    if (hide && kept && !kept.hid) {
      kept.hid = true;
      for (const e of document.querySelectorAll('body *')) {
        if (!/fixed|sticky/.test(getComputedStyle(e).position)) continue;
        kept.push([e, e.style.cssText]);
        e.style.setProperty('visibility', 'hidden', 'important');
      }
    }
    scrollTo({ top: y, behavior: 'instant' });
    return { sy: scrollY, sx: scrollX, vw: innerWidth, vh: innerHeight };
  };

  // opt: { carousel, hover, anim } (true = cattura)
  window.__h2f = (keep, opt) => {
    opt = opt || {};
    noAnim = !opt.anim;
    const de = document.documentElement;
    const body = document.body;
    const sc = mainScroller();
    const marks = [];
    if (sc) { // srotola scroller + antenati, cattura, poi ripristina
      for (let e = sc; e; e = e.parentElement) { marks.push([e, e.style.cssText]); e.style.setProperty('overflow', 'visible', 'important'); e.style.setProperty('height', 'auto', 'important'); e.style.setProperty('max-height', 'none', 'important');
        if (/fixed|absolute/.test(getComputedStyle(e).position)) { e.style.setProperty('position', 'relative', 'important'); e.style.setProperty('inset', 'auto', 'important'); }
      }
    }
    try { finishAnimations(); } catch (e) { /* librerie con API diverse */ }
    applyRevealed(marks);
    let hovers = {};
    document.querySelectorAll('[data-h2f-ia],[data-h2f-act],[data-h2f-anchor]').forEach((e) => { delete e.dataset.h2fIa; delete e.dataset.h2fAct; delete e.dataset.h2fAnchor; });
    carousels = [];
    if (opt.carousel) try { detectCarousels(); } catch (e) { carousels = []; }
    {
      // link interni (#sezione) con bersaglio nella pagina: in Figma diventano "scorri fino a"
      document.querySelectorAll('a[href^="#"]').forEach((a) => {
        let id = ''; try { id = decodeURIComponent(a.getAttribute('href').slice(1)); } catch (e) { /* */ }
        const t = id && document.getElementById(id);
        if (!t || a.dataset.h2fAct || !visible(a) || t.contains(a)) return;
        a.dataset.h2fAct = 'to:' + id;
        t.dataset.h2fAnchor = id;
      });
      if (opt.hover) try { hovers = hoverStates(carousels.map((c) => c.group)); } catch (e) { hovers = {}; }
    }
    try {
      const root = capture(body, getComputedStyle(body)) || { type: 'frame', name: 'body', x: 0, y: 0, w: de.clientWidth, h: de.scrollHeight, fills: [], kids: [], pad: [0, 0, 0, 0] };
      const bg = color(getComputedStyle(body).backgroundColor) || color(getComputedStyle(de).backgroundColor) || { r: 1, g: 1, b: 1, a: 1 };
      return {
        version: 1,
        url: location.href,
        title: document.title,
        w: de.clientWidth,
        h: Math.max(de.scrollHeight, body.scrollHeight, root.y + root.h),
        bg,
        root,
        images,
        videos,
        streamVideos,
        fonts: fontFaces(),
        interactive: hovers,
      };
    } finally {
      pausedAnims.splice(0).forEach((a) => { try { a.play(); } catch (e) { /* elemento rimosso */ } });
      if (keep) kept = marks;
      else marks.reverse().forEach(([e, css]) => { e.style.cssText = css; });
    }
  };
})();
