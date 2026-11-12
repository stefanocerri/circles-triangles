// Esegue code.js con un finto oggetto figma per trovare errori runtime e misurare l'auto layout.
import fs from 'fs';
const here = import.meta.dirname + "/";
const [codePath, jsonPath] = [process.env.CODE || here + "../figma-plugin/code.js", process.argv[2] || here + "fixture.json"];
let id = 0; const all = [];
function node(type) {
  const n = { type, id: ++id, children: [], x: 0, y: 0, width: 100, height: 100, layoutMode: 'NONE', parent: null, constraints: { horizontal: 'MIN', vertical: 'MIN' },
    appendChild(c) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = this; this.children.push(c); },
    insertChild(i, c) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = this; this.children.splice(i, 0, c); },
    resize(w, h) { if (!(w >= 0.01 && h >= 0.01)) throw new Error('bad resize ' + w + 'x' + h); this.width = w; this.height = h; },
    rescale() {},
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; this.removed = true; },
    pluginData: {}, getSharedPluginData(ns, k) { return this.pluginData[ns + ':' + k] || ''; }, setSharedPluginData(ns, k, v) { this.pluginData = { ...this.pluginData, [ns + ':' + k]: v }; },
    // come Figma: lo scroll behavior "Sticky" non si imposta dall'API, si legge solo dall'export REST e resta nei duplicati
    async exportAsync(o) { if (o.format !== 'JSON_REST_V1') throw new Error('export'); return { document: { scrollBehavior: this._sticky ? 'STICKY_SCROLLS' : 'SCROLLS' } }; },
    clone() { const c = node(this.type); Object.assign(c, { name: this.name, width: this.width, height: this.height, fills: this.fills, layoutMode: this.layoutMode, _sticky: this._sticky, pluginData: { ...this.pluginData } }); this.children.forEach((k) => c.appendChild(k.clone())); return c; },
    findAllWithCriteria(q) { const out = []; const walk = (n) => n.children.forEach((k) => { if ((!q.types || q.types.includes(k.type)) && (!q.sharedPluginData || q.sharedPluginData.keys.some((key) => k.getSharedPluginData(q.sharedPluginData.namespace, key)))) out.push(k); walk(k); }); walk(this); return out; },
    reactions: [],
    manualKeyframeTracks: {}, timelines: [],
    applyManualKeyframeTrack(f, t) { // come Figma Motion: niente tavole al primo livello, tempi crescenti, easing pubblici
      if (!this.parent || this.parent.type === 'PAGE') throw new Error('keyframe su nodo al primo livello');
      const E = ['EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'LINEAR', 'CUSTOM_CUBIC_BEZIER', 'HOLD'];
      t.keyframes.forEach((k, i) => {
        if (!Number.isFinite(k.value.value) || k.value.type !== 'FLOAT') throw new Error('keyframe valore ' + JSON.stringify(k.value));
        if (i && !(k.timelinePosition > t.keyframes[i - 1].timelinePosition)) throw new Error('keyframe tempi non crescenti');
        if (k.easing && (!E.includes(k.easing.type) || (k.easing.type === 'CUSTOM_CUBIC_BEZIER') !== !!k.easing.easingFunctionCubicBezier)) throw new Error('easing ' + JSON.stringify(k.easing));
      });
      this.manualKeyframeTracks = { ...this.manualKeyframeTracks, [f.name]: t };
      if (!this.timelines.length) this.timelines = [{ id: this.id, duration: 2 }];
    },
    setTimelineDuration(tid, d) { if (!(d > 0)) throw new Error('durata'); this.timelines = [{ id: tid, duration: d }]; },
    async setReactionsAsync(r) { for (const x of r) { const a = x.actions[0]; if (!x.trigger || !a.destinationId) throw new Error('bad reaction'); if (a.navigation === 'SCROLL_TO' && a.transition) throw new Error('SCROLL_TO con transizione: nel prototipo vero non scorre (SMART_ANIMATE rifiutato, SCROLL_ANIMATE inerte)'); if (x.trigger.type === 'AFTER_TIMEOUT' && !(x.trigger.timeout > 0)) throw new Error('timeout'); } this.reactions = r; }, // come Figma: lo scroll-to funziona solo istantaneo
    createInstance() {
      if (this.type !== 'COMPONENT') throw new Error('createInstance on ' + this.type);
      const clone = (m, type) => { const c = node(type || m.type); Object.assign(c, { name: m.name, width: m.width, height: m.height, fills: m.fills }); if (m.type === 'TEXT') Object.assign(c, { characters: m.characters, fontName: m.fontName, getRangeAllFontNames: () => [{ family: 'Inter', style: 'Regular' }] }); m.children.forEach((k) => c.appendChild(clone(k))); return c; };
      const inst = clone(this, 'INSTANCE'); inst.mainComponent = this; if (this.parent && this.parent.type === 'COMPONENT_SET') inst.name = this.parent.name; return inst; // come Figma: l'istanza prende il nome del set
    },
  };
  for (const m of ['setRangeFontName','setRangeFontSize','setRangeFills','setRangeLineHeight','setRangeLetterSpacing','setRangeTextDecoration','setRangeTextCase','setRangeHyperlink'])
    n[m] = (b, e, v) => { if (!(b >= 0 && e <= n.characters.length && b < e)) throw new Error(`${m} bad range ${b}-${e} of ${n.characters.length}`); if (m === 'setRangeFontName') n._font = v; };
  const guard = (k, check) => { let v; Object.defineProperty(n, k, { get: () => v, set: (x) => { check(x); v = x; } }); };
  for (const k of ['paddingTop','paddingRight','paddingBottom','paddingLeft']) guard(k, (x) => { if (!(x >= 0)) throw new Error(k + ' ' + x); });
  guard('layoutPositioning', (x) => { if (x === 'ABSOLUTE' && n.parent.layoutMode === 'NONE') throw new Error('abs in non-AL'); });
  guard('layoutAlign', () => { if (n.parent.layoutMode === 'NONE') throw new Error('layoutAlign in non-AL'); });
  guard('characters', (x) => { if (typeof x !== 'string') throw new Error('chars'); });
  Object.defineProperty(n, 'absoluteTransform', { get() { let x = 0, y = 0; for (let a = this; a && a.type !== 'PAGE'; a = a.parent) { x += a.x; y += a.y; } return [[1, 0, x], [0, 1, y]]; } });
  all.push(n); return n;
}
const msgs = [];
globalThis.__html__ = '';
globalThis.figma = {
  showUI() {}, ui: { postMessage: (m) => msgs.push(m), onmessage: null },
  createFrame: () => node('FRAME'),
  // come Figma: il nodo diventa il componente (i figli passano al componente)
  createComponentFromNode: (n) => { const c = node('COMPONENT'); c.width = n.width; c.height = n.height; c.name = n.name; c.fills = n.fills; const p = n.parent; p.insertChild(p.children.indexOf(n), c); [...n.children].forEach((k) => c.appendChild(k)); n.remove(); return c; },
  combineAsVariants: (comps, parent) => { if (comps.length < 1 || comps.some((c) => c.type !== 'COMPONENT')) throw new Error('combine'); const s = node('COMPONENT_SET'); parent.appendChild(s); comps.forEach((c) => s.appendChild(c)); s.defaultVariant = comps[0]; return s; }, createRectangle: () => node('RECTANGLE'), createText: () => node('TEXT'), createNodeFromSvg: (s) => { if (!s.startsWith('<svg')) throw new Error('svg'); return node('FRAME'); },
  listAvailableFontsAsync: async () => ['Inter','Roboto','Roboto Mono','Noto Serif'].flatMap(f => ['Regular','Medium','Semi Bold','Bold','Italic','Bold Italic','Light'].map(s => ({ fontName: { family: f, style: s } }))),
  loadFontAsync: async () => {}, createVideoAsync: async (b) => ({ hash: 'v' + b.length }), clientStorage: { _s: {}, async getAsync(k) { return this._s[k]; }, async setAsync(k, v) { this._s[k] = v; } }, createImage: (b) => ({ hash: 'h' + b.length }), base64Decode: (s) => Buffer.from(s, 'base64'),
  viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() {} }, currentPage: node('PAGE'), root: node('DOCUMENT'),
  getNodeByIdAsync: async (i) => all.find((n) => String(n.id) === String(i)) || null,
};
const source = fs.readFileSync(codePath, 'utf8');
// Figma (sandbox SES) rifiuta il plugin se vede "import" seguito da ( oppure da un commento, anche dentro un commento:
// "SyntaxError: possible import expression rejected"
const sesImport = source.match(/(^|[^.$\w])import\s*(\(|\/[\/*])/);
if (sesImport) { console.log('ERRORE: Figma rifiuterebbe il plugin (possible import expression) vicino a:', JSON.stringify(source.slice(sesImport.index, sesImport.index + 60))); process.exit(1); }
eval(source);
const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
for (const k in data.images) data.images[k] = data.images[k] || { data: 'AAAA' };
for (const k in data.videos || {}) data.videos[k] = data.videos[k] || { data: 'AAAA' };
await figma.ui.onmessage({ type: 'scan', data });
const scan = msgs.pop();
if (process.env.DUMP_SCAN) fs.writeFileSync(process.env.DUMP_SCAN, JSON.stringify(scan));
if (scan.type !== 'fonts') throw new Error('scan failed: ' + JSON.stringify(scan).slice(0, 300));
console.log('missing fonts:', scan.fonts.missing.map((f) => f.name + '→' + f.choice + (f.raster ? '(img ok)' : '') + ' [' + f.similar.join('/') + ']').join(', ') || 'none');
await figma.ui.onmessage({ type: 'import', data, opts: { rasterFx: !process.env.NORASTER, fonts: Object.fromEntries(scan.fonts.missing.map((f) => [f.name.toLowerCase(), process.env.NORASTER ? 'Inter' : f.choice])) } });
const last = msgs[msgs.length - 1];
console.log(last.type, last.text ? last.text.slice(0, 800) : '', last.layers || '', last.missing || '');
if (process.env.DUMP) { // DUMP=nome: albero del primo livello con quel nome
  const tree = (n, i, d) => { console.log(' '.repeat(i) + `${n.type} ${n.name} ${Math.round(n.x)},${Math.round(n.y)} ${Math.round(n.width)}x${Math.round(n.height)} lm=${n.layoutMode || '-'} lp=${n.layoutPositioning || '-'} vis=${n.visible !== false}${n.mainComponent ? ' inst→' + n.mainComponent.name : ''}`); if (d) (n.children || []).forEach((k) => tree(k, i + 2, d - 1)); };
  const t = all.find((n) => n.name === process.env.DUMP && !n.removed);
  if (t) tree(t, 0, +(process.env.DEPTH || 3));
}
const frames = all.filter(n => n.type === 'FRAME' && n.children.length);
const al = frames.filter(n => n.layoutMode !== 'NONE');
console.log('components', last.components, 'riusati', last.reused, 'override', last.overridden, 'reactions', last.reactions, 'fixed', all.reduce((a, n) => a + (n.numberOfFixedChildren || 0), 0), 'raster', last.raster, 'rotated', all.filter((n) => n.relativeTransform).length);
console.log('frames with kids', frames.length, 'autolayout', al.length, `(${Math.round(al.length / frames.length * 100)}%)`, 'texts', all.filter(n => n.type === 'TEXT').length);
// Figma riempie da solo le righe dei frame WRAP: se le righe che ne escono non sono quelle del sito, gli elementi si spostano
let wrapBad = 0;
for (const f of all.filter((n) => n.layoutWrap === 'WRAP')) {
  const kids = f.children.filter((k) => k.layoutPositioning !== 'ABSOLUTE');
  const avail = f.width - (f.paddingLeft || 0) - (f.paddingRight || 0);
  let x = 0, row = 0, prevY = null, siteRow = 0;
  for (const k of kids) {
    if (prevY !== null && Math.abs(k.y - prevY) > 2) siteRow++;
    prevY = k.y;
    if (x > 0 && x + (f.itemSpacing || 0) + k.width > avail + 2) { row++; x = 0; }
    x += (x > 0 ? f.itemSpacing || 0 : 0) + k.width;
    if (row !== siteRow) { wrapBad++; console.log('WRAP diverso da Figma in', f.name, '→', k.name); break; }
  }
}
console.log('wrap che Figma ricompone diversamente:', wrapBad);
// ogni istanza di un componente Card condiviso deve ricevere i suoi contenuti (override), tranne quella da cui nasce il componente
const inInstance = (n) => { for (let a = n.parent; a; a = a.parent) if (a.type === 'INSTANCE') return true; return false; };
const cardInst = all.filter((n) => n.type === 'INSTANCE' && n.mainComponent && n.mainComponent.parent && /^Card/.test(n.mainComponent.parent.name) && !inInstance(n)).length;
const cardSets = all.filter((n) => n.type === 'COMPONENT_SET' && /^Card/.test(n.name)).length;
const overBad = last.overridden !== undefined && last.overridden < cardInst - cardSets; // solo l'istanza da cui nasce il componente non ha override
if (cardInst) console.log('istanze Card', cardInst, 'override', last.overridden);
if (overBad) console.log('ATTENZIONE: istanze Card senza i propri contenuti');
const animIn = (n) => (n.anim ? 1 : 0) + (n.kids || []).reduce((a, k) => a + animIn(k), 0);
const animBad = !!data.root && animIn(data.root) > 0 && !last.animated;
if (last.animated || animBad) console.log('animazioni continue', last.animated, last.animErr || '', all.filter((n) => Object.keys(n.manualKeyframeTracks || {}).length).map((n) => n.name + ':' + Object.keys(n.manualKeyframeTracks).join('/') + ' ' + n.timelines[0].duration + 's').slice(0, 4).join(' | '));
// fixed in basso: in fondo alla tavola con vincolo Bottom
{
  const bar = all.find((n) => n.name === 'barra in basso');
  if (bar) {
    const pg = bar.parent, ok = pg && Math.abs(bar.y + bar.height - pg.height) < 1 && bar.constraints && bar.constraints.vertical === 'MAX';
    console.log('fixed in basso', ok ? 'ok' : `ERRORE y=${bar.y} h=${bar.height} tavola=${pg && pg.height} vincolo=${bar.constraints && bar.constraints.vertical}`);
    if (!ok) process.exitCode = 1;
  }
}
// distanze diverse in verticale: auto layout con spazi trasparenti, la pila cresce col contenuto
{
  const pila = all.find((n) => n.name === 'pila');
  if (pila) {
    const sp = pila.children.filter((n) => n.name === 'spazio').map((n) => n.height);
    const ok = pila.layoutMode === 'VERTICAL' && sp.join() === '10,30' && pila.primaryAxisSizingMode === 'AUTO';
    console.log('distanze diverse', ok ? 'ok' : `ERRORE ${pila.layoutMode} spazi=${sp} altezza=${pila.primaryAxisSizingMode}`);
    if (!ok) process.exitCode = 1;
  }
}
// sul sito lo sticky sta sopra al contenuto: in Figma dev'essere l'ultimo livello del suo genitore (prima dei fixed)
let stickyBad = all.filter((n) => /\(sticky/.test(n.name || '') && n.parent && !n.removed).some((n) => { const P = n.parent, i = P.children.indexOf(n), last = P.children.length - 1 - (P.numberOfFixedChildren || 0); if (i < last) console.log('STICKY SOTTO ALTRI LIVELLI', n.name, i, '/', last); return i < last; });
// nel prototipo uno sticky in posizione assoluta dentro un auto layout non si attacca
if (all.some((n) => /\(sticky fino a/.test(n.name || '') && !n.removed && n.parent && n.parent.layoutMode !== 'NONE' && (console.log('STICKY ASSOLUTO IN AUTO LAYOUT', n.name, '→', n.parent.name), true))) stickyBad = true;
if (last.stickyLimited) { // come l'utente: imposta Sticky sui livelli selezionati, poi reimporta: ora il plugin li fa da solo
  figma.currentPage.selection.forEach((n) => { n._sticky = true; });
  await figma.ui.onmessage({ type: 'import', data: JSON.parse(fs.readFileSync(jsonPath, 'utf8')), opts: { rasterFx: false, fonts: {} } });
  const again = msgs[msgs.length - 1];
  const wrapped = all.filter((n) => n._sticky && !n.removed && n.visible !== false && n.parent && n.parent.type !== 'PAGE' && n.children.length === 1);
  stickyBad = stickyBad || again.stickyAuto !== last.stickyLimited || again.stickyLimited || wrapped.length < last.stickyLimited;
  console.log('sticky: primo import', last.stickyLimited, 'da impostare · secondo import', again.stickyAuto, 'automatici', again.stickyLimited || 0, 'da impostare', stickyBad ? 'ERRORE' : 'ok');
}
// peso scelto per il font sostituto: la riga d'esempio (400) prende lo stile scelto, gli altri pesi si spostano uguale
{
  const t = (name, fw) => ({ type: 'text', name, x: 0, y: fw / 10, w: 100, h: 20, text: 'Prova', segs: [{ b: 0, e: 5, s: { ff: ['Sito Sans'], fw, it: false, fs: 16, c: { r: 0, g: 0, b: 0, a: 1 } } }], align: 'LEFT', multi: false, abs: false, z: 0 });
  const d = { version: 1, w: 400, h: 200, root: { type: 'frame', name: 'body', x: 0, y: 0, w: 400, h: 200, fills: [], pad: [0, 0, 0, 0], kids: [t('peso 400', 400), t('peso 700', 700)] }, images: {} };
  await figma.ui.onmessage({ type: 'scan', data: d });
  const sc = msgs[msgs.length - 1];
  await figma.ui.onmessage({ type: 'import', data: d, opts: { rasterFx: false, fonts: { 'sito sans': 'Roboto' }, fontWeight: { 'sito sans': { family: 'Roboto', style: 'Medium', fw: 400 } } } });
  const st = (n) => { const x = all.filter((k) => k.name === n && !k.removed).pop(); return x && x._font && x._font.family + ' ' + x._font.style; };
  const ok = st('peso 400') === 'Roboto Medium' && st('peso 700') === 'Roboto Bold' && sc.fonts && sc.fonts.styles && sc.fonts.styles.Roboto.length === 5;
  console.log('peso del sostituto', ok ? 'ok' : `ERRORE ${st('peso 400')} | ${st('peso 700')} | stili ${sc.fonts && sc.fonts.styles && JSON.stringify(sc.fonts.styles.Roboto)}`);
  if (!ok) process.exitCode = 1;
}
if (last.type !== 'done' || wrapBad || overBad || animBad || stickyBad) process.exit(1);
if (process.env.SHOW) {
  const page = figma.currentPage.children[0];
  console.log('page children:', page.children.map((c) => `${c.name} @${Math.round(c.x)},${Math.round(c.y)} ${Math.round(c.width)}x${Math.round(c.height)} op=${c.opacity ?? 1} lp=${c.layoutPositioning ?? '-'} kids=${c.children.length}`).join('\n  '), '\nfixed:', page.numberOfFixedChildren);
}
{ // testi di una riga che in Figma potrebbero andare a capo con un font più largo
  const risky = all.filter((n) => n.type === 'TEXT' && n.visible !== false && !/\n/.test(n.characters) && n.textAutoResize !== 'WIDTH_AND_HEIGHT' && n.layoutAlign !== undefined && (n.layoutAlign === 'STRETCH' || n.layoutGrow === 1));
  const fixedW = all.filter((n) => n.type === 'TEXT' && n.visible !== false && !/\n/.test(n.characters) && n.textAutoResize === 'HEIGHT');
  console.log('una riga a larghezza fissa', fixedW.length, '· stretch/grow', risky.length, fixedW.slice(0, 6).map((n) => n.characters.slice(0, 20)).join(' | '));
}
if (process.env.SHOW) {
  const byId = Object.fromEntries(all.map((n) => [n.id, n]));
  for (const set of all.filter((n) => n.type === 'COMPONENT_SET')) {
    console.log('SET', set.name);
    for (const v of set.children) {
      const rs = [];
      (function w(n) { (n.reactions || []).forEach((r) => rs.push(`${n === v ? '[root]' : n.name}:${r.trigger.type}→${byId[r.actions[0].destinationId].name}`)); n.children.forEach(w); })(v);
      console.log('   ', v.name, '|', rs.join('  '));
    }
  }
}
if (process.env.SHOW) for (const set of all.filter((n) => n.type === 'COMPONENT_SET')) {
  let inst = 0; (function w(n) { if (n.type === 'INSTANCE') inst++; n.children.forEach(w); })(set);
  if (inst) console.log('istanze annidate in', set.name, inst);
}
if (process.env.SHOW) all.filter((n) => / \(sticky fino a /.test(n.name || '')).forEach((n) => console.log('STICKY LIMITATO:', n.name));
