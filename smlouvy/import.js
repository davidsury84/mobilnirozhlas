'use strict';
// Import registru (§7, §12). Vstup = řádky po 13 buňkách v pořadí sloupců
// registru. Zakládá jen SMLOUVY; termíny z volného textu jen NAVRHUJE. KS
// balíky = placeholder (fáze 2b). Garant-oddělení → nedořešeno (mapa na e-mail).

const P = require('./lib/parsing');
const { odvozenyDeadlineVypovedi } = require('./lib/logic');
const { parseCzDate } = require('./lib/datum');

const COL = { id: 0, kategorie: 1, protistrana: 2, predmet: 3, platnost: 4,
  vypoved: 5, deadline: 6, notifikace: 7, hodnota: 8, garant: 9, spravce: 10, stav: 11, odkaz: 12 };

function cell(radek, i) {
  const v = Array.isArray(radek) ? radek[i] : radek[Object.keys(radek)[i]];
  return v == null ? '' : String(v).trim();
}

function navrhniTerminy(radek, draft) {
  const navrhy = [];
  const rok = new Date().getUTCFullYear();
  if (draft.platnost_typ === 'urcita' && draft.platnost_do) {
    navrhy.push({ typ: 'konec_platnosti', datum: draft.platnost_do, popis: 'Konec platnosti smlouvy', opakovani: 'zadne', odvozeny: false });
  }
  const dv = odvozenyDeadlineVypovedi(draft);
  if (dv) navrhy.push({ typ: 'deadline_vypovedi', datum: dv,
    popis: `Poslední den pro podání výpovědi (${draft.vypovedni_lhuta_mesice} měs. před koncem)`, opakovani: 'zadne', odvozeny: true });
  if (draft.platnost_podminka && /km/i.test(draft.platnost_podminka)) {
    const d = parseCzDate(cell(radek, COL.deadline), rok) || parseCzDate(cell(radek, COL.notifikace), rok);
    navrhy.push({ typ: 'km_limit', datum: d ? d.iso : `${rok}-12-31`,
      popis: `Kontrola stavu km (limit: ${draft.platnost_podminka})`, opakovani: 'ctvrtletni', odvozeny: false });
  }
  const texty = [cell(radek, COL.deadline), cell(radek, COL.notifikace)].join(' ; ');
  const opak = /každoročně|ročně|každý rok/i.test(texty) ? 'rocni' : /pololetně/i.test(texty) ? 'ctvrtletni' : 'zadne';
  const videna = new Set(navrhy.map((n) => n.datum));
  for (const m of texty.matchAll(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})?/g)) {
    const d = parseCzDate(m[0], rok);
    if (!d || videna.has(d.iso)) continue;
    videna.add(d.iso);
    navrhy.push({ typ: 'jiny', datum: d.iso, popis: 'Hlídaný termín z registru (ověřit)', opakovani: opak, odvozeny: false });
  }
  return navrhy;
}

function zpracujRadek(radek) {
  const id = cell(radek, COL.id);
  if (!id) return null;

  if (P.jeSouhrnnyBalik(id)) {
    const kat = P.parseKategorie(cell(radek, COL.kategorie));
    return { typ: 'placeholder', draft: {
      cislo_smlouvy: id, kategorie: kat.kategorie || 'plneni', smer: kat.smer,
      protistrana_nazev: cell(radek, COL.protistrana) || id, predmet: cell(radek, COL.predmet),
      je_placeholder: true, stav: 'aktivni', stav_popis: cell(radek, COL.stav), drive_url: cell(radek, COL.odkaz) || null,
    }, poznamka: 'Souhrnný balík kupních smluv – neimportováno jako smlouva (fáze 2b).' };
  }

  const kat = P.parseKategorie(cell(radek, COL.kategorie));
  const platn = P.parsePlatnost(cell(radek, COL.platnost));
  const vyp = P.parseVypoved(cell(radek, COL.vypoved));
  const hod = P.parseHodnota(cell(radek, COL.hodnota));

  const draft = {
    cislo_smlouvy: id, kategorie: kat.kategorie, smer: kat.smer, podtyp: kat.podtyp,
    protistrana_nazev: cell(radek, COL.protistrana), predmet: cell(radek, COL.predmet),
    platnost_typ: platn.platnost_typ, platnost_do: platn.platnost_do, platnost_podminka: platn.platnost_podminka,
    vypovedni_lhuta_mesice: vyp.vypovedni_lhuta_mesice, prolongace: vyp.prolongace,
    hodnota: hod.hodnota, hodnota_typ: hod.hodnota_typ, mena: hod.mena, hodnota_popis: hod.hodnota_popis,
    garant_text: cell(radek, COL.garant) || null, garant_email: null,
    spravce_text: cell(radek, COL.spravce) || null,
    stav: P.mapStav(cell(radek, COL.stav)), stav_popis: cell(radek, COL.stav),
    drive_url: cell(radek, COL.odkaz) || null, je_placeholder: false,
  };
  return { typ: 'smlouva', draft, navrhyTerminu: navrhniTerminy(radek, draft) };
}

// garantMapa = { 'Dušan Fidler': 'dusan.fidler@elkoplast.cz', ... }
function nahled(radky, garantMapa = {}) {
  const smlouvy = []; const placeholdery = []; const nedoreseniGaranti = new Set();
  for (const radek of radky) {
    const z = zpracujRadek(radek);
    if (!z) continue;
    if (z.typ === 'placeholder') { placeholdery.push(z); continue; }
    const gt = z.draft.garant_text;
    if (gt && garantMapa[gt]) z.draft.garant_email = garantMapa[gt];
    else if (gt) nedoreseniGaranti.add(gt);
    smlouvy.push(z);
  }
  return { smlouvy, placeholdery, nedoreseniGaranti: [...nedoreseniGaranti], statistika: {
    smluv: smlouvy.length, placeholderu: placeholdery.length,
    nedoresenychGarantu: nedoreseniGaranti.size,
    navrhovanychTerminu: smlouvy.reduce((a, s) => a + s.navrhyTerminu.length, 0) } };
}

// Zápis do sqlite (models = { smlouva, termin }). Synchronní.
function uloz(models, plan, volby = {}) {
  const v = { zalozeno: 0, aktualizovano: 0, placeholderu: 0, terminu: 0 };
  for (const z of plan.placeholdery) {
    const r = models.smlouva.upsertDleCisla(z.draft, volby.by);
    if (r.zalozeno) v.placeholderu++;
  }
  for (const z of plan.smlouvy) {
    const { garant_text, spravce_text, ...data } = z.draft;
    const r = models.smlouva.upsertDleCisla(data, volby.by);
    if (r.zalozeno) v.zalozeno++; else v.aktualizovano++;
    if (volby.zakladatOdvozeneTerminy !== false && r.zalozeno) {
      for (const t of z.navrhyTerminu) {
        if (t.typ === 'jiny') continue; // ruční potvrzení
        models.termin.create({ smlouva_id: r.id, ...t });
        v.terminu++;
      }
    }
  }
  return v;
}

module.exports = { COL, zpracujRadek, navrhniTerminy, nahled, uloz };
