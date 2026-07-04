'use strict';
// End-to-end test modulu proti reálné node:sqlite (bez intranetu).
// Spuštění: node --test smlouvy/test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openDb } = require('./db');
const engine = require('./engine');
const imp = require('./import');
const { todayPrague } = require('./lib/datum');
const L = require('./lib/logic');

const NOW = new Date('2026-01-01T09:00:00Z');
const iso = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86400000).toISOString().slice(0, 10);

function fakeCtx() {
  const sent = [];
  return { sent, deliver: async (m) => { sent.push(m); return { id: 'msg-' + sent.length }; },
    baseUrl: 'https://intranet.test', eskalaceEmail: 'david.sury@elkoplast.cz' };
}

test('sqlite: idempotence milníku na úrovni DB (UNIQUE)', async () => {
  const M = openDb(':memory:');
  const s = M.smlouva.create({ cislo_smlouvy: 'T-1', kategorie: 'dodavatelska', protistrana_nazev: 'X',
    garant_email: 'g@elkoplast.cz', spravce_email: 'simona@elkoplast.cz', stav: 'aktivni' });
  M.termin.create({ smlouva_id: s.id, typ: 'konec_platnosti', datum: iso(85) });

  const ctx = fakeCtx();
  await engine.runOnce(M, ctx, NOW);
  await engine.runOnce(M, ctx, NOW); // druhý běh téhož dne
  const rows = M.notifikace.historieProTermin(M.termin.listBySmlouva(s.id)[0].id);
  assert.equal(rows.filter((r) => r.milnik === 'd90').length, 1, 'jen jedna d90 (UNIQUE)');
  assert.equal(ctx.sent.length, 2, 'poslal garantovi i správci');
});

test('sqlite: potvrzení tokenem uzavře termín a je jednorázové', async () => {
  const M = openDb(':memory:');
  const s = M.smlouva.create({ cislo_smlouvy: 'T-2', kategorie: 'zavazek', protistrana_nazev: 'Y',
    garant_email: 'g@x.cz', spravce_email: 's@x.cz', stav: 'aktivni' });
  const t = M.termin.create({ smlouva_id: s.id, typ: 'rocni_review', datum: iso(80), opakovani: 'rocni' });
  await engine.runOnce(M, fakeCtx(), NOW);
  const n = M.notifikace.historieProTermin(t.id)[0];
  assert.ok(n.token, 'token vygenerován');

  engine.uzavriTermin(M, t.id, 'g@x.cz');
  M.notifikace.oznacTokenPouzity(n.token);
  assert.equal(M.termin.getById(t.id).stav, 'vyreseno');
  // opakující se → založen další výskyt o rok
  const vsechny = M.termin.listBySmlouva(s.id);
  assert.ok(vsechny.some((x) => x.datum === iso(80).replace('2026', '2027')), 'další výskyt 2027');

  // druhé uzavření je no-op
  const before = M.termin.listBySmlouva(s.id).length;
  engine.uzavriTermin(M, t.id, 'g@x.cz');
  assert.equal(M.termin.listBySmlouva(s.id).length, before, 'nezaloží duplicitu');
});

test('sqlite: D−14 eskalace na admina, stav eskalovano', async () => {
  const M = openDb(':memory:');
  const s = M.smlouva.create({ cislo_smlouvy: 'T-3', kategorie: 'dodavatelska', protistrana_nazev: 'Z',
    garant_email: 'g@x.cz', spravce_email: 's@x.cz', stav: 'aktivni' });
  const t = M.termin.create({ smlouva_id: s.id, typ: 'sla', datum: iso(10) });
  const ctx = fakeCtx();
  await engine.runOnce(M, ctx, NOW);
  assert.equal(M.termin.getById(t.id).stav, 'eskalovano');
  assert.ok(ctx.sent.some((m) => m.to === 'david.sury@elkoplast.cz'));
});

test('sqlite: catch-up importované smlouvy (40 dní → d60)', async () => {
  const M = openDb(':memory:');
  const s = M.smlouva.create({ cislo_smlouvy: 'T-4', kategorie: 'dodavatelska', protistrana_nazev: 'W',
    garant_email: 'g@x.cz', spravce_email: 's@x.cz', stav: 'aktivni' });
  const t = M.termin.create({ smlouva_id: s.id, typ: 'konec_platnosti', datum: iso(40) });
  await engine.runOnce(M, fakeCtx(), NOW);
  const rows = M.notifikace.historieProTermin(t.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].milnik, 'd60', 'nejbližší aktuální milník, ne d90');
});

test('rozpad závazků: roční toky odděleně od podmíněných/majetku', () => {
  const zav = [
    { kategorie: 'zavazek', cislo_smlouvy: 'A', protistrana_nazev: 'Baroclean', hodnota: 400000, hodnota_typ: 'rocni', mena: 'EUR' },
    { kategorie: 'zavazek', cislo_smlouvy: 'B', protistrana_nazev: 'Contenur', hodnota: 150000, hodnota_typ: 'expozice', mena: 'EUR' },
    { kategorie: 'zavazek', cislo_smlouvy: 'C', protistrana_nazev: 'Zhejiang', hodnota: 50000, hodnota_typ: 'majetek', mena: 'USD' },
    { kategorie: 'zavazek', cislo_smlouvy: 'D', protistrana_nazev: 'MP', hodnota: null, hodnota_typ: null, mena: 'CZK', hodnota_popis: 'dle objednávek' },
    { kategorie: 'zavazek', cislo_smlouvy: 'E', protistrana_nazev: 'Pausal', hodnota: 1000, hodnota_typ: 'mesicni', mena: 'CZK' },
  ];
  const r = L.rozpadZavazku(zav);
  assert.deepEqual(r.rocni, { EUR: 400000, CZK: 12000 }, 'roční = Baroclean + měsíční×12');
  assert.deepEqual(r.podmineno, { EUR: 150000, USD: 50000 }, 'podmíněné = expozice + majetek, NEmíchá se s ročními');
  assert.equal(r.polozky.length, 4);
  assert.equal(r.nevycisleno.length, 1);
  assert.equal(r.nevycisleno[0].cislo_smlouvy, 'D');
});

test('řešení plnění: log záznamů (create + list DESC)', () => {
  const M = openDb(':memory:');
  const s = M.smlouva.create({ cislo_smlouvy: 'R-1', kategorie: 'zavazek', protistrana_nazev: 'X',
    garant_email: 'g@x.cz', stav: 'aktivni' });
  assert.equal(M.reseni.listBySmlouva(s.id).length, 0);
  M.reseni.create({ smlouva_id: s.id, text: 'zahájeno jednání', autor_email: 'g@x.cz' });
  M.reseni.create({ smlouva_id: s.id, text: 'odesláno protistraně', autor_email: 'g@x.cz' });
  const list = M.reseni.listBySmlouva(s.id);
  assert.equal(list.length, 2);
  assert.equal(list[0].text, 'odesláno protistraně', 'nejnovější první (DESC)');
  assert.equal(list[0].autor_email, 'g@x.cz');
});

test('import: KS placeholder, km-limit, nedořešený garant, expozice', () => {
  const M = openDb(':memory:');
  const radky = [
    ['2026-009', 'DODAVATELSKÁ', 'Scania CZ', 'DARIS', '30.6.2027 nebo 710 000 km', '3 měsíce',
      'výpověď do 31.3.2027', '1.3.2027', '1 840 Kč/měs', 'Dušan Fidler', 'Simona Janečková', 'aktivní', 'otevřít'],
    ['2026-001', 'ZÁVAZEK – rámcová', 'Marius Pedersen', 'indexace', '31.12.2027', '2 měsíce',
      'výpověď do 31.10.2027', '1.10.2027 + každoročně 15.11.', '120 000 Kč/rok', 'logistika', 'Simona Janečková', 'aktivní', 'otevřít'],
    ['KS-2026', 'ODBĚRATELSKÉ KS 2026 (souhrn)', 'více', 'balík', 'dodání', '', '', '', '', 'obchodník', 'Simona Janečková', 'plnění', 'otevřít'],
  ];
  const n = imp.nahled(radky, {});
  assert.equal(n.placeholdery.length, 1);
  assert.equal(n.smlouvy.length, 2);
  assert.ok(n.nedoreseniGaranti.includes('logistika'));

  const v = imp.uloz({ smlouva: M.smlouva, termin: M.termin }, n, { by: 'test', zakladatOdvozeneTerminy: true });
  assert.equal(v.placeholderu, 1);
  assert.equal(v.zalozeno, 2);

  const scania = M.smlouva.getByCislo('2026-009');
  assert.match(scania.platnost_podminka, /km/);
  const terminy = M.termin.listBySmlouva(scania.id);
  assert.ok(terminy.some((t) => t.typ === 'km_limit'));
  assert.ok(terminy.some((t) => t.typ === 'deadline_vypovedi'));

  // expozice: MP 120000 Kč/rok jako závazek
  const e = L.expoziceZavazku(M.smlouva.proExpozici());
  assert.equal(e.CZK, 120000);

  // idempotentní re-import nezaloží duplicity
  const v2 = imp.uloz({ smlouva: M.smlouva, termin: M.termin }, n, { by: 'test' });
  assert.equal(v2.zalozeno, 0);
  assert.equal(M.smlouva.all().length, 3);
});
