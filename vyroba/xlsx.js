'use strict';
// ============================================================================
//  Minimalistické čtení .xlsx bez knihoven (ZIP + inflateRaw + XML listů).
//  Vrací listy jako pole řádků s hodnotami jako řetězce (čísla nezaokrouhluje,
//  datumy vrací jako sériové číslo Excelu — převod řeší volající).
// ----------------------------------------------------------------------------
const zlib = require('zlib');

function readZip(buf) {
  const files = {};
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Není ZIP/xlsx.');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20), usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lnlen + lelen;
    files[name] = { method, csize, usize, dataStart };
    off += 46 + nlen + elen + clen;
  }
  return {
    names: Object.keys(files),
    read(name) {
      const f = files[name]; if (!f) return null;
      const raw = buf.slice(f.dataStart, f.dataStart + f.csize);
      if (f.method === 0) return raw;
      if (f.method === 8) return zlib.inflateRawSync(raw);
      throw new Error('Nepodporovaná komprese v xlsx: ' + f.method);
    },
  };
}

const unesc = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const stripTags = s => String(s || '').replace(/<[^>]+>/g, '');

function sharedStrings(zip) {
  const x = zip.read('xl/sharedStrings.xml'); if (!x) return [];
  const out = []; const re = /<si>([\s\S]*?)<\/si>/g; let m;
  while ((m = re.exec(x.toString('utf8')))) {
    const ts = []; const rt = /<t[^>]*>([\s\S]*?)<\/t>/g; let t;
    while ((t = rt.exec(m[1]))) ts.push(unesc(t[1]));
    out.push(ts.join(''));
  }
  return out;
}

function sheetList(zip) {
  const wb = zip.read('xl/workbook.xml'); if (!wb) return [];
  const rels = zip.read('xl/_rels/workbook.xml.rels');
  const relMap = {};
  if (rels) { const rr = /<Relationship\s[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g; let m; const s = rels.toString('utf8'); while ((m = rr.exec(s))) relMap[m[1]] = m[2]; const rr2 = /<Relationship\s[^>]*?Target="([^"]+)"[^>]*?Id="([^"]+)"/g; while ((m = rr2.exec(s))) relMap[m[2]] = relMap[m[2]] || m[1]; }
  const out = []; const re = /<sheet\s[^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g; let m; const s = wb.toString('utf8');
  while ((m = re.exec(s))) { let target = relMap[m[2]] || ''; if (target && !target.startsWith('/')) target = 'xl/' + target.replace(/^\/?xl\//, ''); else target = target.replace(/^\//, ''); out.push({ name: unesc(m[1]), path: target }); }
  return out;
}

function colIndex(ref) { const m = String(ref).match(/^([A-Z]+)/); if (!m) return 0; let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

function readSheet(zip, path, sst) {
  const x = zip.read(path); if (!x) return [];
  const s = x.toString('utf8'); const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g; let rm;
  while ((rm = rowRe.exec(s))) {
    const row = [];
    const cellRe = /<c\s+r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const ci = colIndex(cm[1]); const attrs = cm[2] || ''; const inner = cm[3] || '';
      const tm = attrs.match(/\bt="([^"]+)"/); const type = tm ? tm[1] : '';
      let val = '';
      if (type === 's') { const v = inner.match(/<v>([\s\S]*?)<\/v>/); val = v ? (sst[+v[1]] || '') : ''; }
      else if (type === 'inlineStr') { val = unesc(stripTags(inner)); }
      else { const v = inner.match(/<v>([\s\S]*?)<\/v>/); val = v ? unesc(v[1]) : ''; }
      while (row.length < ci) row.push('');
      row[ci] = val;
    }
    rows.push(row);
  }
  return rows;
}

// Sériové číslo Excelu → ISO datum
function excelDate(v) {
  const n = Number(v); if (!Number.isFinite(n) || n < 20000 || n > 80000) return null;
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
}

function parseXlsx(buf, wantedSheets) {
  const zip = readZip(buf);
  const sst = sharedStrings(zip);
  const sheets = sheetList(zip);
  const out = {};
  for (const sh of sheets) {
    if (wantedSheets && !wantedSheets.some(w => (w instanceof RegExp ? w.test(sh.name) : w === sh.name))) continue;
    out[sh.name] = readSheet(zip, sh.path, sst);
  }
  return { sheets: sheets.map(s => s.name), data: out };
}

module.exports = { parseXlsx, excelDate };
