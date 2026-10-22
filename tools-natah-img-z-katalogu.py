#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Ilustrace natahování pro modul Konstrukce — JEN z katalogu ABROLL.

Vytáhne obrázky typů natahování ze stran „TYP NATAHOVÁNÍ" katalogu (PDF),
spáruje je s popisky podle polohy na stránce (popisek stojí vpravo od obrázku
ve stejné výšce) a zapíše:
  konstrukce/natah-img/<NÁZEV>.jpg   – obrázek z PDF beze změny (původní JPEG)
  konstrukce/natah-img/map.json      – kód natahování → soubor

Použití:  python3 tools-natah-img-z-katalogu.py "/cesta/KATALOG ABROLL 16092025.pdf"
Potřebuje PyMuPDF (pip install pymupdf).
"""
import json, os, re, sys
import fitz  # PyMuPDF

PDF = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/Desktop/KATALOG ABROLL 16092025.pdf')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'konstrukce', 'natah-img')

# Popisek v katalogu (první řádek stačí) → (název souboru, kódy z číselníku abr-kody.json, poznámka)
# Kódy jsou přesně ty, které popisek uvádí. Dvě odvozeniny jsou označené v poznámce.
POPISKY = [
    ('NA1570/50',  'NA1570.jpg',   ['NA1570/50', 'NA1570/60'], ''),
    ('NH1570/50',  'NH1570.jpg',   ['NH1570/50', 'NH1570/60'], ''),
    ('NS1570/50',  'NS1570.jpg',   ['NS1570/50', 'NS1570/60'], ''),
    ('NA1425/50 pro AFS', 'NA1425-AFS.jpg', ['NA1425/50', 'NA1450/50'], ''),
    ('NAT1570/50', 'NAT1570.jpg',  ['NAT1570/50', 'NAT1570/60'], ''),
    ('NHT1570/50', 'NHT1570.jpg',  ['NHT1570/50', 'NHT1570/60'], ''),
    ('NTA1250/50 pro AFS', 'NTA-AFS.jpg', ['NTA1425/50'],
        'katalog píše NTA1250/50, číselník zná jen NTA1425/50 (jediný tvar TA) — přiřazeno jako týž typ'),
    ('NHF1425/50 pro AFS', 'NHF-AFS.jpg', ['NHF1425/50', 'NHF1450/50', 'NHF1425/60', 'NHF1450/60'],
        'katalog uvádí jen /50; varianty /60 (průměr háku) dostávají týž obrázek stejně jako u NA/NH/NS na str. 5'),
    ('NHNL1450/50', 'NHNL1450.jpg', ['NHNL1450/50'], ''),
    ('NT1425/50 pro AFS', 'NT-AFS.jpg', ['NT1425/50', 'NT1450/50'], ''),
    ('NR',          'NR.jpg',       ['NR'], ''),
    ('NL',          'NL.jpg',       ['NL'], ''),
]

doc = fitz.open(PDF)
strany = [i for i, p in enumerate(doc) if 'TYP NATAHOV' in p.get_text()]
if not strany:
    sys.exit('V PDF není žádná strana „TYP NATAHOVÁNÍ".')
os.makedirs(OUT, exist_ok=True)

def prvni_radek(t):
    # první popisek bloku: „• NA1570/50 • NA1570/60" → „NA1570/50" (odrážka může být i jiný znak než •)
    m = re.search(r'([A-Z]{2,4}\d{4}/\d{2}(?: pro AFS)?|\bN[RL]\b)', t)
    return m.group(1) if m else ''

mapa, zdroj, hotovo, pouzite = {}, [], set(), {}
for pi in strany:
    p = doc[pi]
    bloky = [(fitz.Rect(b[:4]), b[4]) for b in p.get_text('blocks')]
    obrazky = p.get_image_info(xrefs=True)
    for r, txt in bloky:
        klic = prvni_radek(txt)
        z = next((x for x in POPISKY if x[0] == klic), None)
        if not z:
            continue
        # obrázek vlevo od popisku, který výškově zasahuje do řádku popisku
        # (popisek se může o pár bodů překrývat s pravým okrajem obrázku, proto levý okraj obrázku < začátek popisku)
        kand = [o for o in obrazky if o['bbox'][0] < r.x0 and o['bbox'][1] <= r.y1 and o['bbox'][3] >= r.y0]
        if not kand:
            sys.exit('K popisku „%s" (str. %d) nenalezen obrázek.' % (klic, pi + 1))
        # popisek stojí u HORNÍHO okraje svého obrázku; sousední obrázek nad ním se s ním může o pár bodů
        # překrývat → rozhoduje největší svislý překryv, až pak vodorovná blízkost
        def skore(o):
            prekryv = min(r.y1, o['bbox'][3]) - max(r.y0, o['bbox'][1])
            return (-prekryv, abs(r.x0 - o['bbox'][2]))
        o = min(kand, key=skore)
        if o['xref'] in pouzite:
            sys.exit('Obrázek (xref %d, str. %d) by připadl dvěma popiskům: „%s" a „%s".' % (o['xref'], pi + 1, pouzite[o['xref']], klic))
        pouzite[o['xref']] = klic
        img = doc.extract_image(o['xref'])
        if img['ext'] not in ('jpeg', 'jpg'):
            sys.exit('Obrázek u „%s" není JPEG (%s) — doplnit konverzi.' % (klic, img['ext']))
        nazev = z[1]
        with open(os.path.join(OUT, nazev), 'wb') as f:
            f.write(img['image'])
        for kod in z[2]:
            mapa[kod] = nazev
        zdroj.append((pi + 1, klic, nazev, z[2], z[3]))
        hotovo.add(klic)

chybi = [x[0] for x in POPISKY if x[0] not in hotovo]
if chybi:
    sys.exit('V PDF nenalezeny popisky: %s' % ', '.join(chybi))

with open(os.path.join(OUT, 'map.json'), 'w', encoding='utf-8') as f:
    json.dump(dict(sorted(mapa.items())), f, ensure_ascii=False, indent=2)
    f.write('\n')

print('Zdroj:', os.path.basename(PDF), '| strany', ', '.join(str(s + 1) for s in strany))
for s, klic, nazev, kody, pozn in zdroj:
    print('str. %d  %-22s → %-16s %s%s' % (s, klic, nazev, ', '.join(kody), ('   [' + pozn + ']') if pozn else ''))
print('map.json:', len(mapa), 'kódů →', len(set(mapa.values())), 'obrázků')
