'use strict';
// Minimální čtečka .xlsx (binární) v čistém Node — bez závislostí.
// Rozbalí ZIP (central directory), inflatne deflate (zlib), rozparsuje první list + sdílené řetězce.
// Vrací pole řádků (pole buněk); prázdné buňky = ''. Určeno pro jednoduché tabulkové exporty (ERP).
const zlib = require('zlib');

// ---- ZIP: najdi a rozbal položky dle názvu ----
function readZip(buf) {
  // End of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx: EOCD nenalezen (není to ZIP?)');
  const cdCount = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries[name] = { method, compSize, lho };
    off += 46 + nameLen + extraLen + commLen;
  }
  return { buf, entries };
}
function extract(zip, name) {
  const e = zip.entries[name]; if (!e) return null;
  const buf = zip.buf, lho = e.lho;
  if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('xlsx: vadná lokální hlavička ' + name);
  const nameLen = buf.readUInt16LE(lho + 26);
  const extraLen = buf.readUInt16LE(lho + 28);
  const start = lho + 30 + nameLen + extraLen;
  const data = buf.slice(start, start + e.compSize);
  if (e.method === 0) return data;                 // stored
  if (e.method === 8) return zlib.inflateRawSync(data); // deflate
  throw new Error('xlsx: nepodporovaná komprese ' + e.method);
}

// ---- XML helpers ----
function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}
// text z <t>...</t> (i s běhy <r><t>) uvnitř kusu XML
function textOf(xml) {
  let out = ''; const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g; let m;
  while ((m = re.exec(xml))) out += decodeEntities(m[1]);
  if (!out && /<t\b[^>]*\/>/.test(xml)) out = '';
  return out;
}
function colToIdx(ref) { // "A1" -> 0, "AB12" -> 27
  const m = /^([A-Z]+)/.exec(ref || ''); if (!m) return -1;
  let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parse(buffer) {
  const zip = readZip(buffer);
  // sdílené řetězce
  const shared = [];
  const ss = extract(zip, 'xl/sharedStrings.xml');
  if (ss) {
    const sx = ss.toString('utf8'); const re = /<si>([\s\S]*?)<\/si>/g; let m;
    while ((m = re.exec(sx))) shared.push(textOf(m[1]));
  }
  // první list (dle workb.xml.rels → jinak sheet1)
  let sheetName = 'xl/worksheets/sheet1.xml';
  if (!zip.entries[sheetName]) {
    const k = Object.keys(zip.entries).find(x => /^xl\/worksheets\/sheet\d+\.xml$/.test(x));
    if (k) sheetName = k;
  }
  const shBuf = extract(zip, sheetName);
  if (!shBuf) throw new Error('xlsx: list nenalezen');
  const sx = shBuf.toString('utf8');
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g; let rm;
  while ((rm = rowRe.exec(sx))) {
    const cells = []; const cRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm;
    while ((cm = cRe.exec(rm[1]))) {
      const attr = cm[1] || '', inner = cm[2] || '';
      const refM = /r="([A-Z]+\d+)"/.exec(attr); const idx = refM ? colToIdx(refM[1]) : cells.length;
      const tM = /t="([^"]+)"/.exec(attr); const t = tM ? tM[1] : '';
      let val = '';
      if (t === 's') { const vM = /<v>([\s\S]*?)<\/v>/.exec(inner); val = vM ? (shared[+vM[1]] || '') : ''; }
      else if (t === 'inlineStr') { val = textOf(inner); }
      else if (t === 'str') { const vM = /<v>([\s\S]*?)<\/v>/.exec(inner); val = vM ? decodeEntities(vM[1]) : ''; }
      else { const vM = /<v>([\s\S]*?)<\/v>/.exec(inner); if (vM) { const num = parseFloat(vM[1]); val = isNaN(num) ? decodeEntities(vM[1]) : num; } }
      if (idx >= 0) cells[idx] = val;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

module.exports = { parse };
