'use strict';
// AI extrakce smluvních údajů z PDF přes Claude API (raw HTTPS, bez SDK).
// Vyžaduje env ANTHROPIC_API_KEY. Model: env SMLOUVY_EXTRAKCE_MODEL, jinak Opus 4.8.
// Vstup = PDF v base64 (document blok). Výstup = strukturovaný JSON.

const https = require('https');

function apiKey() { return process.env.ANTHROPIC_API_KEY || ''; }
function configured() { return !!apiKey(); }
function model() { return process.env.SMLOUVY_EXTRAKCE_MODEL || 'claude-opus-4-8'; }

const PROMPT = `Jsi extraktor smluvních údajů. Z přiloženého PDF (česká, příp. anglická smlouva) vytáhni strukturovaná data.
Jedna smluvní strana je vždy ELKOPLAST CZ, s.r.o. — protistranou je ta DRUHÁ strana.
Vrať POUZE JSON objekt, žádný další text ani code fences, s klíči:
{
 "protistrana_nazev": string,            // druhá smluvní strana (ne ELKOPLAST)
 "protistrana_ico": string|null,         // IČO protistrany (jen číslice), jinak null
 "predmet": string,                      // stručný předmět smlouvy, 1 věta
 "anotace": string,                      // 1-2 věty, o čem smlouva je
 "platnost_do": string|null,             // konec platnosti YYYY-MM-DD, jinak null
 "platnost_typ": "urcita"|"neurcita",
 "vypovedni_lhuta_mesice": number|null,  // počet měsíců, jinak null
 "prolongace": "zadna"|"auto"|"jednani", // automatické prodloužení?
 "vypoved_zpusob": string|null,          // JAK a KOMU podat výpověď (konkrétní e-mail/adresa, jsou-li) + mechanika běhu lhůty; null pokud smlouva výpověď neřeší (jen odstoupení)
 "hodnota": number|null,                 // číselná hodnota bez měny, jinak null
 "mena": "CZK"|"EUR"|"USD",
 "terminy": [ {"typ": string, "datum": "YYYY-MM-DD", "popis": string} ]  // klíčové hlídané termíny (konec platnosti, výpovědní okno, konec záruky…); prázdné pole, pokud žádné
}
Nevymýšlej údaje, které v textu nejsou — použij null nebo prázdné pole. U jednorázové kupní smlouvy bez výpovědi dej vypoved_zpusob=null.`;

function post(body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST', host: 'api.anthropic.com', path: '/v1/messages',
      headers: {
        'x-api-key': apiKey(),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Časový limit Claude API.')));
    req.write(body); req.end();
  });
}

function parseJson(text) {
  let t = String(text == null ? '' : text).trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (m) t = m[0];
  return JSON.parse(t);
}

// { base64 } → strukturovaný objekt dle PROMPT.
async function extrahovat({ base64 }) {
  if (!configured()) throw new Error('Chybí ANTHROPIC_API_KEY.');
  const body = JSON.stringify({
    model: model(), max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });
  const raw = await post(body);
  let j; try { j = JSON.parse(raw); } catch { throw new Error('Neplatná odpověď Claude API.'); }
  if (j.error) throw new Error('Claude API: ' + (j.error.message || JSON.stringify(j.error)));
  if (j.stop_reason === 'refusal') throw new Error('Claude odmítl zpracovat dokument.');
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return parseJson(text);
}

module.exports = { configured, extrahovat, model };
