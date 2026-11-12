const $ = (s) => document.querySelector(s);
const status = (t) => { $('#status').textContent = t; };

const toB64 = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(',')[1]);
  fr.onerror = rej;
  fr.readAsDataURL(blob);
});

async function rasterize(source, w, h, type) {
  const scale = Math.min(1, 4096 / Math.max(w, h)); // limite Figma
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return toB64(await new Promise((r) => c.toBlob(r, type)));
}

// Scarica un'immagine (l'estensione ha host_permissions, quindi niente CORS) e la porta in PNG/JPEG/GIF.
async function loadImage(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(res.status);
  const blob = await res.blob();
  if (blob.type.includes('svg') || /\.svg(\?|#|$)/i.test(url)) {
    const text = await blob.text();
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    const w = parseFloat(svg.getAttribute('width')) || 0, h = parseFloat(svg.getAttribute('height')) || 0;
    if (!svg.getAttribute('viewBox') && w && h) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const vb = (svg.getAttribute('viewBox') || '0 0 300 150').split(/[\s,]+/).map(Number);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    const img = new Image();
    const blobUrl = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    img.src = blobUrl;
    await img.decode();
    const data = await rasterize(img, vb[2] * 2, vb[3] * 2, 'image/png');
    URL.revokeObjectURL(blobUrl);
    return { svg: new XMLSerializer().serializeToString(svg), data };
  }
  const bmp = await createImageBitmap(blob);
  if (/image\/(png|jpeg|gif)/.test(blob.type) && Math.max(bmp.width, bmp.height) <= 4096) return { data: await toB64(blob) };
  return { data: await rasterize(bmp, bmp.width, bmp.height, blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png') };
}

// Fogli CSS cross-origin (Google Fonts, Typekit…): non leggibili dalla pagina, li scarica l'estensione.
async function addCrossOriginFonts(result) {
  for (const href of result.fonts.sheets) {
    try {
      const css = await (await fetch(href)).text();
      for (const block of css.match(/@font-face\s*{[^}]*}/g) || []) {
        const prop = (k) => (block.match(new RegExp(k + '\\s*:\\s*([^;}]+)')) || [])[1];
        const urls = (prop('src') || '').match(/url\(["']?[^"')]+["']?\)/g) || [];
        if (!urls.length) continue;
        result.fonts.faces.push({
          family: (prop('font-family') || '').replace(/["']/g, '').trim(),
          weight: (prop('font-weight') || '400').trim(), style: (prop('font-style') || 'normal').trim(), range: (prop('unicode-range') || '').trim(),
          urls: urls.map((u) => new URL(u.replace(/^url\(["']?|["']?\)$/g, ''), href).href),
        });
      }
    } catch (e) { /* foglio irraggiungibile */ }
  }
}

// Testi con webfont o effetti che Figma non sa rifare (fx) -> anche come immagine (screenshot ritagliato), per chi in Figma non ha quel font.
// ponytail: testi più alti del viewport restano solo testo; cucire più screenshot se servirà.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function rasterTexts(result, tab, target) {
  const fams = new Set(result.fonts.faces.map((f) => f.family.toLowerCase()));
  const texts = [];
  (function walk(n) {
    if (n.type === 'text' && !n.rot && n.w > 0 && n.h > 0 && (n.fx || n.segs.some((g) => g.s.ff[0] && fams.has(g.s.ff[0].toLowerCase())))) texts.push(n);
    (n.kids || []).forEach(walk);
  })(result.root);
  if (!texts.length) return 0;
  const M = 3; // margine orizzontale per corsivi che escono dal box (in verticale toccherebbe le righe vicine)
  const exec = async (func, args) => (await chrome.scripting.executeScript({ target, func, args }))[0].result;
  let todo = texts.slice().sort((a, b) => a.y - b.y), shots = 0, last = 0, done = 0;
  while (todo.length) {
    const v = await exec((y, hide) => window.__h2fShot(y, hide), [shots ? Math.max(0, todo[0].y - 20) : 0, shots > 0]);
    await wait(Math.max(150, 550 - (Date.now() - last))); // Chrome: max 2 captureVisibleTab al secondo
    last = Date.now();
    const bmp = await createImageBitmap(await (await fetch(await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }))).blob());
    const k = bmp.width / v.vw;
    const rest = [];
    for (const n of todo) {
      const x = n.x - v.sx - M, y = n.y - v.sy, w = n.w + 2 * M, h = n.h;
      if (y < 0 || y + h > v.vh || x + w < 0 || x > v.vw) { rest.push(n); continue; }
      const c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(bmp, x * k, y * k, w * k, h * k, 0, 0, c.width, c.height);
      const key = 'raster:' + done++;
      result.images[key] = { data: await toB64(await new Promise((r) => c.toBlob(r, 'image/png'))) };
      n.raster = { key, m: M };
    }
    // niente progressi (testo più alto dello schermo o fuori pagina): lo salta
    if (rest.length === todo.length) rest.shift();
    todo = rest;
    shots++;
    status(`Testi come immagine ${done}/${texts.length}`);
  }
  return done;
}

// File dei font del sito (uno per famiglia/peso/stile, sottoinsieme latino), per mostrarli nell'anteprima del plugin.
function coversLatin(range) {
  if (!range.trim()) return true;
  return (range.match(/U\+[0-9A-F?]+(-[0-9A-F]+)?/gi) || []).some((p) => {
    const [a, b] = p.slice(2).split('-');
    return parseInt(a.replace(/\?/g, '0'), 16) <= 0x41 && 0x41 <= parseInt(b || a.replace(/\?/g, 'F'), 16);
  });
}
async function addFontFiles(result) {
  const pick = {};
  for (const f of result.fonts.faces) {
    const k = [f.family.toLowerCase(), f.weight, f.style].join('|');
    if (!pick[k] || (coversLatin(f.range) && !coversLatin(pick[k].range))) pick[k] = f;
  }
  result.fontFiles = [];
  let total = 0;
  for (const f of Object.values(pick).slice(0, 24)) { // ponytail: tetto fisso, basta per l'anteprima
    const url = f.urls.find((u) => /\.woff2(\?|$)/i.test(u)) || f.urls[0];
    try {
      const blob = await (await fetch(url)).blob();
      if (blob.size > 1.5e6 || (total += blob.size) > 6e6) continue;
      result.fontFiles.push({ family: f.family, weight: f.weight, style: f.style, data: await toB64(blob) });
    } catch (e) { /* file irraggiungibile: l'anteprima userà solo l'immagine */ }
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// Larghezza della pagina catturata: ridimensiona la finestra perché la pagina sia larga esattamente così, poi la ripristina.
async function setViewport(tab, width) {
  const win = await chrome.windows.get(tab.windowId);
  const [{ result: inner }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => innerWidth });
  const prev = { width: win.width, state: win.state };
  await chrome.windows.update(win.id, { state: 'normal' });
  await chrome.windows.update(win.id, { width: Math.round(win.width - inner + width) });
  await wait(1200); // il sito ricalcola il layout responsive
  return async () => { await chrome.windows.update(win.id, prev.state === 'normal' ? { width: prev.width } : { state: prev.state }); };
}

// Avviso visibile anche a popup chiuso: badge sull'icona + messaggio dentro la pagina
function badge(tabId, text, color) {
  try { chrome.action.setBadgeText({ tabId, text }); chrome.action.setBadgeBackgroundColor({ tabId, color }); if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ tabId, color: color === '#fff' ? '#000' : '#fff' }); } catch (e) { /* */ }
}
function toast(tabId, msg, ok) {
  chrome.scripting.executeScript({ target: { tabId }, args: [msg, ok], func: (m, good) => {
    const t = document.createElement('div');
    t.textContent = 'Circles&Triangles · ' + m;
    t.style.cssText = 'position:fixed;z-index:2147483647;right:20px;bottom:20px;padding:12px 16px;border-radius:8px;font:600 14px Inter,system-ui,sans-serif;color:#fff;background:#000;box-shadow:0 4px 16px rgba(0,0,0,.35);border:1px solid ' + (good ? '#fff' : '#ff6b6b');
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  } }).catch(() => {});
}

async function run(mode) {
  // Firefox: i permessi host in MV3 vanno concessi dall'utente (serve il click, quindi prima di ogni await)
  const granted = chrome.permissions.request({ origins: ['<all_urls>'] });
  let tabRef = null;
  document.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    if (!(await granted)) throw new Error('serve il permesso di accesso ai siti per scaricare immagini e font');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const target = { tabId: tab.id };
    tabRef = tab.id;
    badge(tab.id, '…', '#fff');
    const vw = +$('#vw').value;
    let restoreWin = null;
    if (vw) { status('Imposto la larghezza ' + vw + 'px…'); try { restoreWin = await setViewport(tab, vw); } catch (e) { /* finestra non ridimensionabile: resta com'è */ } }
    try {
    await chrome.scripting.executeScript({ target, files: ['capture.js'] });
    // si parte sempre da cima: da metà pagina header, sticky e reveal vengono letti male
    await chrome.scripting.executeScript({ target, func: async () => { scrollTo({ top: 0, left: 0, behavior: 'instant' }); window.__h2fScrollTo(0); await new Promise((r) => setTimeout(r, 400)); } });
    if ($('#scroll').checked) { status('Scorro la pagina…'); await chrome.scripting.executeScript({ target, func: () => window.__h2fScroll() }); }
    status('Leggo il DOM…');
    const raster = $('#raster').checked, opt = { carousel: $('#carousel').checked, hover: $('#hover').checked, anim: $('#anim').checked };
    const inter = opt.carousel || opt.hover;
    const [{ result }] = await chrome.scripting.executeScript({ target, func: (k, o) => window.__h2f(k, o), args: [raster || inter, opt] });
    if (opt.carousel) {
      status('Catturo i caroselli…');
      try {
        const [{ result: ia }] = await chrome.scripting.executeScript({ target, func: () => window.__h2fInteractive() });
        Object.assign(result.interactive, ia.groups);
        for (const k in ia.images) if (!(k in result.images)) result.images[k] = null;
        for (const k in ia.videos) if (!(k in result.videos)) result.videos[k] = null;
      } catch (e) { /* interazioni facoltative */ }
    }
    await addCrossOriginFonts(result);
    status('Scarico i font del sito…');
    await addFontFiles(result);
    if (raster || inter) {
      try { if (raster) await rasterTexts(result, tab, target); } finally { await chrome.scripting.executeScript({ target, func: () => window.__h2fRestore() }); }
    }
    const urls = Object.keys(result.images).filter((u) => !u.startsWith('raster:')); // i ritagli dei testi sono già pronti
    let done = 0, failed = 0;
    await pool(urls, 8, async (u) => {
      try { result.images[u] = await loadImage(u); } catch (e) { failed++; delete result.images[u]; }
      status(`Immagini ${++done}/${urls.length}${failed ? ` (${failed} fallite)` : ''}`);
    });
    result.videoErrors = [];
    for (const u of Object.keys(result.videos || {})) {
      status('Scarico video…');
      try {
        const res = await fetch(u, { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        if (blob.size > 100e6) throw new Error('più di 100MB'); // limite Figma
        result.videos[u] = { data: await toB64(blob) };
      } catch (e) { delete result.videos[u]; result.videoErrors.push(u.split('/').pop().slice(0, 40) + ': ' + (e.message || e)); }
    }
    const json = JSON.stringify(result);
    const mb = (json.length / 1e6).toFixed(1);
    if (mode === 'copy') {
      await navigator.clipboard.writeText(json);
      status(`Copiato (${mb} MB). Apri il plugin in Figma e premi ⌘V.`);
      badge(tab.id, '✓', '#14a44d'); toast(tab.id, `cattura copiata (${mb} MB): incollala nel plugin Figma`, true);
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = `h2f-${new URL(result.url).hostname}-${result.w}px.json`;
      a.click();
      status(`Scaricato (${mb} MB). Trascinalo nel plugin in Figma.`);
      badge(tab.id, '✓', '#14a44d'); toast(tab.id, `cattura scaricata (${mb} MB): trascinala nel plugin Figma`, true);
    }
    } finally { if (restoreWin) await restoreWin(); } // finestra di nuovo com'era
  } catch (e) {
    status('Errore: ' + (e.message || e));
    if (tabRef) { badge(tabRef, '!', '#d33'); toast(tabRef, 'errore: ' + (e.message || e), false); }
  } finally {
    document.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
}

$('#copy').onclick = () => run('copy');
$('#download').onclick = () => run('download');
