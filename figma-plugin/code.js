// Ricostruisce in Figma il JSON prodotto da extension/capture.js.
// Niente optional chaining / spread: la sandbox Figma può non supportarli.
figma.showUI(__html__, { width: 460, height: 640 });

var TOL = 2;
var GENERIC = {
  'sans-serif': 'Inter', 'system-ui': 'Inter', '-apple-system': 'Inter', 'blinkmacsystemfont': 'Inter',
  'ui-sans-serif': 'Inter', 'segoe ui': 'Inter', 'serif': 'Noto Serif', 'ui-serif': 'Noto Serif',
  'monospace': 'Roboto Mono', 'ui-monospace': 'Roboto Mono', 'cursive': 'Inter', 'fantasy': 'Inter',
};
var WEIGHTS = [
  [100, ['thin', 'hairline']], [200, ['extralight', 'extra light', 'ultralight', 'ultra light']], [300, ['light']],
  [400, ['regular', 'normal', 'book', 'roman', '']], [500, ['medium']],
  [600, ['semibold', 'semi bold', 'demibold', 'demi bold']], [700, ['bold']],
  [800, ['extrabold', 'extra bold', 'ultrabold', 'ultra bold', 'heavy']], [900, ['black']],
];

var fontMap = null;
var missingFonts = {};
var loaded = {};
var fontScale = {}; // nome font del sito (minuscolo) -> proporzione di dimensione per il sostituto
var RASTER = '__raster__'; // scelta "usa l'immagine presa dal sito"
var overrides = {}; // nome font del sito (minuscolo) -> famiglia installata scelta dall'utente
var fontWeight = {}; // nome font del sito (minuscolo) -> { family, style, fw }: peso scelto per la riga d'esempio (peso fw del sito)

async function initFonts() {
  if (fontMap) return;
  fontMap = {};
  var list = await figma.listAvailableFontsAsync();
  list.forEach(function (f) {
    var k = f.fontName.family.toLowerCase();
    if (!fontMap[k]) fontMap[k] = { family: f.fontName.family, styles: [] };
    fontMap[k].styles.push(f.fontName.style);
  });
}

function styleWeight(style) {
  var s = style.toLowerCase().replace(/italic|oblique/g, '').trim();
  for (var i = 0; i < WEIGHTS.length; i++) if (WEIGHTS[i][1].indexOf(s) >= 0) return WEIGHTS[i][0];
  // nomi composti tipo "Condensed Bold": cerca la parola più lunga contenuta
  var best = 400, bestLen = 0;
  WEIGHTS.forEach(function (w) { w[1].forEach(function (n) { if (n && s.indexOf(n) >= 0 && n.length > bestLen) { best = w[0]; bestLen = n.length; } }); });
  return best;
}

function pickStyle(styles, weight, italic) {
  italic = !!italic; // campo assente = non corsivo
  var best = styles[0], bestScore = Infinity;
  styles.forEach(function (s) {
    var it = /italic|oblique/i.test(s);
    var score = Math.abs(styleWeight(s) - weight) + (it !== italic ? 1000 : 0) + (/condensed|narrow|expanded|wide|display|caption/i.test(s) ? 50 : 0);
    if (score < bestScore) { best = s; bestScore = score; }
  });
  return best;
}

function resolveFont(st) {
  var fams = st.ff || [];
  var ov = fams[0] && overrides[fams[0].toLowerCase()];
  var mark = !inRaster; // testo già importato come immagine: il font di ripiego serve solo al livello nascosto
  if (ov && fontMap[ov.toLowerCase()]) {
    var oe = fontMap[ov.toLowerCase()], w = fontWeight[fams[0].toLowerCase()];
    if (!w || w.family !== oe.family || oe.styles.indexOf(w.style) < 0) return { family: oe.family, style: pickStyle(oe.styles, st.fw, st.it) };
    if (st.fw === w.fw && !st.it) return { family: oe.family, style: w.style };
    // gli altri pesi dello stesso font si spostano di quanto si è spostato quello scelto
    return { family: oe.family, style: pickStyle(oe.styles, st.fw + styleWeight(w.style) - w.fw, st.it) };
  }
  for (var i = 0; i < fams.length; i++) {
    var k = fams[i].toLowerCase();
    var base = k.replace(/[\s-_]*(variable|var|vf)$/, ''); // "Inter Variable", "sohne-var"
    var e = fontMap[k] || fontMap[base] || (GENERIC[k] && fontMap[GENERIC[k].toLowerCase()]);
    if (e) {
      if (mark && i > 0 && !GENERIC[fams[0].toLowerCase()]) missingFonts[fams[0]] = true;
      return { family: e.family, style: pickStyle(e.styles, st.fw, st.it) };
    }
  }
  if (mark && fams[0]) missingFonts[fams[0]] = true;
  return { family: 'Inter', style: pickStyle(fontMap['inter'] ? fontMap['inter'].styles : ['Regular'], st.fw, st.it) };
}

function loadFont(f) {
  var k = f.family + '|' + f.style;
  if (!loaded[k]) loaded[k] = figma.loadFontAsync(f);
  return loaded[k];
}

// ---------- paint ----------
function rgb(c) { return { r: c.r, g: c.g, b: c.b }; }
function solid(c) { return { type: 'SOLID', color: rgb(c), opacity: c.a }; }

function linearTransform(angle, w, h) {
  var a = angle * Math.PI / 180, s = Math.sin(a), c = Math.cos(a);
  var L = Math.abs(w * s) + Math.abs(h * c) || 1;
  var r0 = [w * s / L, -h * c / L], r1 = [h * c / L, w * s / L];
  if (Math.abs(r0[0] * r1[1] - r0[1] * r1[0]) < 1e-6) r1 = [0, 1];
  return [
    [r0[0], r0[1], 0.5 - (r0[0] + r0[1]) / 2],
    [r1[0], r1[1], 0.5 - (r1[0] + r1[1]) / 2],
  ];
}

function paints(list, n, ctx) {
  var images = ctx.images;
  var out = [];
  (list || []).forEach(function (f) {
    if (f.t === 'color') out.push(solid(f.c));
    else if (f.t === 'img') {
      var img = images[f.url];
      if (img && img.hash) out.push({ type: 'IMAGE', imageHash: img.hash, scaleMode: f.mode || 'FILL', filters: n.gray ? { saturation: -Math.min(1, n.gray) } : undefined });
      if (f.tag === 'img' && n.video && ctx.videos[n.video]) out.push({ type: 'VIDEO', videoHash: ctx.videos[n.video], scaleMode: f.mode || 'FILL' });
    } else if (f.t === 'lin' || f.t === 'rad') {
      var k = 1 / Math.SQRT2, o = 0.5 - 0.5 * k;
      out.push({
        type: f.t === 'lin' ? 'GRADIENT_LINEAR' : 'GRADIENT_RADIAL',
        gradientTransform: f.t === 'lin' ? linearTransform(f.angle, n.w, n.h) : [[k, 0, o], [0, k, o]],
        gradientStops: f.stops.map(function (s) { return { position: s.p, color: { r: s.c.r, g: s.c.g, b: s.c.b, a: s.c.a } }; }),
      });
    }
  });
  return out;
}

function effects(list) {
  return (list || []).map(function (s) {
    return {
      type: s.inset ? 'INNER_SHADOW' : 'DROP_SHADOW', color: { r: s.c.r, g: s.c.g, b: s.c.b, a: s.c.a },
      offset: { x: s.x, y: s.y }, radius: s.blur, spread: s.spread, visible: true, blendMode: 'NORMAL',
    };
  });
}

// ---------- auto layout ----------
function near(a, b) { return Math.abs(a - b) <= TOL; }

// Prova a esprimere i figli in flusso come auto layout lungo un asse; null se la geometria non torna.
function tryAxis(n, flow, horiz) {
  var p = n.pad || [0, 0, 0, 0];
  var st = function (d) { return horiz ? d.x : d.y; }, sz = function (d) { return horiz ? d.w : d.h; };
  var cst = function (d) { return horiz ? d.y : d.x; }, csz = function (d) { return horiz ? d.h : d.w; };
  var start = horiz ? n.x + p[3] : n.y + p[0], end = horiz ? n.x + n.w - p[1] : n.y + n.h - p[2];
  var cStart = horiz ? n.y + p[0] : n.x + p[3], cEnd = horiz ? n.y + n.h - p[2] : n.x + n.w - p[1];
  var s = flow.slice().sort(function (a, b) { return st(a.d) - st(b.d); });

  var gaps = [];
  for (var i = 1; i < s.length; i++) {
    var g = st(s[i].d) - (st(s[i - 1].d) + sz(s[i - 1].d));
    if (g < -TOL) return null;
    gaps.push(g);
  }
  var res = { horiz: horiz, order: s, pad: p.slice(), spacing: 0, primary: 'MIN', primarySizing: 'FIXED', wrap: false };
  var lead = st(s[0].d) - start, trail = end - (st(s[s.length - 1].d) + sz(s[s.length - 1].d));
  if (lead < -TOL) return null;
  var uniform = gaps.every(function (g) { return near(g, gaps[0]); });
  if (n.justify === 'space-between' && s.length > 1 && near(lead, 0) && near(trail, 0)) res.primary = 'SPACE_BETWEEN';
  else if (!uniform && horiz) return null;
  else {
    // in verticale con distanze diverse: spaziatura 0 e spazi trasparenti tra i figli, così il testo che cresce spinge giù il resto
    if (!uniform) res.gaps = gaps.map(function (g) { return Math.max(0, g); });
    res.spacing = uniform && gaps.length ? Math.max(0, gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length) : 0;
    if (near(lead, 0)) { res.primary = 'MIN'; if (near(trail, 0)) res.primarySizing = 'AUTO'; }
    else if (near(trail, 0)) res.primary = 'MAX';
    else if (near(lead, trail)) res.primary = 'CENTER';
    else res.pad[horiz ? 3 : 0] += lead; // margine del primo figlio -> padding
  }

  var align = function (mS, mE) {
    var info = s.map(function (k) {
      var a = cst(k.d) - (cStart + mS), b = (cEnd - mE) - (cst(k.d) + csz(k.d));
      return { stretch: near(a, 0) && near(b, 0), MIN: near(a, 0), MAX: near(b, 0), CENTER: near(a, b) };
    });
    var hint = n.alignItems === 'center' ? 'CENTER' : /end/.test(n.alignItems || '') ? 'MAX' : 'MIN';
    var modes = [hint, 'MIN', 'CENTER', 'MAX'];
    for (var j = 0; j < modes.length; j++) {
      var m = modes[j];
      if (info.every(function (x) { return x.stretch || x[m]; })) return { mode: m, info: info };
    }
    return null;
  };
  var a = align(0, 0);
  if (!a) {
    var mS = Math.min.apply(null, s.map(function (k) { return cst(k.d) - cStart; }));
    var mE = Math.min.apply(null, s.map(function (k) { return cEnd - (cst(k.d) + csz(k.d)); }));
    if (mS < -TOL || mE < -TOL) return null;
    a = align(mS, mE);
    if (!a) return null;
    res.pad[horiz ? 0 : 3] += mS;
    res.pad[horiz ? 2 : 1] += mE;
  }
  res.counter = a.mode;
  res.stretch = a.info.map(function (x) { return x.stretch; });
  return res;
}

// Righe che vanno a capo (flex-wrap / grid) -> HORIZONTAL + WRAP.
function tryWrap(n, flow) {
  var p = n.pad || [0, 0, 0, 0];
  var s = flow.slice().sort(function (a, b) { return a.d.y - b.d.y || a.d.x - b.d.x; });
  var rows = [];
  s.forEach(function (k) {
    var r = rows[rows.length - 1];
    if (r && k.d.y < r.top + r.h - TOL) { r.items.push(k); r.h = Math.max(r.h, k.d.y + k.d.h - r.top); }
    else rows.push({ top: k.d.y, h: k.d.h, items: [k] });
  });
  if (rows.length < 2) return null;
  var gap = null, rowGaps = [], left = null;
  for (var i = 0; i < rows.length; i++) {
    var it = rows[i].items.sort(function (a, b) { return a.d.x - b.d.x; });
    if (left === null) left = it[0].d.x;
    if (!near(it[0].d.x, left)) return null;
    for (var j = 0; j < it.length; j++) {
      if (!near(it[j].d.y, rows[i].top)) return null;
      if (j > 0) {
        var g = it[j].d.x - (it[j - 1].d.x + it[j - 1].d.w);
        if (gap === null) gap = g; else if (!near(g, gap)) return null;
      }
    }
    if (i > 0) rowGaps.push(rows[i].top - (rows[i - 1].top + rows[i - 1].h));
  }
  if (!rowGaps.every(function (g) { return near(g, rowGaps[0]) && g >= -TOL; })) return null;
  var order = [];
  rows.forEach(function (r) { order = order.concat(r.items); });
  var pad = p.slice();
  pad[3] += left - (n.x + p[3]);
  // Figma riempie le righe da solo: se il primo elemento di una riga starebbe nella precedente, ce lo sposta
  // (es. blocco + elementi inline sotto). In quel caso il wrap non riproduce il sito.
  var avail = n.w - pad[1] - pad[3], gp = Math.max(0, gap || 0);
  for (var q = 1; q < rows.length; q++) {
    var used = rows[q - 1].items.reduce(function (a, k) { return a + k.d.w; }, 0) + gp * (rows[q - 1].items.length - 1);
    if (used + gp + rows[q].items[0].d.w <= avail + TOL) return null;
  }
  pad[0] += rows[0].top - (n.y + p[0]);
  return {
    horiz: true, wrap: true, order: order, pad: pad, spacing: Math.max(0, gap || 0), counterSpacing: Math.max(0, rowGaps[0]),
    primary: 'MIN', counter: 'MIN', primarySizing: 'FIXED', stretch: order.map(function () { return false; }),
  };
}

function inferLayout(n, kids) {
  var flow = kids.filter(function (k) { return !k.d.abs; });
  if (!flow.length) return null;
  var disp = n.display || '';
  var row = /flex/.test(disp) ? !/column/.test(n.dir || '') : /table-row/.test(disp);
  var tries;
  if (/grid/.test(disp) || (/flex/.test(disp) && n.wrap)) tries = ['H', 'V', 'W'];
  else if (/flex/.test(disp)) tries = row ? ['H'] : ['V'];
  else tries = row ? ['H', 'V', 'W'] : ['V', 'H', 'W'];
  if (flow.length === 1) tries = [row ? 'H' : 'V'];
  for (var i = 0; i < tries.length; i++) {
    var r = tries[i] === 'W' ? tryWrap(n, flow) : tryAxis(n, flow, tries[i] === 'H');
    if (r) return r;
  }
  return null;
}

// Ordina i layer come il browser li disegna (z-index). In auto layout l'ordine dei figli in flusso
// è anche l'ordine di layout, quindi si spostano solo gli assoluti sotto/sopra il flusso.
function zSort(f, flowOrder, kids) {
  var key = function (k) { return k.d.z || 0; };
  var stable = function (arr) { return arr.map(function (k, i) { return { k: k, i: i }; }).sort(function (a, b) { return key(a.k) - key(b.k) || a.i - b.i; }).map(function (x) { return x.k; }); };
  var order;
  if (!flowOrder) order = stable(kids);
  else {
    var abs = kids.filter(function (k) { return k.d.abs; });
    order = stable(abs.filter(function (k) { return key(k) < 0; }))
      .concat(flowOrder)
      .concat(stable(abs.filter(function (k) { return key(k) >= 0; })));
  }
  order.forEach(function (k, i) { f.insertChild(i, k.node); });
}

function applyLayout(f, n, kids) {
  var L = inferLayout(n, kids);
  if (!L) return false;
  zSort(f, L.order, kids);
  if (L.gaps) L.order.forEach(function (k, i) {
    if (!i || L.gaps[i - 1] < 0.5) return;
    var sp = figma.createFrame();
    sp.name = 'spazio'; sp.fills = []; sp.resize(0.01, L.gaps[i - 1]);
    f.insertChild(f.children.indexOf(k.node), sp);
  });
  f.layoutMode = L.horiz ? 'HORIZONTAL' : 'VERTICAL';
  if (L.wrap) { f.layoutWrap = 'WRAP'; f.counterAxisSpacing = L.counterSpacing; }
  f.paddingTop = Math.max(0, L.pad[0]); f.paddingRight = Math.max(0, L.pad[1]);
  f.paddingBottom = Math.max(0, L.pad[2]); f.paddingLeft = Math.max(0, L.pad[3]);
  f.itemSpacing = L.spacing;
  f.primaryAxisAlignItems = L.primary;
  f.counterAxisAlignItems = L.counter;
  f.primaryAxisSizingMode = 'FIXED';
  f.counterAxisSizingMode = 'FIXED';
  f.resize(Math.max(n.w, 0.01), Math.max(n.h, 0.01));
  // testi su una riga: mai "fill" (in orizzontale fisserebbe l'altezza e quindi la larghezza -> va a capo)
  var oneLine = function (k) { return tightText(k.d) || (k.d.type === 'text' && !k.d.multi && (L.horiz || (freeText(k.d) && L.counter === 'MIN'))); };
  L.order.forEach(function (k, i) {
    if (L.stretch[i] && !oneLine(k)) k.node.layoutAlign = 'STRETCH';
    if (k.d.grow > 0 && L.primary !== 'SPACE_BETWEEN' && !oneLine(k)) k.node.layoutGrow = 1;
  });
  // contenitore stretto attorno ai figli nel sito -> "hug" in Figma, così cresce se il testo si allarga
  // misure "vere" in Figma: un testo libero è largo quanto le sue lettere (tw), non quanto il box del sito
  var effW = function (k) { return oneLine(k) && k.d.tw !== undefined ? k.d.tw : k.d.w; };
  var flow = L.order, sz = function (k) { return L.horiz ? effW(k) : k.d.h; }, csz = function (k) { return L.horiz ? k.d.h : effW(k); };
  if (!L.wrap && flow.length && L.primary !== 'SPACE_BETWEEN' && !flow.some(function (k) { return k.d.grow > 0; })) {
    var used = flow.reduce(function (a, k) { return a + sz(k); }, 0) + L.spacing * (flow.length - 1) + (L.gaps ? L.gaps.reduce(function (a, g) { return a + g; }, 0) : 0) + (L.horiz ? L.pad[1] + L.pad[3] : L.pad[0] + L.pad[2]);
    if (Math.abs(used - (L.horiz ? n.w : n.h)) <= TOL) L.primarySizing = 'AUTO';
  }
  var cmax = Math.max.apply(null, flow.map(csz));
  var hugCounter = flow.length && !L.wrap && !L.stretch.some(function (x, i) { return x && !oneLine(L.order[i]); }) &&
    Math.abs(cmax + (L.horiz ? L.pad[0] + L.pad[2] : L.pad[1] + L.pad[3]) - (L.horiz ? n.h : n.w)) <= TOL;
  kids.forEach(function (k) {
    if (!k.d.abs) return;
    k.node.layoutPositioning = 'ABSOLUTE';
    place(k.node, k.d, n.x, n.y);
  });
  if (L.primarySizing === 'AUTO') f.primaryAxisSizingMode = 'AUTO';
  if (hugCounter) f.counterAxisSizingMode = 'AUTO';
  return true;
}

// ---------- costruzione nodi ----------
// Posiziona il nodo; se ruotato (transform CSS) usa relativeTransform attorno al centro reale.
function place(node, d, ox, oy) {
  if (!d.rot) { node.x = d.x - ox; node.y = d.y - oy; return; }
  var a = d.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), w = node.width, h = node.height;
  var cx = d.cx - ox, cy = d.cy - oy;
  node.relativeTransform = [[c, -s, cx - (c * w / 2 - s * h / 2)], [s, c, cy - (s * w / 2 + c * h / 2)]];
}

function decorate(node, d, ctx) {
  if (d.opacity !== undefined && d.opacity < 1) node.opacity = d.opacity;
  if (d.blend) { try { node.blendMode = d.blend; } catch (e) { /* modalità non supportata */ } }
  var fx = [];
  if (d.blur) fx.push({ type: 'LAYER_BLUR', radius: d.blur, visible: true });
  if (d.bgBlur) fx.push({ type: 'BACKGROUND_BLUR', radius: d.bgBlur, visible: true });
  if (fx.length) node.effects = (node.effects || []).concat(fx);
  if (d.pos && ctx) ctx.pinned.push({ node: node, d: d });
}

var progress = { done: 0, total: 0 };
function tick() {
  progress.done++;
  if (progress.done % 200 === 0) figma.ui.postMessage({ type: 'progress', text: 'Layer ' + progress.done + '/' + progress.total });
}

// Testo come immagine ritagliata dal sito + lo stesso testo in un livello nascosto (resta scritto e cercabile).
async function buildRasterText(d, parent, ox, oy, ctx) {
  var f = figma.createFrame();
  parent.appendChild(f);
  f.resize(Math.max(d.w, 0.01), Math.max(d.h, 0.01));
  f.fills = [];
  f.clipsContent = false;
  var m = d.raster.m || 0;
  var img = figma.createRectangle();
  f.appendChild(img);
  img.name = 'immagine dal sito';
  img.resize(d.w + 2 * m, d.h);
  img.x = -m; img.y = 0;
  img.fills = [{ type: 'IMAGE', imageHash: ctx.images[d.raster.key].hash, scaleMode: 'FILL' }];
  inRaster = true;
  try { var t = await buildText(d, f, d.x, d.y, null); } finally { inRaster = false; }
  t.visible = false;
  f.name = (d.name || d.text.slice(0, 40)) + ' · immagine (' + (d.fx ? d.fx.join(', ') : 'font ' + d.segs[0].s.ff[0]) + ')';
  place(f, d, ox, oy);
  decorate(f, d, ctx);
  rasterCount++;
  return f;
}
var rasterCount = 0, inRaster = false, rasterFx = true;

function wantsRaster(d, ctx) {
  if (!d.raster || !ctx || !ctx.images[d.raster.key] || !ctx.images[d.raster.key].hash) return false;
  if (d.fx && rasterFx) return true; // assi variabili, corsivo simulato, skew…: solo l'immagine è uguale
  return d.segs.some(function (s) { return s.s.ff[0] && overrides[s.s.ff[0].toLowerCase()] === RASTER; });
}

async function buildText(d, parent, ox, oy, ctx) {
  if (wantsRaster(d, ctx)) return buildRasterText(d, parent, ox, oy, ctx);
  var t = figma.createText();
  parent.appendChild(t);
  var fonts = d.segs.map(function (s) { return resolveFont(s.s); });
  await Promise.all(fonts.map(loadFont));
  t.fontName = fonts[0];
  t.characters = d.text;
  // Figma può normalizzare il testo (es. \r\n, caratteri di controllo) e i segmenti vuoti non sono accettati
  var len = t.characters.length;
  d.segs.forEach(function (s, i) {
    var st = s.s, b = Math.min(s.b, len), e = Math.min(s.e, len);
    if (b >= e) return;
    t.setRangeFontName(b, e, fonts[i]);
    t.setRangeFontSize(b, e, Math.max(1, st.fs * (fontScale[(st.ff[0] || '').toLowerCase()] || 1)));
    t.setRangeFills(b, e, [solid(st.c)]);
    t.setRangeLineHeight(b, e, st.lh ? { value: st.lh, unit: 'PIXELS' } : { unit: 'AUTO' });
    if (st.ls) t.setRangeLetterSpacing(b, e, { value: st.ls, unit: 'PIXELS' });
    if (st.deco) t.setRangeTextDecoration(b, e, st.deco);
    if (st.tc) t.setRangeTextCase(b, e, st.tc);
  });
  t.name = d.name || d.text.slice(0, 40);
  if (d.shadows && d.shadows.length) t.effects = effects(d.shadows);
  t.textAlignHorizontal = d.align || 'LEFT';
  if (d.multi || (d.fill && !freeText(d))) {
    t.textAutoResize = 'HEIGHT';
    t.resize(Math.max(1, d.w + (d.fill ? 0 : 2)), Math.max(1, d.h));
  } else t.textAutoResize = 'WIDTH_AND_HEIGHT';
  place(t, d, ox + (d.align === 'CENTER' && !d.fill && d.multi ? 1 : 0), oy);
  decorate(t, d, ctx);
  tick();
  return t;
}

// testo su una riga che nel sito occupa tutto il suo box: in Figma non deve mai andare a capo (col font sostituto può allargarsi)
function tightText(d) { return d.type === 'text' && !d.multi && (!d.fill || (d.tw !== undefined && d.w - d.tw <= TOL * 2)); }
// a sinistra il box largo non serve all'allineamento: resta libero (si allarga invece di andare a capo)
function freeText(d) { return tightText(d) || (d.type === 'text' && !d.multi && (d.align || 'LEFT') === 'LEFT'); }

function buildSvg(d, parent, ox, oy, ctx) {
  var node;
  try {
    var svg = d.svg;
    if (!/<svg[^>]*\swidth=/.test(svg)) svg = svg.replace(/<svg\b/, '<svg width="' + d.w + '" height="' + d.h + '"');
    node = figma.createNodeFromSvg(svg);
  } catch (e) {
    node = figma.createFrame();
    node.fills = [];
  }
  parent.appendChild(node);
  node.name = d.name || 'svg';
  if (Math.abs(node.width - d.w) > 0.5 || Math.abs(node.height - d.h) > 0.5) node.resize(Math.max(d.w, 0.01), Math.max(d.h, 0.01));
  place(node, d, ox, oy);
  node.clipsContent = false;
  decorate(node, d, ctx);
  tick();
  return node;
}

// ---------- interazioni: caroselli e hover come varianti di componente ----------
function componentsArea(ctx) {
  if (ctx.area) return ctx.area;
  var a = figma.createFrame();
  a.name = 'Circles&Triangles · componenti';
  a.fills = [];
  a.layoutMode = 'VERTICAL'; a.itemSpacing = 120; a.paddingTop = a.paddingLeft = a.paddingRight = a.paddingBottom = 40;
  a.primaryAxisSizingMode = 'AUTO'; a.counterAxisSizingMode = 'AUTO';
  figma.currentPage.appendChild(a);
  a.x = ctx.page.x + ctx.page.width + 200; a.y = ctx.page.y;
  ctx.area = a;
  return a;
}

function changeTo(dest) {
  return { type: 'NODE', destinationId: dest.id, navigation: 'CHANGE_TO', transition: { type: 'SMART_ANIMATE', easing: { type: 'EASE_OUT' }, duration: 0.3 }, resetScrollPosition: false };
}
async function react(node, trigger, dest) {
  var r = (node.reactions || []).filter(function (x) { return !x.trigger || x.trigger.type !== trigger; });
  r.push({ trigger: { type: trigger }, actions: [changeTo(dest)] });
  try { await node.setReactionsAsync(r); ctx_reactions++; } catch (e) { /* nodo che non accetta interazioni */ }
}
var ctx_reactions = 0;
// Animazioni CSS infinite -> Figma Motion: keyframe relativi al primo fotogramma (quello catturato).
// La timeline è una sola per tavola e nel prototipo riparte da capo: ogni ciclo viene ripetuto fino a ~30 s,
// così animazioni con durate diverse restano continue. ponytail: al riavvio dei 30 s c'è uno scatto se i periodi non dividono 30.
var MOTION_LOOP = 30, MOTION_EASE = { linear: 'LINEAR', 'ease-in': 'EASE_IN', 'ease-out': 'EASE_OUT', 'ease-in-out': 'EASE_IN_AND_OUT' };
var MOTION_TRACKS = { x: 'TRANSLATION_X', y: 'TRANSLATION_Y', r: 'ROTATION', sx: 'SCALE_X', sy: 'SCALE_Y', op: 'OPACITY' };
function motionEase(s) {
  if (MOTION_EASE[s]) return { type: MOTION_EASE[s] };
  if (s === 'ease') s = 'cubic-bezier(0.25, 0.1, 0.25, 1)';
  var m = /^cubic-bezier\(([^)]+)\)/.exec(s || '');
  if (m) { var v = m[1].split(',').map(Number); return { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: v[0], y1: v[1], x2: v[2], y2: v[3] } }; }
  return { type: /^steps/.test(s || '') ? 'HOLD' : 'LINEAR' };
}
function animate(node, a, ctx) {
  if (!a || !a.keys || a.keys.length < 2 || !node.applyManualKeyframeTrack || ctx.motionOff) return;
  var k0 = a.keys[0], cyc = a.keys.map(function (k) { return { t: k.t, k: k, e: k.e }; });
  if (/alternate/.test(a.dir || '')) for (var j = a.keys.length - 2; j >= 0; j--) cyc.push({ t: 2 - a.keys[j].t, k: a.keys[j], e: a.keys[j].e });
  var period = a.dur * cyc[cyc.length - 1].t, reps = Math.max(1, Math.min(200, Math.floor(MOTION_LOOP / period)));
  var val = { x: function (k) { return k.x - k0.x; }, y: function (k) { return k.y - k0.y; }, r: function (k) { return -(k.r - k0.r); },
    sx: function (k) { return k.sx / (k0.sx || 1); }, sy: function (k) { return k.sy / (k0.sy || 1); }, op: function (k) { return k.op === undefined ? 1 : k.op; } };
  var done = 0;
  try {
    for (var p in MOTION_TRACKS) {
      if (!a.keys.some(function (k) { return Math.abs(val[p](k) - val[p](k0)) > 0.01; })) continue;
      // dissolvenze fino a invisibile (fade-in/out): in Figma scattano 0→100, meglio sempre visibile
      if (p === 'op' && a.keys.some(function (k) { return val.op(k) < 0.05; })) { node.opacity = 1; continue; }
      var kfs = [];
      for (var c = 0; c < reps; c++) cyc.forEach(function (q, i) {
        var at = c * period + q.t * a.dur;
        if (i === 0 && c > 0) at += 0.001; // il ciclo riparte di scatto dal primo fotogramma
        kfs.push({ timelinePosition: at, value: { type: 'FLOAT', value: val[p](q.k) }, easing: i === 0 ? { type: 'HOLD' } : motionEase(cyc[i - 1].e) });
      });
      delete kfs[0].easing;
      node.applyManualKeyframeTrack({ type: 'PROPERTY', name: MOTION_TRACKS[p] }, { keyframes: kfs });
      done++;
    }
    if (done) { var tl = node.timelines[0]; node.setTimelineDuration(tl.id, Math.max(tl.duration, reps * period)); ctx.animated++; } // la timeline è della tavola: non accorciarla
  } catch (e) { ctx.motionOff = /not a supported API/i.test(String(e && e.message)); ctx.animErr = String(e && e.message || e); }
}

async function reactAfter(node, seconds, dest) {
  var r = (node.reactions || []).filter(function (x) { return !x.trigger || x.trigger.type !== 'AFTER_TIMEOUT'; });
  r.push({ trigger: { type: 'AFTER_TIMEOUT', timeout: Math.max(0.5, seconds) }, actions: [changeTo(dest)] });
  try { await node.setReactionsAsync(r); ctx_reactions++; } catch (e) { /* */ }
}
// link interni (#sezione): clic -> scorre fino alla sezione.
// Nel prototipo funziona solo lo scorrimento istantaneo: SMART_ANIMATE viene rifiutato, SCROLL_ANIMATE è accettato ma non scorre.
async function linkAnchors(ctx) {
  for (var i = 0; i < ctx.links.length; i++) {
    var l = ctx.links[i], dest = ctx.anchors[l.id];
    if (!dest || dest.removed) continue;
    try {
      await l.node.setReactionsAsync([{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: dest.id, navigation: 'SCROLL_TO', transition: null }] }]);
      ctx_reactions++; ctx.linked++;
    } catch (e) { /* nodo che non accetta interazioni */ }
  }
}

async function buildInteractive(d, g, parent, ox, oy, ctx) {
  var area = componentsArea(ctx);
  var states = [d].concat(g.states), comps = [], acts = [];
  var prevActs = ctx.acts;
  ctx.building[g.id] = true; // lo stesso gruppo non può contenere se stesso; altri (hover nei caroselli) sì
  ctx.inComp = (ctx.inComp || 0) + 1;
  try {
    for (var i = 0; i < states.length; i++) {
      ctx.acts = [];
      var node = await buildNode(states[i], area, states[i].x, states[i].y, ctx);
      if (!node) continue;
      var comp = figma.createComponentFromNode(node);
      comp.name = 'Stato=' + (g.kind === 'hover' ? (i ? 'Hover' : 'Default') : String(i + 1));
      comps.push(comp); acts.push(ctx.acts);
    }
  } finally { ctx.acts = prevActs; ctx.building[g.id] = false; ctx.inComp--; }
  if (comps.length < 2) { comps.forEach(function (c) { c.remove(); }); return null; }
  var set = figma.combineAsVariants(comps, area);
  set.name = (g.kind === 'hover' ? 'Hover · ' : 'Carosello · ') + (g.name || d.name || '');
  set.layoutMode = 'HORIZONTAL'; set.itemSpacing = 40;
  set.paddingTop = set.paddingLeft = set.paddingRight = set.paddingBottom = 40;
  set.primaryAxisSizingMode = 'AUTO'; set.counterAxisSizingMode = 'AUTO';
  var N = comps.length;
  if (g.kind === 'hover') await react(comps[0], 'ON_HOVER', comps[1]); // Figma torna da solo allo stato normale all'uscita
  else {
    for (var v = 0; v < N; v++) {
      var linked = false;
      for (var a = 0; a < acts[v].length; a++) {
        var act = acts[v][a].act, dest = null;
        if (act === 'next') dest = comps[(v + 1) % N];
        else if (act === 'prev') dest = comps[(v - 1 + N) % N];
        else if (/^go:/.test(act) && g.map && g.map[act.slice(3)] >= 0) dest = comps[g.map[act.slice(3)]];
        if (dest && dest !== comps[v]) { await react(acts[v][a].node, 'ON_CLICK', dest); linked = true; }
      }
      if (!linked) await react(comps[v], 'ON_CLICK', comps[(v + 1) % N]); // nessun bottone: clic sul carosello = avanti
      // il carosello sul sito avanza da solo: stesso intervallo nel prototipo
      if (g.autoplay) await reactAfter(comps[v], g.autoplay / 1000, comps[(v + 1) % N]);
      await react(comps[v], 'ON_DRAG', comps[(v + 1) % N]); // trascinamento = avanti
    }
  }
  ctx.sets[g.id] = set;
  return instanceOf(set, d, parent, ox, oy);
}
function instanceOf(set, d, parent, ox, oy) {
  var inst = set.defaultVariant.createInstance();
  parent.appendChild(inst);
  place(inst, d, ox, oy);
  return inst;
}

function hasAct(d) { return !!d.act || (d.kids || []).some(hasAct); }

// "Forma" di un pezzo di pagina senza i contenuti (testi, foto): card uguali -> stesso componente
function shapeOf(d) {
  // niente nomi di classe: molti siti generano una classe diversa per ogni card (CSS-in-JS)
  return (d.type === 'text' ? (d.raster ? 'R' : 'T') : d.type === 'svg' ? 'S' : 'F' + (d.fills || []).map(function (f) { return f.t; }).join('')) +
    '(' + (d.kids || []).map(shapeOf).join(',') + ')';
}

// Riporta su un'istanza i contenuti di una card (foto, testi) al posto di quelli del componente
async function overrideInstance(inst, comp, proto, d, ctx) {
  var map = {};
  (function pair(m, i) { map[m.id] = i; for (var k = 0; k < (m.children || []).length && i.children && k < i.children.length; k++) pair(m.children[k], i.children[k]); })(comp, inst);
  async function walk(pd, dd, isRoot) {
    var target = isRoot ? inst : (pd._n && map[pd._n.id]);
    if (target) {
      try {
        if (dd.type === 'text' && dd.raster && target.children && target.children[0] && ctx.images[dd.raster.key]) {
          target.children[0].fills = [{ type: 'IMAGE', imageHash: ctx.images[dd.raster.key].hash, scaleMode: 'FILL' }];
        } else if (dd.type === 'text' && target.type === 'TEXT' && target.characters !== dd.text) {
          var fn = target.getRangeAllFontNames ? target.getRangeAllFontNames(0, target.characters.length) : [target.fontName];
          await Promise.all(fn.map(loadFont));
          target.characters = dd.text;
        } else if (dd.type === 'frame' && (dd.fills || []).some(function (f) { return f.t === 'img'; })) {
          target.fills = paints(dd.fills, dd, ctx);
        }
      } catch (e) { /* override non applicabile: resta il contenuto del componente */ }
    }
    for (var k = 0; k < (pd.kids || []).length; k++) await walk(pd.kids[k], dd.kids[k], false);
  }
  await walk(proto, d, true);
  ctx.overridden++;
  if (Math.abs(inst.width - d.w) > 1 || Math.abs(inst.height - d.h) > 1) { try { inst.resize(Math.max(d.w, 0.01), Math.max(d.h, 0.01)); } catch (e) { /* */ } }
}

async function buildNode(d, parent, ox, oy, ctx) {
  var ig = d.ia && ctx.interactive && ctx.interactive[d.ia];
  if (ig && ig.kind === 'hover' && hasAct(d)) ig = null; // hover sopra frecce/miniature di un carosello: vince il carosello
  if (ig && !ctx.building[d.ia]) {
    var g = ctx.interactive[d.ia], plain = Object.assign({}, d);
    g.id = d.ia;
    delete plain.ia;
    var inst = null;
    // hover: un solo componente per tutte le card con la stessa struttura e la stessa misura, contenuti come override
    // (card uguali ma più piccole in un'altra griglia: nell'istanza resterebbe il contenuto grande, tagliato)
    var key = g.kind === 'hover' && g.states[0] ? shapeOf(d) + '|' + shapeOf(g.states[0]) + '|' + Math.round(d.w) + 'x' + Math.round(d.h) : null;
    var proto = key && ctx.protos[key];
    // componente Card condiviso: ogni istanza (anche la stessa card ripetuta negli stati di un carosello) riceve i suoi contenuti
    if (proto) { inst = instanceOf(proto.set, d, parent, ox, oy); await overrideInstance(inst, proto.set.defaultVariant, proto.d, d, ctx); ctx.sets[d.ia] = proto.set; ctx.reused++; }
    else if (ctx.sets[d.ia]) inst = instanceOf(ctx.sets[d.ia], d, parent, ox, oy);
    else {
      inst = await buildInteractive(plain, g, parent, ox, oy, ctx);
      if (inst && key) { ctx.protos[key] = { set: ctx.sets[d.ia], d: plain }; ctx.sets[d.ia].name = 'Card · ' + (g.name || d.name || ''); }
    }
    if (inst) { decorate(inst, d, ctx); animate(inst, d.anim, ctx); return inst; }
  }
  var built = await buildNode2(d, parent, ox, oy, ctx);
  if (built) { d._n = built; animate(built, d.anim, ctx); }
  if (built && d.anchor && !ctx.inComp) ctx.anchors[d.anchor] = built; // solo nella tavola: lo scroll-to resta nella pagina
  if (built && d.act && /^to:/.test(d.act)) ctx.links.push({ node: built, id: d.act.slice(3) });
  else if (built && d.act && ctx.acts) ctx.acts.push({ node: built, act: d.act });
  return built;
}

async function buildNode2(d, parent, ox, oy, ctx) {
  if (d.type === 'text') return buildText(d, parent, ox, oy, ctx);
  if (d.type === 'svg') return buildSvg(d, parent, ox, oy, ctx);
  // <img> con sorgente SVG -> vettoriale vero invece di bitmap
  if (d.isImg && d.fills.length === 1 && d.fills[0].t === 'img') {
    var im = ctx.images[d.fills[0].url];
    if (im && im.svg && !d.radius && !d.border) return buildSvg({ name: d.name, x: d.x, y: d.y, w: d.w, h: d.h, svg: im.svg, opacity: d.opacity, blend: d.blend, pos: d.pos, abs: d.abs }, parent, ox, oy, ctx);
  }
  var f = figma.createFrame();
  parent.appendChild(f);
  f.name = d.name;
  f.resize(Math.max(d.w, 0.01), Math.max(d.h, 0.01));
  place(f, d, ox, oy);
  f.fills = paints(d.fills, d, ctx);
  f.clipsContent = !!d.clip;
  if (d.scrollX) f.overflowDirection = 'HORIZONTAL'; // nel prototipo scorre col trackpad come sul sito
  if (d.border) {
    f.strokes = [solid(d.border.c)];
    f.strokeAlign = 'INSIDE';
    var w = d.border.w;
    if (w[0] === w[1] && w[1] === w[2] && w[2] === w[3]) f.strokeWeight = w[0];
    else { f.strokeTopWeight = w[0]; f.strokeRightWeight = w[1]; f.strokeBottomWeight = w[2]; f.strokeLeftWeight = w[3]; }
  }
  if (d.radius) {
    f.topLeftRadius = d.radius[0]; f.topRightRadius = d.radius[1];
    f.bottomRightRadius = d.radius[2]; f.bottomLeftRadius = d.radius[3];
  }
  if (d.shadows && d.shadows.length) f.effects = effects(d.shadows);
  decorate(f, d, ctx);
  tick();

  var kids = [];
  for (var i = 0; i < (d.kids || []).length; i++) {
    var k = d.kids[i];
    kids.push({ d: k, node: await buildNode(k, f, d.x, d.y, ctx) });
  }
  var laidOut = false;
  if (ctx.autoLayout && kids.length) {
    try { laidOut = applyLayout(f, d, kids); } catch (e) { f.layoutMode = 'NONE'; }
  }
  if (!laidOut && kids.length) zSort(f, null, kids);
  return f;
}

var stickyLimited = [], stickyAuto = 0;
var NS = 'circlestriangles', STICKY_KEY = 'sticky', TPL_KEY = 'stickyTemplate'; // dati condivisi: leggibili anche da altri strumenti
// L'API dei plugin non sa impostare "Sticky (stop at top edge)", ma un duplicato di un livello sticky resta sticky
// (verificato nel prototipo, anche svuotato e riempito con altro) e l'export JSON_REST_V1 dice se un livello lo è.
// Quindi: la prima volta l'utente imposta Sticky a mano sui livelli selezionati, dall'import dopo il plugin usa
// uno di quelli come modello e avvolge ogni sticky in una copia del modello.
async function isSticky(n) {
  try { var j = await n.exportAsync({ format: 'JSON_REST_V1' }); return !!(j && j.document && j.document.scrollBehavior === 'STICKY_SCROLLS'); } catch (e) { return false; }
}
async function stickyTemplate() {
  var id = figma.root.getSharedPluginData(NS, TPL_KEY), t = id ? await figma.getNodeByIdAsync(id) : null;
  if (t && !t.removed) return t;
  var marked = figma.currentPage.findAllWithCriteria({ types: ['FRAME'], sharedPluginData: { namespace: NS, keys: [STICKY_KEY] } });
  for (var i = 0; i < marked.length; i++) {
    if (!(await isSticky(marked[i]))) continue;
    t = marked[i].clone();
    figma.currentPage.appendChild(t);
    t.children.slice().forEach(function (k) { k.remove(); });
    t.fills = []; t.strokes = []; t.effects = []; t.layoutMode = 'NONE'; t.cornerRadius = 0; t.opacity = 1; t.rotation = 0; t.clipsContent = false;
    try { await t.setReactionsAsync([]); } catch (e) { /* nessuna reazione */ }
    t.setSharedPluginData(NS, STICKY_KEY, '');
    t.name = 'Circles&Triangles · modello sticky (non cancellare)';
    t.visible = false; t.locked = true;
    figma.root.setSharedPluginData(NS, TPL_KEY, t.id);
    return t;
  }
  return null;
}
// Lo sticky di Figma resta dentro il suo genitore diretto (come il CSS) ma sotto i livelli che vengono dopo:
// sul sito invece sta sopra a tutto. Quindi va in cima ai livelli: quello che si attacca per tutta la pagina
// (header) diventa figlio della tavola, sotto ai fixed; quello limitato al suo contenitore diventa l'ultimo
// figlio del contenitore. Se il contenitore è in auto layout al suo posto resta uno spazio vuoto.
function raiseSticky(n, page, toPage, fixedCount, tpl) {
  var P = n.parent, at = n.absoluteTransform, pt = (toPage ? page : P).absoluteTransform;
  var x = at[0][2] - pt[0][2], y = at[1][2] - pt[1][2];
  // nel prototipo uno sticky in posizione assoluta dentro un auto layout non si attacca: il contenitore
  // perde l'auto layout (i figli restano dove sono) e lo sticky ne diventa un figlio normale
  if (!toPage && P.layoutMode !== 'NONE') P.layoutMode = 'NONE';
  if (toPage && P.layoutMode !== 'NONE' && n.layoutPositioning !== 'ABSOLUTE') {
    var sp = figma.createFrame();
    P.insertChild(P.children.indexOf(n), sp);
    sp.name = n.name + ' · spazio'; sp.fills = []; sp.resize(Math.max(0.01, n.width), Math.max(0.01, n.height));
    sp.layoutAlign = n.layoutAlign; sp.layoutGrow = n.layoutGrow;
  }
  var T = toPage ? page : P, node = n;
  if (tpl) { node = tpl.clone(); node.visible = true; node.locked = false; node.name = n.name; node.resize(Math.max(0.01, n.width), Math.max(0.01, n.height)); }
  T.appendChild(node);
  if (toPage && fixedCount) T.insertChild(T.children.length - 1 - fixedCount, node); // sotto ai fixed
  if (T.layoutMode !== 'NONE') node.layoutPositioning = 'ABSOLUTE';
  node.x = x; node.y = y;
  if (node !== n) { node.appendChild(n); n.x = 0; n.y = 0; }
  return node;
}
// position:fixed -> ultimi figli della tavola + numberOfFixedChildren (l'unico modo esposto ai plugin).
// position:sticky -> in cima ai livelli (vedi sopra), reso sticky col modello; senza modello resta selezionato
// per impostare Prototype → Position → Sticky in un colpo solo.
async function pinToPage(page, pinned) {
  var moved = [], tpl = pinned.some(function (p) { return p.d.pos === 'sticky'; }) ? await stickyTemplate() : null;
  pinned.forEach(function (p) {
    if (p.d.pos === 'sticky') return;
    for (var a = p.node.parent; a && a !== page; a = a.parent) if (moved.indexOf(a) >= 0) return; // già spostato con l'antenato
    page.appendChild(p.node); // anche se già figlio: lo porta in cima, dove stanno i fixed
    place(p.node, p.d, 0, 0);
    // fixed in basso: in fondo alla tavola con vincolo Bottom, nel prototipo resta attaccato al fondo dello schermo
    if (p.d.pinB !== undefined) {
      p.node.y = page.height - p.node.height - p.d.pinB;
      try { p.node.constraints = { horizontal: p.node.constraints.horizontal, vertical: 'MAX' }; } catch (e) { /* nodo senza vincoli */ }
    }
    moved.push(p.node);
  });
  pinned.forEach(function (p) {
    if (p.d.pos !== 'sticky') return;
    for (var a = p.node.parent; a; a = a.parent) if (a.type === 'INSTANCE' || moved.indexOf(a) >= 0) return; // dentro un'istanza o in un fixed
    var whole = p.d.stickyEnd === undefined || p.d.stickyEnd >= page.height - 100;
    var n = raiseSticky(p.node, page, whole, moved.length, tpl);
    n.name += whole ? ' (sticky)' : ' (sticky fino a ' + Math.round(p.d.stickyEnd) + 'px)';
    n.setSharedPluginData(NS, STICKY_KEY, '1');
    if (tpl) stickyAuto++; else stickyLimited.push(n);
  });
  if (!moved.length) return 0;
  try { page.numberOfFixedChildren = moved.length; return 0; } catch (e) { return moved.length; }
}

function count(d) {
  var c = 1;
  (d.kids || []).forEach(function (k) { c += count(k); });
  return c;
}

async function importCapture(data, opts) {
  if (!data || !data.root) throw new Error('JSON non valido: manca "root". Usa l\'estensione per catturare la pagina.');
  missingFonts = {};
  stickyLimited = []; stickyAuto = 0;
  rasterCount = 0;
  rasterFx = opts.rasterFx !== false;
  fontScale = {};
  Object.keys(opts.fontScale || {}).forEach(function (k) { fontScale[k.toLowerCase()] = opts.fontScale[k]; });
  fontWeight = {};
  Object.keys(opts.fontWeight || {}).forEach(function (k) { fontWeight[k.toLowerCase()] = opts.fontWeight[k]; });
  overrides = {};
  [data.fontAliases || {}, opts.fonts || {}].forEach(function (m) { Object.keys(m).forEach(function (k) { overrides[k.toLowerCase()] = m[k]; }); });
  progress = { done: 0, total: count(data.root) };
  figma.ui.postMessage({ type: 'progress', text: 'Carico i font…' });
  await initFonts();

  figma.ui.postMessage({ type: 'progress', text: 'Carico le immagini…' });
  var images = {};
  Object.keys(data.images || {}).forEach(function (url) {
    var im = data.images[url];
    if (!im) return;
    var entry = { svg: im.svg || null, hash: null };
    if (im.data) { try { entry.hash = figma.createImage(figma.base64Decode(im.data)).hash; } catch (e) { /* formato non supportato */ } }
    images[url] = entry;
  });

  var videos = {}, videoErr = (data.videoErrors || []).slice();
  if (data.streamVideos) videoErr.push(data.streamVideos + ' in streaming (non scaricabili, resta il fotogramma)');
  var vurls = Object.keys(data.videos || {});
  for (var vi = 0; vi < vurls.length; vi++) {
    var v = data.videos[vurls[vi]];
    if (!v || !v.data) continue;
    figma.ui.postMessage({ type: 'progress', text: 'Carico i video…' });
    try { videos[vurls[vi]] = (await figma.createVideoAsync(figma.base64Decode(v.data))).hash; } catch (e) { videoErr.push(vurls[vi].split('/').pop().slice(0, 40) + ': ' + ((e && e.message) || e)); } // es. piano Figma senza video
  }

  var page = figma.createFrame();
  page.name = (data.title || data.url || 'Import') + ' — ' + data.w + 'px';
  page.resize(data.w, Math.max(1, data.h));
  page.fills = [solid(data.bg || { r: 1, g: 1, b: 1, a: 1 })];
  page.clipsContent = true;
  page.overflowDirection = 'VERTICAL'; // nel prototipo scorre solo in verticale, mai a destra/sinistra
  var c = figma.viewport.center;
  page.x = Math.round(c.x - data.w / 2);
  page.y = Math.round(c.y);
  figma.currentPage.appendChild(page);

  var ctx = { images: images, videos: videos, autoLayout: opts.autoLayout !== false, pinned: [], page: page, interactive: opts.interactive === false ? null : data.interactive, acts: null, building: {}, sets: {}, protos: {}, reused: 0, overridden: 0, animated: 0, links: [], anchors: {}, linked: 0 };
  // il frame principale (body) alto quanto tutta la pagina: se nel CSS è più basso il resto "esce" e in preview non scorre
  if (data.root.type === 'frame') data.root.h = Math.max(data.root.h, data.h - data.root.y);
  ctx_reactions = 0;
  await buildNode(data.root, page, 0, 0, ctx);
  var pinFailed = await pinToPage(page, ctx.pinned);
  await linkAnchors(ctx);

  figma.viewport.scrollAndZoomIntoView([page]);
  figma.currentPage.selection = stickyLimited.length ? stickyLimited : [page]; // sticky già selezionati: Prototype → Position → Sticky
  return { layers: progress.done, missing: Object.keys(missingFonts), pinFailed: pinFailed, raster: rasterCount, components: ctx.area ? ctx.area.children.length : 0, stickyLimited: stickyLimited.length, stickyAuto: stickyAuto, linked: ctx.linked, reused: ctx.reused, overridden: ctx.overridden, animated: ctx.animated, animErr: ctx.animErr, reactions: ctx_reactions, videos: Object.keys(videos).length, videoErr: videoErr };
}

// Genere del font dal nome e dallo stack CSS -> font installati dello stesso genere (se fonts.sh non ha misurato niente)
var KIN = {
  mono: ['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'IBM Plex Mono', 'Roboto Mono', 'Courier New'],
  serif: ['Times New Roman', 'Georgia', 'Baskerville', 'Charter', 'Iowan Old Style', 'Noto Serif', 'Garamond'],
  sans: ['Helvetica Neue', 'Helvetica', 'Arial', 'Inter', 'SF Pro Text', 'Roboto', 'Avenir Next'],
};
function genreOf(ff) {
  var n = ff[0].toLowerCase(), rest = ff.slice(1).join(' ').toLowerCase();
  if (/mono|code|courier|console/.test(n) || /monospace/.test(rest)) return 'mono';
  if (/sans|grotesk|grotesque|gothic|neue|helvet|arial/.test(n)) return 'sans';
  if (/serif|garamond|caslon|times|roman|baskerville|bodoni|didot|book/.test(n) || /(^|\s)serif/.test(rest)) return 'serif';
  return 'sans';
}
function downloadLink(name, data) {
  var gf = (data.fonts && data.fonts.sheets || []).some(function (h) { return h.indexOf('fonts.googleapis.com') >= 0 && h.indexOf(name.replace(/ /g, '+')) >= 0; });
  return gf ? 'https://fonts.google.com/specimen/' + name.replace(/ /g, '+') : 'https://www.google.com/search?q=' + encodeURIComponent('"' + name + '" font download');
}

// Elenca i font del sito che non sono installati, con la scelta salvata o un suggerimento.
async function scanFonts(data) {
  await initFonts();
  var saved = (await figma.clientStorage.getAsync('fontOverrides')) || {};
  var savedScale = (await figma.clientStorage.getAsync('fontScales')) || {};
  var savedWeight = (await figma.clientStorage.getAsync('fontWeights')) || {};
  var seen = {}, out = [], hasRaster = {}, sample = {};
  (function walk(d) {
    // riga di esempio per l'anteprima: una sola riga, un solo stile, dimensione leggibile, meglio se c'è l'immagine
    if (d.type === 'text' && !d.multi && d.segs.length === 1 && d.segs[0].s.ff[0] && d.text.length >= 3) {
      var st0 = d.segs[0].s, k0 = st0.ff[0].toLowerCase(), im = d.raster && data.images[d.raster.key];
      var score = Math.abs(st0.fs - 28) + (d.text.length > 30 ? 40 : 0) + (im ? 0 : 1000) + (d.fx ? 500 : 0);
      if (!sample[k0] || score < sample[k0].score) {
        sample[k0] = { score: score, text: d.text.slice(0, 40), fs: st0.fs, fw: st0.fw, it: st0.it, ls: st0.ls, tc: st0.tc, w: d.w, h: d.h,
          full: d.text.length <= 40, img: im ? im.data : null, m: d.raster ? d.raster.m : 0 };
      }
    }
    (d.segs || []).forEach(function (s) {
      var f = s.s.ff[0];
      if (f && d.raster) hasRaster[f.toLowerCase()] = true;
      if (!f || seen[f.toLowerCase()]) return;
      seen[f.toLowerCase()] = true;
      var k = f.toLowerCase(), base = k.replace(/[\s-_]*(variable|var|vf)$/, '');
      if (fontMap[k] || fontMap[base] || GENERIC[k]) return;
      var alias = (data.fontAliases || {})[f] || (data.fontAliases || {})[k];
      var sims = ((data.fontSimilar || {})[f] || []).concat(KIN[genreOf(s.s.ff)]).filter(function (x, i, a) { return fontMap[x.toLowerCase()] && a.indexOf(x) === i; }).slice(0, 5)
        .map(function (x) { return fontMap[x.toLowerCase()].family; });
      out.push({ name: f, saved: saved[k], alias: alias, guess: sims[0] || resolveFont({ ff: s.s.ff.slice(1), fw: 400, it: false }).family, similar: sims, measured: !!(data.fontSimilar || {})[f], link: downloadLink(f, data) });
    });
    (d.kids || []).forEach(walk);
  })(data.root);
  // la scelta predefinita: quella salvata, poi il font reale (fonts.sh), poi l'immagine dal sito, poi un ripiego
  out.forEach(function (o) {
    o.raster = !!hasRaster[o.name.toLowerCase()];
    o.sample = sample[o.name.toLowerCase()] || null;
    o.files = (data.fontFiles || []).filter(function (x) { return x.family.toLowerCase() === o.name.toLowerCase(); });
    o.scale = savedScale[o.name.toLowerCase()] || null;
    o.weight = savedWeight[o.name.toLowerCase()] || null;
    var saved = o.saved === RASTER && !o.raster ? null : o.saved;
    o.choice = saved || (o.alias && fontMap[o.alias.toLowerCase()] ? o.alias : null) || (o.raster ? RASTER : o.alias || o.guess);
    delete o.saved; delete o.alias; delete o.guess;
  });
  // pesi di ogni famiglia (senza corsivi) per la tendina del peso
  var styles = {};
  Object.keys(fontMap).forEach(function (k) {
    styles[fontMap[k].family] = fontMap[k].styles.filter(function (st) { return !/italic|oblique/i.test(st); })
      .map(function (st) { return [st, styleWeight(st)]; }).sort(function (a, b) { return a[1] - b[1]; });
  });
  return { missing: out, families: Object.keys(fontMap).map(function (k) { return fontMap[k].family; }).sort(), styles: styles };
}

function errText(e) { return e && e.message ? e.message + '\n' + (e.stack || '') : String(e); }

figma.ui.onmessage = async function (msg) {
  if (msg.type === 'scan') {
    try { figma.ui.postMessage({ type: 'fonts', fonts: await scanFonts(msg.data) }); }
    catch (e) { figma.ui.postMessage({ type: 'error', text: errText(e) }); }
    return;
  }
  if (msg.type === 'open') { figma.openExternal(msg.url); return; }
  if (msg.type !== 'import') return;
  try {
    if (msg.opts && msg.opts.fonts) {
      var saved = (await figma.clientStorage.getAsync('fontOverrides')) || {};
      await figma.clientStorage.setAsync('fontOverrides', Object.assign(saved, msg.opts.fonts));
      var savedS = (await figma.clientStorage.getAsync('fontScales')) || {};
      await figma.clientStorage.setAsync('fontScales', Object.assign(savedS, msg.opts.fontScale || {}));
      var savedW = (await figma.clientStorage.getAsync('fontWeights')) || {};
      await figma.clientStorage.setAsync('fontWeights', Object.assign(savedW, msg.opts.fontWeight || {}));
    }
    var r = await importCapture(msg.data, msg.opts || {});
    figma.ui.postMessage({ type: 'done', layers: r.layers, missing: r.missing, pinFailed: r.pinFailed, raster: r.raster, components: r.components, stickyLimited: r.stickyLimited, stickyAuto: r.stickyAuto, linked: r.linked, reused: r.reused, overridden: r.overridden, animated: r.animated, animErr: r.animErr, reactions: r.reactions, videos: r.videos, videoErr: r.videoErr });
  } catch (e) {
    figma.ui.postMessage({ type: 'error', text: errText(e) });
  }
};
