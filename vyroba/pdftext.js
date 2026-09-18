'use strict';
// ============================================================================
//  Text z jednoduchých PDF bez knihoven — pro Bestellung od Contractu (ReportBuilder,
//  WinAnsi) a vydané objednávky z Heliosu (ReportBuilder, CP1250 přes /Differences).
//  Umí: FlateDecode streamy, operátory Tj / TJ / ' / ", pozicování Td / TD / Tm / T*.
//  Řádky se lámou podle změny svislé souřadnice textu.
// ----------------------------------------------------------------------------
const zlib = require('zlib');

function decoderFor(pdfLatin1) {
  // Helios používá WinAnsi + Differences s českými znaky (Ccaron, rcaron…) = fakticky CP1250.
  const cz = /\/Differences[\s\S]{0,2000}?\/(Ccaron|ccaron|rcaron|ecaron)/.test(pdfLatin1);
  try { return new TextDecoder(cz ? 'windows-1250' : 'windows-1252'); } catch (_) { return { decode: b => Buffer.from(b).toString('latin1') }; }
}

// Všechny dekomprimované content streamy (jen ty s textovými operátory).
function contentStreams(buf) {
  const out = []; let i = 0;
  for (;;) {
    const s = buf.indexOf('stream', i); if (s < 0) break;
    let start = s + 6; if (buf[start] === 0x0d) start++; if (buf[start] === 0x0a) start++;
    const e = buf.indexOf('endstream', start); if (e < 0) break;
    const dictStart = buf.lastIndexOf('<<', s);
    const dict = dictStart >= 0 ? buf.slice(dictStart, s).toString('latin1') : '';
    let data = buf.slice(start, e);
    if (/FlateDecode/.test(dict)) {
      try { data = zlib.inflateSync(data); } catch (_) { try { data = zlib.inflateRawSync(data); } catch (_) { data = null; } }
    }
    if (data && data.indexOf('BT') >= 0) out.push(data);
    i = e + 9;
  }
  return out;
}

// Tokenizér content streamu: řetězce (…), pole […], čísla, operátory.
function tokenize(buf) {
  const t = []; let i = 0; const n = buf.length;
  const isWs = c => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
  while (i < n) {
    const c = buf[i];
    if (isWs(c)) { i++; continue; }
    if (c === 0x25) { while (i < n && buf[i] !== 0x0a && buf[i] !== 0x0d) i++; continue; }          // % komentář
    if (c === 0x28) {                                                                                 // ( řetězec
      let depth = 1; i++; const bytes = [];
      while (i < n && depth > 0) {
        let b = buf[i];
        if (b === 0x5c) {                                                                             // \ escape
          i++; b = buf[i];
          if (b === 0x6e) bytes.push(10); else if (b === 0x72) bytes.push(13); else if (b === 0x74) bytes.push(9);
          else if (b === 0x62) bytes.push(8); else if (b === 0x66) bytes.push(12);
          else if (b >= 0x30 && b <= 0x37) { let o = 0, k = 0; while (k < 3 && buf[i] >= 0x30 && buf[i] <= 0x37) { o = o * 8 + (buf[i] - 0x30); i++; k++; } i--; bytes.push(o & 255); }
          else if (b === 0x0a || b === 0x0d) { /* pokračování řádku */ }
          else bytes.push(b);
          i++; continue;
        }
        if (b === 0x28) depth++; else if (b === 0x29) { depth--; if (!depth) { i++; break; } }
        bytes.push(b); i++;
      }
      t.push({ s: Buffer.from(bytes) }); continue;
    }
    if (c === 0x3c && buf[i + 1] === 0x3c) { t.push({ op: '<<' }); i += 2; continue; }
    if (c === 0x3e && buf[i + 1] === 0x3e) { t.push({ op: '>>' }); i += 2; continue; }
    if (c === 0x3c) {                                                                                 // <hex>
      let j = i + 1, hex = ''; while (j < n && buf[j] !== 0x3e) { hex += String.fromCharCode(buf[j]); j++; }
      t.push({ s: Buffer.from(hex.replace(/[^0-9a-fA-F]/g, ''), 'hex') }); i = j + 1; continue;
    }
    if (c === 0x5b) { t.push({ op: '[' }); i++; continue; }
    if (c === 0x5d) { t.push({ op: ']' }); i++; continue; }
    if (c === 0x2f) { let j = i + 1; while (j < n && !isWs(buf[j]) && !'/[]()<>'.includes(String.fromCharCode(buf[j]))) j++; t.push({ name: buf.slice(i + 1, j).toString('latin1') }); i = j; continue; }
    if ((c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2b || c === 0x2e) {
      let j = i + 1; while (j < n && ((buf[j] >= 0x30 && buf[j] <= 0x39) || buf[j] === 0x2e || buf[j] === 0x2d)) j++;
      t.push({ num: parseFloat(buf.slice(i, j).toString('latin1')) || 0 }); i = j; continue;
    }
    let j = i; while (j < n && !isWs(buf[j]) && !'/[]()<>'.includes(String.fromCharCode(buf[j]))) j++;
    if (j === i) { i++; continue; }
    t.push({ op: buf.slice(i, j).toString('latin1') }); i = j;
  }
  return t;
}

// Text jedné stránky/streamu jako řádky (pole {y, x, text}).
function extractRuns(buf) {
  const toks = tokenize(buf);
  const runs = []; let x = 0, y = 0, lx = 0, ly = 0, lead = 0, fontSize = 1;
  const stack = [];
  const push = (s) => { if (s && s.length) runs.push({ x, y, s, fs: fontSize }); };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.op === undefined) { stack.push(tk); continue; }
    const args = stack.splice(0);
    const nums = args.filter(a => a.num !== undefined).map(a => a.num);
    switch (tk.op) {
      case 'BT': x = y = lx = ly = 0; break;
      case 'Tf': fontSize = nums[nums.length - 1] || fontSize; break;
      case 'TL': lead = nums[0] || 0; break;
      case 'Td': lx += nums[0] || 0; ly += nums[1] || 0; x = lx; y = ly; break;
      case 'TD': lx += nums[0] || 0; ly += nums[1] || 0; x = lx; y = ly; lead = -(nums[1] || 0); break;
      case 'Tm': lx = x = nums[4] || 0; ly = y = nums[5] || 0; break;
      case 'T*': ly -= lead; x = lx; y = ly; break;
      case 'Tj': { const s = args.find(a => a.s); if (s) push(s.s); break; }
      case "'": { ly -= lead; x = lx; y = ly; const s = args.find(a => a.s); if (s) push(s.s); break; }
      case '"': { ly -= lead; x = lx; y = ly; const s = args.filter(a => a.s).pop(); if (s) push(s.s); break; }
      case 'TJ': {
        // pole: řetězce + posuny; velký záporný posun = mezera
        const parts = []; let cur = [];
        for (const a of args) {
          if (a.s) cur.push(a.s);
          else if (a.num !== undefined && a.num < -180) { cur.push(Buffer.from(' ')); }
        }
        if (cur.length) push(Buffer.concat(cur));
        void parts; break;
      }
      default: break;
    }
  }
  return runs;
}

// Přibližné šířky znaků Arialu (em) — stačí na rozhodnutí „je mezi běhy mezera?".
function textWidth(s) {
  let w = 0;
  for (const ch of s) {
    if (/[ijl.,:;'!|I\s]/.test(ch)) w += 0.28;
    else if (/[ftr\-()\[\]]/.test(ch)) w += 0.36;
    else if (/[mwMW]/.test(ch)) w += 0.85;
    else if (/[A-ZÁ-Ž]/.test(ch)) w += 0.68;
    else w += 0.55;
  }
  return w;
}

// Celý text PDF: řádky seřazené shora dolů (v rámci streamu), sloupce zleva doprava.
function pdfToText(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const dec = decoderFor(buf.toString('latin1'));
  const lines = [];
  for (const cs of contentStreams(buf)) {
    const runs = extractRuns(cs);
    // seskupit podle y (tolerance 2 body), seřadit sestupně (PDF má počátek dole)
    const groups = [];
    runs.forEach(r => {
      let g = groups.find(g => Math.abs(g.y - r.y) <= 2);
      if (!g) { g = { y: r.y, items: [] }; groups.push(g); }
      g.items.push(r);
    });
    groups.sort((a, b) => b.y - a.y);
    groups.forEach(g => {
      g.items.sort((a, b) => a.x - b.x);
      // Spojování běhů na řádku: ReportBuilder kreslí některé texty po znacích (každý znak = vlastní
      // Tj s posunem). Mezera se vloží jen tam, kde je mezi konci běhů skutečná mezera.
      let text = '', endX = null;
      g.items.forEach(r => {
        const s = dec.decode(r.s);
        const w = textWidth(s) * (r.fs || 10);                 // odhad šířky v bodech (Arial)
        if (endX != null) {
          const gap = r.x - endX;
          if (gap > (r.fs || 10) * 0.22) text += ' ';
        }
        text += s; endX = r.x + w;
      });
      text = text.replace(/\s{2,}/g, ' ').trim();
      if (text) lines.push(text);
    });
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { pdfToText };
