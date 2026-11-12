"""Scarica i font di una cattura Circles&Triangles, li converte in OTF/TTF e li installa in ~/Library/Fonts.

Uso: tools/fonts.sh cattura.json [--no-install]

Scrive anche in cattura.json "fontSimilar" (i 5 font installati più simili per misure) e la mappa "fontAliases" (nome CSS -> famiglia reale del file),
così il plugin usa subito il font giusto anche quando il sito lo chiama con un alias ("sans bold", "mono").
"""
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

from fontTools.ttLib import TTFont

FORMAT_PREF = ['.woff2', '.woff', '.otf', '.ttf']
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36'


def best_url(urls):
    def rank(u):
        path = u.split('?')[0].lower()
        return next((i for i, ext in enumerate(FORMAT_PREF) if path.endswith(ext)), len(FORMAT_PREF))
    return sorted((u for u in urls if not u.startswith('data:') or 'font' in u[:40]), key=rank)[0] if urls else None


def covers_latin(rng):
    """True se unicode-range è vuoto o include 'A' (U+0041)."""
    if not rng.strip():
        return True
    for part in rng.replace(' ', '').split(','):
        m = re.match(r'U\+([0-9A-F?]+)(?:-([0-9A-F]+))?', part, re.I)
        if not m:
            continue
        lo = int(m.group(1).replace('?', '0'), 16)
        hi = int(m.group(2) or m.group(1).replace('?', 'F'), 16)
        if lo <= 0x41 <= hi:
            return True
    return False


def name_of(font, *ids):
    for i in ids:
        rec = font['name'].getDebugName(i) if 'name' in font else None
        if rec and rec.strip():
            return rec.strip()
    return None


def fetch(url, referer):
    if url.startswith('data:'):
        import base64
        return base64.b64decode(url.split(',', 1)[1])
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': referer})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


LOCAL_DIRS = [Path('/System/Library/Fonts'), Path('/Library/Fonts'), Path.home() / 'Library' / 'Fonts']
LOWER = 'abcdefghijklmnopqrstuvwxyz'
PROFILE = LOWER + LOWER.upper()
# font di sistema per altri alfabeti (coreano, thai, indiani, CJK, arabo, ebraico): latino generico, suggerimenti inutili
OTHER_SCRIPTS = (0xAC00, 0x0E01, 0x0E81, 0x0905, 0x0A05, 0x0A85, 0x0B05, 0x0B85, 0x0C05, 0x0C85, 0x0D05, 0x0D85, 0x0985,
                 0x1000, 0x1780, 0x0F40, 0x1200, 0x0531, 0x10D0, 0x4E00, 0x0627, 0x05D0, 0x3042)


def features(font):
    """Misure per confrontare due font: proporzioni, larghezza, peso, grazie, mono, corsivo."""
    try:
        upm = font['head'].unitsPerEm
        os2 = font['OS/2'] if 'OS/2' in font else None
        cmap = font.getBestCmap() or {}
        hmtx = font['hmtx']
        gs = font.getGlyphSet()

        def height(ch):
            g = cmap.get(ord(ch))
            if not g or g not in gs:
                return 0
            from fontTools.pens.boundsPen import BoundsPen
            pen = BoundsPen(gs)
            gs[g].draw(pen)
            return (pen.bounds[3] if pen.bounds else 0) / upm

        xh = (getattr(os2, 'sxHeight', 0) or 0) / upm or height('x')
        ch = (getattr(os2, 'sCapHeight', 0) or 0) / upm or height('H')
        if any(cp in cmap for cp in OTHER_SCRIPTS) and not (0x141 in cmap and 0x151 in cmap):
            return None  # fatto per un altro alfabeto (niente latino esteso: Ł, ő)
        adv = [hmtx[cmap[ord(c)]][0] for c in LOWER if ord(c) in cmap]
        if len(adv) < 26 or not ch:
            return None
        prof = [hmtx[cmap[ord(c)]][0] / upm if ord(c) in cmap else 0 for c in PROFILE]
        pan = getattr(os2, 'panose', None)
        serif = None
        if pan and pan.bFamilyType == 2 and pan.bSerifStyle:
            serif = pan.bSerifStyle < 11
        mono = bool(font['post'].isFixedPitch) or (pan is not None and pan.bProportion == 9)
        italic = bool(font['post'].italicAngle) or bool(os2 and os2.fsSelection & 1)
        return {'prof': prof, 'xh': xh, 'ch': ch, 'w': sum(adv) / len(adv) / upm, 'wt': (os2.usWeightClass if os2 else 400) / 1000,
                'serif': serif, 'mono': mono, 'it': italic}
    except Exception:  # noqa: BLE001 — font locali strani: si ignorano
        return None


def distance(a, b):
    # profilo delle larghezze lettera per lettera, normalizzato: la "firma" del disegno
    ma, mb = sum(a['prof']) / len(a['prof']), sum(b['prof']) / len(b['prof'])
    d = sum(abs(x / ma - y / mb) for x, y in zip(a['prof'], b['prof'])) / len(a['prof']) * 12
    d += abs(a['xh'] / a['ch'] - b['xh'] / b['ch']) * 4 + abs(a['w'] - b['w']) * 6 + abs(a['wt'] - b['wt']) * 2
    d += 6 * (a['mono'] != b['mono']) + 2 * (a['it'] != b['it'])
    if a['serif'] is not None and b['serif'] is not None and a['serif'] != b['serif']:
        d += 2
    return d


def local_fonts():
    """[(famiglia, misure)] di ogni stile installato sul Mac."""
    from fontTools.ttLib import TTCollection
    out = []
    for d in LOCAL_DIRS:
        for f in d.rglob('*'):
            if f.suffix.lower() not in ('.ttf', '.otf', '.ttc', '.otc'):
                continue
            try:
                fonts = TTCollection(f, lazy=True).fonts if f.suffix.lower() in ('.ttc', '.otc') else [TTFont(f, lazy=True)]
            except Exception:  # noqa: BLE001
                continue
            for font in fonts:
                fam = name_of(font, 16, 1)
                ft = fam and not fam.startswith('.') and fam != 'System Font' and features(font)
                if ft:
                    out.append((fam, ft))
    return out


def similar(site, local, exclude, n=5):
    best = {}
    for fam, ft in local:
        if fam.lower() in exclude:
            continue
        dd = distance(site, ft)
        if fam not in best or dd < best[fam]:
            best[fam] = dd
    return sorted(best, key=best.get)[:n]


def safe(s):
    return re.sub(r'[^\w\- ]+', '', s).strip().replace(' ', '')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        sys.exit(__doc__)
    install = '--no-install' not in sys.argv
    path = Path(args[0])
    data = json.loads(path.read_text())
    faces = (data.get('fonts') or {}).get('faces') or []
    if not faces:
        sys.exit('Nessun @font-face nella cattura (rifai la cattura con l\'estensione aggiornata).')

    # un file per (famiglia, peso, stile): preferisce il subset che copre il latino
    chosen = {}
    for f in faces:
        key = (f['family'].lower(), str(f.get('weight', '400')), f.get('style', 'normal'))
        if key not in chosen or (covers_latin(f.get('range', '')) and not covers_latin(chosen[key].get('range', ''))):
            chosen[key] = f

    out_dir = path.with_name(path.stem + '-fonts')
    out_dir.mkdir(exist_ok=True)
    lib = Path.home() / 'Library' / 'Fonts'
    aliases = data.get('fontAliases') or {}
    done = {}
    site_ft = {}  # alias CSS -> (distanza da 400 normale, misure) del suo stile più "regular"
    for f in chosen.values():
        url = best_url(f['urls'])
        if not url:
            continue
        try:
            font = TTFont(io.BytesIO(fetch(url, data.get('url', ''))))
        except Exception as e:  # noqa: BLE001 — un font rotto non deve fermare gli altri
            print(f'  ✗ {f["family"]} ({url[:80]}): {e}')
            continue
        font.flavor = None  # woff/woff2 -> sfnt installabile
        ft = features(font)
        if ft:
            score = abs(int(re.sub(r'\D', '', str(f.get('weight', '400')).split()[0]) or 400) - 400) + (1000 if f.get('style', 'normal') != 'normal' else 0)
            if f['family'] not in site_ft or score < site_ft[f['family']][0]:
                site_ft[f['family']] = (score, ft)
        family = name_of(font, 16, 1) or f['family']
        style = name_of(font, 17, 2) or 'Regular'
        ext = '.otf' if ('CFF ' in font or 'CFF2' in font) else '.ttf'
        fname = f'{safe(family)}-{safe(style)}{ext}'
        if fname in done:
            aliases[f['family']] = family
            continue
        font.save(out_dir / fname)
        if install:
            font.save(lib / fname)
        done[fname] = True
        aliases[f['family']] = family
        print(f'  ✓ {f["family"]} → {family} {style}')

    data['fontAliases'] = aliases
    if site_ft:
        print('\nCerco i font installati più simili…')
        local = local_fonts()
        sims = data.get('fontSimilar') or {}
        for alias, (_, ft) in site_ft.items():
            sims[alias] = similar(ft, local, {alias.lower(), aliases.get(alias, '').lower()})
            print(f'  ≈ {alias}: {", ".join(sims[alias])}')
        data['fontSimilar'] = sims
    path.write_text(json.dumps(data))
    print(f'\n{len(done)} file salvati in {out_dir}' + (f' e installati in {lib}' if install else ''))
    print('Riavvia Figma (o riapri il file) perché veda i nuovi font, poi reimporta questo .json.')
    print('Nota: molte licenze webfont non permettono l\'uso desktop; verifica prima di usarli in progetti.')


if __name__ == '__main__':
    main()
