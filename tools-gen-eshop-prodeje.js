#!/usr/bin/env node
/**
 * Rozpad prodejů na kanály: co prodal E-SHOP vs. co obchod/sklad (zakázky).
 *
 * Vstup:  export „Prodeje eshop" z ERP (jen vydané faktury e-shopových řad,
 *         sloupec Příjmení = E-SHOP). Cesta jako 1. argument.
 * Výstup: eshop-prodeje.json v kořeni — {ident: {"YYYY-MM": ks}} + Kč.
 *
 * Celkový prodej (obrat plasty) drží SMI; e-shop je jeho podmnožina,
 * takže obchod = celkem − e-shop. U dropshipových řad může e-shop celkem
 * přesáhnout (zboží nejde přes sklad, ve výdejích tedy chybí) — proto se
 * v aplikaci obchod ořezává na 0 a rozdíl se hlásí jako „mimo sklad".
 *
 * Použití: node tools-gen-eshop-prodeje.js "~/Downloads/Prodeje eshop ....xlsx"
 */
const fs = require('fs'), path = require('path');
const X = require('./nakup-report/xlsx-mini');

const src = process.argv[2] || path.join(process.env.HOME, 'Downloads', 'Prodeje eshop 2020-2026 (4).xlsx');
const s = X.parse(fs.readFileSync(src));
const H = s[0], c = n => { const i = H.indexOf(n); if (i < 0) throw new Error('chybí sloupec ' + n); return i; };
const iSK = c('SK'), iR = c('Reg. č.'), iN = c('Název 1'), iQ = c('Množství'),
      iKC = c('CC bez daní'), iY = c('Datum případu (R)'), iM = c('Datum případu (M)'),
      iKan = H.indexOf('Příjmení');   // nepovinný — chybí-li, bereme celý soubor jako e-shop

const items = {}, nazvy = {};
let radku = 0, jine = 0, ymMin = '9999-99', ymMax = '0000-00';
for (let i = 1; i < s.length; i++) {
  const r = s[i];
  // Celý export JE e-shop; „Příjmení" je jen pojistka proti řádku jiného kanálu.
  const kan = iKan >= 0 ? String(r[iKan] || '').trim().toUpperCase() : '';
  if (kan && kan !== 'E-SHOP') { jine++; continue; }
  const y = +r[iY], m = +r[iM];
  if (!y || !m) continue;
  const ym = y + '-' + String(m).padStart(2, '0');
  const id = String(r[iSK] || '').trim() + '-' + String(r[iR] || '').trim();
  if (id === '-') continue;
  const o = items[id] || (items[id] = { ks: {}, kc: {} });
  o.ks[ym] = +((o.ks[ym] || 0) + (+r[iQ] || 0)).toFixed(3);
  o.kc[ym] = Math.round((o.kc[ym] || 0) + (+r[iKC] || 0));
  if (!nazvy[id]) nazvy[id] = String(r[iN] || '').trim();
  if (ym < ymMin) ymMin = ym; if (ym > ymMax) ymMax = ym;
  radku++;
}

const out = {
  generated: new Date().toISOString(),
  source: path.basename(src),
  kanal: 'E-SHOP (sloupec Příjmení v exportu ERP)',
  od: ymMin, do: ymMax, radku,
  items,
};
fs.writeFileSync(path.join(__dirname, 'eshop-prodeje.json'), JSON.stringify(out));
console.log('eshop-prodeje.json: ' + Object.keys(items).length + ' položek, ' + radku + ' řádků, ' + ymMin + '…' + ymMax +
  (jine ? (' (přeskočeno ' + jine + ' řádků jiného kanálu)') : ''));
