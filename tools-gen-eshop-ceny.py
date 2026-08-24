# -*- coding: utf-8 -*-
"""Generátor eshop-ceny.json z feedu Shop.CZ.Products (Excel 2003 XML).

Použití:  python3 tools-gen-eshop-ceny.py ~/Projects/Shop.CZ.Products.YYYY.MM.DD-*.xml
Výstup:   eshop-ceny.json v kořeni repa (commitnout + push = nasadit).

Feed má 289 sloupců; bereme jen prodejní ceny a pár metadat. Pozor:
- price_final je ve feedu prázdné — efektivní cena = price × (1 − discount)
- orders je jen textový příznak, NEJSOU to počty objednávek
- buňky se čtou přes ss:Index (Excel XML přeskakuje prázdné buňky)
"""
import io, re, json, html, sys, os, datetime

if len(sys.argv) < 2:
    print(__doc__); sys.exit(1)
SRC = os.path.expanduser(sys.argv[1])
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'eshop-ceny.json')

buf = io.open(SRC, encoding='utf-8').read()
rows_raw = re.findall(r'<Row[^>]*>(.*?)</Row>', buf, re.S)
CELL = re.compile(r'<Cell([^>]*)>\s*(?:<Data[^>]*>(.*?)</Data>)?', re.S)
IDX = re.compile(r'ss:Index="(\d+)"')

def parse_row(r):
    out, pos = {}, 0
    for m in CELL.finditer(r):
        attrs, val = m.group(1), m.group(2)
        im = IDX.search(attrs)
        pos = int(im.group(1)) if im else pos + 1
        if val is not None:
            out[pos - 1] = html.unescape(re.sub(r'<[^>]+>', '', val))
    return out

hdr = parse_row(rows_raw[0])
H = {v: k for k, v in hdr.items()}
ix = {c: H.get(c) for c in ['productCode', 'pairCode', 'producer', 'categories', 'name',
                            'discount', 'discount_to_date', 'price', 'price_tax',
                            'availability', 'stock']}
chybi = [c for c, i in ix.items() if i is None]
if chybi:
    print('CHYBÍ sloupce:', chybi); sys.exit(1)

num = lambda v: (float(v) if v not in (None, '') else None)
out = {}
for r in rows_raw[1:]:
    c = parse_row(r)
    g = lambda k: c.get(ix[k])
    k = g('productCode')
    if not k: continue
    out[k] = {'nazev': g('name') or '', 'prodejniBezDph': num(g('price')), 'prodejniSDph': num(g('price_tax')),
              'sleva': num(g('discount')) or 0, 'slevaDo': g('discount_to_date') or None,
              'dostupnostDni': num(g('availability')), 'skladEshop': num(g('stock')),
              'kategorie': g('categories') or '', 'vyrobce': g('producer') or '', 'parovaciKod': g('pairCode') or ''}

m = re.search(r'(\d{4})\.(\d{2})\.(\d{2})', os.path.basename(SRC))
datum = ('%s-%s-%s' % m.groups()) if m else datetime.date.today().isoformat()
doc = {'zdroj': os.path.basename(SRC), 'zdrojDatum': datum,
       'vygenerovano': datetime.date.today().isoformat(),
       'pozn': 'prodejni ceny e-shopu; efektivni cena = prodejniBezDph x (1 - sleva); klic = productCode = SK-reg',
       'polozky': out}
json.dump(doc, io.open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
print('OK →', OUT, '·', len(out), 'položek · data z', datum)
