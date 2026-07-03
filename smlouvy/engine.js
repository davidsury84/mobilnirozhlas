'use strict';
// Notifikační motor modulu Smlouvy (§4). Orchestruje nad sqlite modely a
// hostitelským odesíláním pošty (deliver). Čistá rozhodovací logika je v
// lib/logic.js. Cron = tick() s denní pojistkou v meta tabulce.

const crypto = require('crypto');
const { todayPrague, daysUntil, formatCz } = require('./lib/datum');
const L = require('./lib/logic');

const NADPIS = {
  d90: 'Blíží se smluvní termín (90 dní)',
  d60: 'Blíží se smluvní termín (60 dní)',
  d30: 'Blíží se smluvní termín (30 dní)',
  d14: 'ESKALACE: nepotvrzený termín (14 dní)',
  po_terminu: 'PO TERMÍNU: nepotvrzený smluvní termín',
};

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function emailHtml({ termin, milnik, odkaz }) {
  const cerv = milnik === 'd14' || milnik === 'po_terminu';
  return `<div style="font-family:Arial,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:16px">
    <h2 style="color:${cerv ? '#c0392b' : '#2c3e50'};margin:0 0 12px">${esc(NADPIS[milnik])}</h2>
    <p>Smlouva: <strong>${esc(termin.cislo_smlouvy || '')}</strong> ${termin.protistrana_nazev ? '— ' + esc(termin.protistrana_nazev) : ''}</p>
    <table style="margin:12px 0;font-size:14px">
      <tr><td style="color:#666;padding-right:12px">Typ termínu</td><td><strong>${esc(termin.typ)}</strong></td></tr>
      <tr><td style="color:#666;padding-right:12px">Datum</td><td><strong>${esc(formatCz(termin.datum))}</strong></td></tr>
      ${termin.popis ? `<tr><td style="color:#666;padding-right:12px">Popis</td><td>${esc(termin.popis)}</td></tr>` : ''}
    </table>
    <p style="margin:16px 0"><a href="${esc(odkaz)}" style="background:#27ae60;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;display:inline-block">Otevřít potvrzení „Vyřešeno"</a></p>
    <p style="font-size:12px;color:#888">Odkaz jen otevře stránku — termín se uzavře až po kliknutí na tlačítko tam. Hlídač smluv ELKOPLAST.</p>
  </div>`;
}

// Uzavření termínu (potvrzení). U opakujícího založí další výskyt.
function uzavriTermin(models, terminId, byEmail, now = new Date()) {
  const t = models.termin.getById(terminId);
  if (!t || t.stav === 'vyreseno') return { termin: t, zalozenNovy: null };
  models.termin.oznacVyreseny(terminId, byEmail, now.toISOString());
  let zalozenNovy = null;
  const dalsi = L.dalsiVyskyt(t);
  if (dalsi) zalozenNovy = models.termin.create({
    smlouva_id: t.smlouva_id, typ: t.typ, datum: dalsi, popis: t.popis, odvozeny: !!t.odvozeny, opakovani: t.opakovani });
  return { termin: t, zalozenNovy };
}

// Jeden běh motoru přes všechny čekající termíny.
async function runOnce(models, ctx, now = new Date()) {
  const dnes = todayPrague(now);
  const terminy = models.termin.aktivniCekajici(dnes);
  const vysledky = [];
  for (const t of terminy) {
    try { vysledky.push(await zpracujTermin(models, ctx, t, dnes, now)); }
    catch (e) { vysledky.push({ termin_id: t.id, chyba: e.message }); }
  }
  return vysledky;
}

async function zpracujTermin(models, ctx, termin, dnes, now) {
  const dny = daysUntil(termin.datum, dnes);
  const jiz = new Set(models.notifikace.odeslaneMilniky(termin.id));
  const plan = L.planNotifikace(dny, jiz);
  if (!plan) return { termin_id: termin.id, akce: 'nic' };

  const komu = L.prijemci(plan.milnik, {
    garant: termin.garant_email, spravce: termin.spravce_email, admin: ctx.eskalaceEmail });
  if (komu.length === 0) return { termin_id: termin.id, akce: 'bez_prijemce', milnik: plan.milnik };

  const token = crypto.randomUUID();
  const expiry = new Date(now.getTime() + 60 * 86400000).toISOString();
  const odkaz = `${ctx.baseUrl.replace(/\/$/, '')}/smlouvy/potvrdit/${token}`;
  const predmet = `[Smlouvy] ${NADPIS[plan.milnik]} — ${termin.protistrana_nazev || termin.cislo_smlouvy || ''}`.trim();
  const html = emailHtml({ termin, milnik: plan.milnik, odkaz });

  let msgId = null;
  for (const to of komu) {
    try {
      const r = await ctx.deliver({ to, subject: predmet, html });
      if (!msgId) msgId = (r && (r.id || (r.data && r.data.id))) || null;
    } catch (e) { /* deliver chyby nezablokují zápis; webhook/log dořeší */ }
  }
  models.notifikace.zapis({
    termin_id: termin.id, milnik: plan.milnik, komu_email: komu.join(', '),
    resend_message_id: msgId, token, token_expires_at: expiry, resend: plan.resend });

  if (plan.milnik === 'd14') models.termin.oznacEskalovany(termin.id);
  return { termin_id: termin.id, akce: 'odeslano', milnik: plan.milnik, prijemcu: komu.length };
}

// Denní tick s pojistkou (spouští se z 6h intervalu jako měsíční report).
async function tick(models, ctx, now = new Date()) {
  const dnes = todayPrague(now);
  if (models.meta.get('last_daily') === dnes) return { preskoceno: true };
  const vys = await runOnce(models, ctx, now);
  models.meta.set('last_daily', dnes);
  const odeslano = vys.filter((v) => v && v.akce === 'odeslano').length;
  console.log(`[smlouvy] denní běh ${dnes}: ${vys.length} termínů, ${odeslano} notifikací`);
  return { dnes, zpracovano: vys.length, odeslano };
}

module.exports = { runOnce, tick, zpracujTermin, uzavriTermin, emailHtml, NADPIS };
