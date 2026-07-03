'use strict';
// Datová aritmetika nad kalendářními daty ('YYYY-MM-DD'), nezávislá na
// hodinách/DST. Rozdíl dnů počítáme přes UTC půlnoc, „dnes" bereme
// v zóně Europe/Prague (§8: veškeré výpočty dnů v Europe/Prague).

const ZONE = 'Europe/Prague';

/** Dnešní datum v Europe/Prague jako 'YYYY-MM-DD'. */
function todayPrague(now = new Date()) {
  // en-CA dává rovnou ISO 'YYYY-MM-DD'
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function toUtcMidnight(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Počet celých dní od dneška do cílového data (kladné = v budoucnu). */
function daysUntil(targetStr, todayStr = todayPrague()) {
  return Math.round((toUtcMidnight(targetStr) - toUtcMidnight(todayStr)) / 86400000);
}

/** Přičte n měsíců, přetečení dne v měsíci ořízne na poslední den. */
function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, 1));
  base.setUTCMonth(base.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return isoFrom(base.getUTCFullYear(), base.getUTCMonth() + 1, day);
}

function addByOpakovani(dateStr, opakovani) {
  switch (opakovani) {
    case 'mesicni':   return addMonths(dateStr, 1);
    case 'ctvrtletni':return addMonths(dateStr, 3);
    case 'rocni':     return addMonths(dateStr, 12);
    default:          return null; // 'zadne'
  }
}

function isoFrom(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' -> 'D.M.YYYY' (český formát). */
function formatCz(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d}.${m}.${y}`;
}

/**
 * Rozparsuje český datum z volného textu ('1.10.2027', '15. 11. 2026',
 * '15.11.' bez roku). Vrací { iso, hasYear } nebo null.
 * Bez roku doplní `defaultYear` (kvůli návrhům termínů při importu).
 */
function parseCzDate(text, defaultYear) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})?/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const hasYear = Boolean(m[3]);
  const y = hasYear ? Number(m[3]) : Number(defaultYear);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { iso: isoFrom(y, mo, d), hasYear };
}

module.exports = {
  ZONE, todayPrague, daysUntil, addMonths, addByOpakovani, formatCz, parseCzDate,
};
