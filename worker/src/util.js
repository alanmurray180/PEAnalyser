export const DAY_MS = 86400000;

export const toDay = (s) => Math.floor(Date.parse(String(s).slice(0, 10) + 'T00:00:00Z') / DAY_MS);
export const fromDay = (d) => new Date(d * DAY_MS).toISOString().slice(0, 10);
export const todayISO = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const addDays = (s, n) => fromDay(toDay(s) + n);

/** Parse provider numbers ("None", "-", "", "1.2%", null) to a finite number or null. */
export function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/%$/, '').replace(/,/g, '');
  if (s === '' || s === '-' || /^none$/i.test(s) || /^n\/?a$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export const round = (x, dp = 4) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Canonical ticker: upper case, share-class separator as '-' (BRK.B / BRK/B -> BRK-B). */
export function canonSymbol(s) {
  return String(s || '').trim().toUpperCase().replace(/[./]/g, '-');
}

export const isoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
