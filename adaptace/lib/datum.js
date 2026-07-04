'use strict';
// Práce s kalendářními daty v pražské zóně (řeší off-by-one u deadlinů).
// Pracujeme čistě s YYYY-MM-DD, čas neřešíme.

function todayPrague(now = new Date()) {
  // en-CA dává rovnou formát YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(now);
}

// Přičte/odečte dny k datu YYYY-MM-DD (UTC půlnoc, aby nehrál posun zóny).
function addDays(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString().slice(0, 10);
}

// Kolik dní zbývá od `dnes` do `dateStr` (kladné = v budoucnu, záporné = po termínu).
function daysUntil(dateStr, dnes = todayPrague()) {
  const a = Date.parse(dnes + 'T00:00:00Z');
  const b = Date.parse(dateStr + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

function formatCz(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).split('-');
  return `${Number(d)}. ${Number(m)}. ${y}`;
}

module.exports = { todayPrague, addDays, daysUntil, formatCz };
