'use strict';
// Úložiště modulu Smlouvy — node:sqlite (single-file data/smlouvy.db, bez
// závislostí). Lidé (garant/správce) se klíčují E-MAILEM proti zaměstnancům
// intranetu. Idempotence milníků drží UNIQUE(termin_id, milnik).

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS smlouva (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cislo_smlouvy TEXT UNIQUE,
  kategorie TEXT NOT NULL,
  smer TEXT,
  podtyp TEXT,
  protistrana_nazev TEXT NOT NULL,
  protistrana_ico TEXT,
  predmet TEXT,
  platnost_typ TEXT NOT NULL DEFAULT 'urcita',
  platnost_do TEXT,
  platnost_podminka TEXT,
  vypovedni_lhuta_mesice INTEGER,
  prolongace TEXT NOT NULL DEFAULT 'zadna',
  hodnota REAL,
  hodnota_typ TEXT,
  hodnota_popis TEXT,
  mena TEXT NOT NULL DEFAULT 'CZK',
  garant_email TEXT,
  spravce_email TEXT,
  stav TEXT NOT NULL DEFAULT 'aktivni',
  stav_popis TEXT,
  drive_url TEXT,
  je_placeholder INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT, updated_by TEXT
);
CREATE INDEX IF NOT EXISTS ix_smlouva_stav ON smlouva(stav);

CREATE TABLE IF NOT EXISTS dodatek (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  smlouva_id INTEGER NOT NULL REFERENCES smlouva(id) ON DELETE CASCADE,
  cislo TEXT, datum TEXT, co_meni TEXT, drive_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_dodatek_smlouva ON dodatek(smlouva_id);

CREATE TABLE IF NOT EXISTS termin (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  smlouva_id INTEGER NOT NULL REFERENCES smlouva(id) ON DELETE CASCADE,
  typ TEXT NOT NULL,
  datum TEXT NOT NULL,
  popis TEXT,
  odvozeny INTEGER NOT NULL DEFAULT 0,
  opakovani TEXT NOT NULL DEFAULT 'zadne',
  stav TEXT NOT NULL DEFAULT 'ceka',
  snooze_do TEXT,
  potvrzeno_at TEXT,
  potvrzeno_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_termin_smlouva ON termin(smlouva_id);
CREATE INDEX IF NOT EXISTS ix_termin_stav ON termin(stav);

CREATE TABLE IF NOT EXISTS notifikace (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  termin_id INTEGER NOT NULL REFERENCES termin(id) ON DELETE CASCADE,
  milnik TEXT NOT NULL,
  komu_email TEXT,
  odeslano_at TEXT NOT NULL DEFAULT (datetime('now')),
  resend_message_id TEXT,
  stav_doruceni TEXT NOT NULL DEFAULT 'queued',
  token TEXT,
  token_expires_at TEXT,
  token_used_at TEXT,
  UNIQUE (termin_id, milnik)
);
CREATE INDEX IF NOT EXISTS ix_notifikace_token ON notifikace(token);
CREATE INDEX IF NOT EXISTS ix_notifikace_msgid ON notifikace(resend_message_id);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

const SMLOUVA_COLS = [
  'cislo_smlouvy', 'kategorie', 'smer', 'podtyp', 'protistrana_nazev', 'protistrana_ico',
  'predmet', 'platnost_typ', 'platnost_do', 'platnost_podminka', 'vypovedni_lhuta_mesice',
  'prolongace', 'hodnota', 'hodnota_typ', 'hodnota_popis', 'mena', 'garant_email',
  'spravce_email', 'stav', 'stav_popis', 'drive_url', 'je_placeholder',
];

function b(v) { return v ? 1 : 0; }

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const smlouva = {
    getById(id) { return db.prepare('SELECT * FROM smlouva WHERE id=?').get(id) || null; },
    getByCislo(c) { return db.prepare('SELECT * FROM smlouva WHERE cislo_smlouvy=?').get(c) || null; },
    all() { return db.prepare('SELECT * FROM smlouva ORDER BY je_placeholder, cislo_smlouvy').all(); },
    list({ kategorie, garant, stav, q } = {}) {
      const kde = []; const p = [];
      if (kategorie) { kde.push('kategorie=?'); p.push(kategorie); }
      if (garant) { kde.push('garant_email=?'); p.push(garant); }
      if (stav) { kde.push('stav=?'); p.push(stav); }
      if (q) { kde.push('(protistrana_nazev LIKE ? OR predmet LIKE ?)'); p.push('%' + q + '%', '%' + q + '%'); }
      const w = kde.length ? 'WHERE ' + kde.join(' AND ') : '';
      return db.prepare(`SELECT * FROM smlouva ${w} ORDER BY je_placeholder, cislo_smlouvy`).all(...p);
    },
    proExpozici() {
      return db.prepare(`SELECT kategorie, hodnota, hodnota_typ, mena FROM smlouva
        WHERE stav='aktivni' AND je_placeholder=0 AND hodnota IS NOT NULL`).all();
    },
    create(data, by) {
      const cols = SMLOUVA_COLS.filter((c) => data[c] !== undefined);
      const vals = cols.map((c) => (c === 'je_placeholder' ? b(data[c]) : data[c] ?? null));
      const all = [...cols, 'created_by', 'updated_by'];
      const ph = all.map(() => '?').join(',');
      const info = db.prepare(`INSERT INTO smlouva (${all.join(',')}) VALUES (${ph})`)
        .run(...vals, by || null, by || null);
      return smlouva.getById(Number(info.lastInsertRowid));
    },
    update(id, data, by) {
      const cols = SMLOUVA_COLS.filter((c) => data[c] !== undefined);
      if (!cols.length) return smlouva.getById(id);
      const set = cols.map((c) => `${c}=?`).join(',');
      const vals = cols.map((c) => (c === 'je_placeholder' ? b(data[c]) : data[c] ?? null));
      db.prepare(`UPDATE smlouva SET ${set}, updated_by=?, updated_at=datetime('now') WHERE id=?`)
        .run(...vals, by || null, id);
      return smlouva.getById(id);
    },
    // Idempotentní import: párování na cislo_smlouvy. Vrací { id, zalozeno }.
    upsertDleCisla(data, by) {
      const ex = data.cislo_smlouvy ? smlouva.getByCislo(data.cislo_smlouvy) : null;
      if (ex) { smlouva.update(ex.id, data, by); return { id: ex.id, zalozeno: false }; }
      const s = smlouva.create(data, by);
      return { id: s.id, zalozeno: true };
    },
  };

  const dodatek = {
    listBySmlouva(id) { return db.prepare('SELECT * FROM dodatek WHERE smlouva_id=? ORDER BY datum, id').all(id); },
    create(d) {
      const info = db.prepare(`INSERT INTO dodatek (smlouva_id,cislo,datum,co_meni,drive_url)
        VALUES (?,?,?,?,?)`).run(d.smlouva_id, d.cislo || null, d.datum || null, d.co_meni || null, d.drive_url || null);
      return db.prepare('SELECT * FROM dodatek WHERE id=?').get(Number(info.lastInsertRowid));
    },
  };

  const termin = {
    getById(id) { return db.prepare('SELECT * FROM termin WHERE id=?').get(id) || null; },
    listBySmlouva(id) { return db.prepare('SELECT * FROM termin WHERE smlouva_id=? ORDER BY datum').all(id); },
    create(t) {
      const info = db.prepare(`INSERT INTO termin (smlouva_id,typ,datum,popis,odvozeny,opakovani,stav,snooze_do)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        t.smlouva_id, t.typ, t.datum, t.popis || null, b(t.odvozeny),
        t.opakovani || 'zadne', t.stav || 'ceka', t.snooze_do || null);
      return termin.getById(Number(info.lastInsertRowid));
    },
    oznacVyreseny(id, by, at) {
      db.prepare(`UPDATE termin SET stav='vyreseno', potvrzeno_at=?, potvrzeno_by=?, updated_at=datetime('now') WHERE id=?`)
        .run(at || new Date().toISOString(), by || null, id);
    },
    oznacEskalovany(id) { db.prepare(`UPDATE termin SET stav='eskalovano', updated_at=datetime('now') WHERE id=? AND stav='ceka'`).run(id); },
    snooze(id, doD) { db.prepare(`UPDATE termin SET snooze_do=?, updated_at=datetime('now') WHERE id=?`).run(doD, id); },
    updateDatumOdvozenych(smlouvaId, typ, datum) {
      db.prepare(`UPDATE termin SET datum=?, updated_at=datetime('now')
        WHERE smlouva_id=? AND typ=? AND odvozeny=1 AND stav='ceka'`).run(datum, smlouvaId, typ);
    },
    deaktivujProSmlouvu(smlouvaId) {
      db.prepare(`UPDATE termin SET stav='neaktivni', updated_at=datetime('now')
        WHERE smlouva_id=? AND stav IN ('ceka','eskalovano')`).run(smlouvaId);
    },
    aktivniCekajici(dnes) {
      return db.prepare(`SELECT t.*, s.garant_email, s.spravce_email, s.cislo_smlouvy, s.protistrana_nazev
        FROM termin t JOIN smlouva s ON s.id=t.smlouva_id
        WHERE t.stav='ceka' AND s.stav='aktivni' AND s.je_placeholder=0
          AND (t.snooze_do IS NULL OR t.snooze_do < ?)
        ORDER BY t.datum`).all(dnes);
    },
  };

  const notifikace = {
    odeslaneMilniky(terminId) {
      return db.prepare('SELECT milnik FROM notifikace WHERE termin_id=?').all(terminId).map((r) => r.milnik);
    },
    zapis(n) {
      const konflikt = n.resend
        ? `ON CONFLICT(termin_id,milnik) DO UPDATE SET odeslano_at=datetime('now'),
             resend_message_id=excluded.resend_message_id, komu_email=excluded.komu_email,
             token=excluded.token, token_expires_at=excluded.token_expires_at`
        : `ON CONFLICT(termin_id,milnik) DO NOTHING`;
      db.prepare(`INSERT INTO notifikace (termin_id,milnik,komu_email,resend_message_id,token,token_expires_at)
        VALUES (?,?,?,?,?,?) ${konflikt}`).run(
        n.termin_id, n.milnik, n.komu_email || null, n.resend_message_id || null,
        n.token || null, n.token_expires_at || null);
    },
    historieProTermin(id) { return db.prepare('SELECT * FROM notifikace WHERE termin_id=? ORDER BY odeslano_at').all(id); },
    najdiPodleTokenu(tok) {
      return db.prepare(`SELECT n.*, t.smlouva_id, t.stav AS termin_stav
        FROM notifikace n JOIN termin t ON t.id=n.termin_id WHERE n.token=?`).get(tok) || null;
    },
    oznacTokenPouzity(tok, at) { db.prepare('UPDATE notifikace SET token_used_at=? WHERE token=?').run(at || new Date().toISOString(), tok); },
    aktualizujDoruceni(msgId, stav) {
      const info = db.prepare('UPDATE notifikace SET stav_doruceni=? WHERE resend_message_id=?').run(stav, msgId);
      if (!info.changes) return null;
      return db.prepare('SELECT * FROM notifikace WHERE resend_message_id=?').get(msgId) || null;
    },
    bouncenute() {
      return db.prepare(`SELECT n.*, t.smlouva_id FROM notifikace n JOIN termin t ON t.id=n.termin_id
        WHERE n.stav_doruceni='bounced' ORDER BY n.odeslano_at DESC`).all();
    },
  };

  const meta = {
    get(k) { const r = db.prepare('SELECT v FROM meta WHERE k=?').get(k); return r ? r.v : null; },
    set(k, v) { db.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)); },
  };

  return { db, smlouva, dodatek, termin, notifikace, meta };
}

module.exports = { openDb, SCHEMA };
