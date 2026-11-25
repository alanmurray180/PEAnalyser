// Pure valuation maths. No I/O. Everything is split-adjusted and in the listing currency.
//
// Definitions
//  TTM EPS at date D  = sum of the last four quarterly EPS figures whose *report date* is on or
//                       before D (point-in-time: what the market actually knew on D).
//  NTM EPS at date D  = time-weighted EPS over the 12 months following D, built from quarterly
//                       figures: reported actuals where they exist, consensus estimates for the rest.
//                       For historical D this uses actuals reported *after* D (hindsight), because
//                       neither provider supplies point-in-time consensus history. estShare records
//                       how much of the window came from estimates.
//  ETF EPS            = aggregate look-through earnings of the top holdings, scaled up for coverage
//                       (equivalent to a harmonic-mean PE; loss-makers are included, not dropped).

import { toDay, fromDay, round } from './util.js';

const MAX_FUTURE_QTRS = 8;

function isMonthEnd(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const next = new Date(d.getTime() + 86400000);
  return next.getUTCMonth() !== d.getUTCMonth();
}

/** Next fiscal quarter end: month-end calendars step 3 months; 52/53-week calendars step 13 weeks. */
export function nextQuarterEnd(iso) {
  if (isMonthEnd(iso)) {
    const d = new Date(iso + 'T00:00:00Z');
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 4, 0)).toISOString().slice(0, 10);
  }
  return fromDay(toDay(iso) + 91);
}

const inFiscalYear = (fyEnd) => {
  const F = toDay(fyEnd);
  return (q) => {
    const e = toDay(q.end);
    return e > F - 350 && e <= F + 20;
  };
};

/**
 * Build a contiguous quarterly EPS series: actuals, then up to 8 estimated quarters.
 * Estimated quarters use explicit quarterly consensus where available; otherwise the
 * residual of the fiscal-year consensus (FY estimate less quarters already known) is
 * spread evenly over the unknown quarters of that fiscal year.
 */
export function buildQuarterSeries(fund) {
  if (!fund) return [];
  const byEnd = new Map();
  for (const q of fund.quarters || []) {
    if (!q || !q.end || !Number.isFinite(q.eps)) continue;
    byEnd.set(q.end, { end: q.end, reported: q.reported || fromDay(toDay(q.end) + 45), eps: q.eps, est: false });
  }
  const act = [...byEnd.values()].sort((a, b) => toDay(a.end) - toDay(b.end));
  if (!act.length) return [];

  const fut = [];
  let last = act[act.length - 1].end;
  for (let i = 0; i < MAX_FUTURE_QTRS; i++) {
    last = nextQuarterEnd(last);
    fut.push({ end: last, eps: null, est: true, src: null });
  }

  const qEst = (fund.qEst || []).filter((e) => e && e.end && Number.isFinite(e.eps));
  for (const q of fut) {
    const e = toDay(q.end);
    let best = null;
    for (const c of qEst) {
      const d = Math.abs(toDay(c.end) - e);
      if (d <= 20 && (!best || d < best.d)) best = { d, eps: c.eps };
    }
    if (best) { q.eps = best.eps; q.src = 'quarter'; }
  }

  const fys = (fund.fyEst || []).filter((f) => f && f.end && Number.isFinite(f.eps)).sort((a, b) => toDay(a.end) - toDay(b.end));
  for (const fy of fys) {
    const inFY = inFiscalYear(fy.end);
    const futIn = fut.filter(inFY);
    if (!futIn.length) continue;
    const actIn = act.filter(inFY);
    if (actIn.length + futIn.length !== 4) continue; // calendar misalignment: do not guess
    const unknown = futIn.filter((q) => q.eps === null);
    if (!unknown.length) continue;
    const known = actIn.reduce((s, q) => s + q.eps, 0) + futIn.filter((q) => q.eps !== null).reduce((s, q) => s + q.eps, 0);
    const each = (fy.eps - known) / unknown.length;
    for (const q of unknown) { q.eps = each; q.src = 'fy'; }
  }

  const out = act.slice();
  for (const q of fut) {
    if (q.eps === null) break;
    out.push(q);
  }
  for (let i = 0; i < out.length; i++) out[i].start = i ? out[i - 1].end : fromDay(toDay(out[i].end) - 91);
  return out;
}

/** Point-in-time trailing EPS. */
export function ttmAt(series, date) {
  const D = toDay(date);
  const rep = series.filter((q) => !q.est && toDay(q.reported) <= D);
  if (rep.length < 4) return null;
  const l4 = rep.slice(-4);
  if (toDay(l4[3].end) - toDay(l4[0].end) > 300) return null; // gap in reporting history
  return { eps: l4.reduce((s, q) => s + q.eps, 0), asOf: l4[3].end };
}

/** Time-weighted next-twelve-months EPS. */
export function ntmAt(series, date) {
  const a = toDay(date);
  const b = a + 365;
  let eps = 0, qtrs = 0, cov = 0, estCov = 0;
  for (const q of series) {
    const s = toDay(q.start), e = toDay(q.end), L = e - s;
    if (L <= 0) continue;
    const o = Math.min(e, b) - Math.max(s, a);
    if (o <= 0) continue;
    eps += (q.eps * o) / L;
    qtrs += o / L;
    cov += o;
    if (q.est) estCov += o;
  }
  if (cov < 355 || qtrs <= 0) return null;
  return { eps: (eps * 4) / qtrs, estShare: estCov / cov };
}

// ---------- price history ----------
// rows: [[date, high, low, close], ...] ascending, split-adjusted

export function closeOnOrBefore(rows, date, maxGapDays = 7) {
  if (!rows || !rows.length) return null;
  let lo = 0, hi = rows.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (rows[m][0] <= date) { idx = m; lo = m + 1; } else hi = m - 1;
  }
  if (idx < 0) return null;
  if (toDay(date) - toDay(rows[idx][0]) > maxGapDays) return null;
  return { date: rows[idx][0], price: rows[idx][3] };
}

export function range52w(rows, today) {
  const from = fromDay(toDay(today) - 365);
  let hi = null, lo = null;
  for (const r of rows || []) {
    if (r[0] <= from || r[0] > today) continue;
    if (Number.isFinite(r[1]) && (!hi || r[1] > hi.price)) hi = { date: r[0], price: r[1] };
    if (Number.isFinite(r[2]) && (!lo || r[2] < lo.price)) lo = { date: r[0], price: r[2] };
  }
  return { hi, lo };
}

// ---------- EPS providers per entity ----------

/** EPS function for a single stock. */
export function stockEps(series) {
  return (date) => {
    const t = ttmAt(series, date);
    const f = ntmAt(series, date);
    return { ttm: t ? t.eps : null, ttmAsOf: t ? t.asOf : null, ntm: f ? f.eps : null, estShare: f ? f.estShare : null };
  };
}

/**
 * Look-through EPS for an ETF.
 * holdings: { etfPx, items: [{ symbol, weight (fraction of fund), px }] }
 * seriesBySym: Map symbol -> quarter series
 * Units held per ETF share n_i = w_i * P_etf / P_i (fixed at the holdings snapshot).
 */
export function etfConstituents(holdings, seriesBySym) {
  const out = [];
  if (!holdings || !Number.isFinite(holdings.etfPx) || holdings.etfPx <= 0) return out;
  for (const h of holdings.items || []) {
    const series = seriesBySym.get(h.symbol);
    if (!Number.isFinite(h.weight) || h.weight <= 0 || !Number.isFinite(h.px) || h.px <= 0) continue;
    out.push({ symbol: h.symbol, weight: h.weight, units: (h.weight * holdings.etfPx) / h.px, series: series || [] });
  }
  return out;
}

export function etfEps(cons) {
  return (date) => {
    let et = 0, ct = 0, en = 0, cn = 0, est = 0;
    for (const c of cons) {
      if (!c.series.length) continue;
      const t = ttmAt(c.series, date);
      if (t) { et += c.units * t.eps; ct += c.weight; }
      const f = ntmAt(c.series, date);
      if (f) { en += c.units * f.eps; cn += c.weight; est += c.weight * f.estShare; }
    }
    return {
      ttm: ct > 0 ? et / ct : null,
      ntm: cn > 0 ? en / cn : null,
      covTtm: ct,
      covNtm: cn,
      estShare: cn > 0 ? est / cn : null,
      ttmAsOf: null,
    };
  };
}

// ---------- assembled rows ----------

function point(epsFn, date, price, extra = {}) {
  const e = epsFn(date);
  return {
    ...extra,
    date,
    price: round(price, 4),
    ttm: round(e.ttm, 4),
    ntm: round(e.ntm, 4),
    estShare: round(e.estShare, 3),
    ...(e.covTtm !== undefined ? { covTtm: round(e.covTtm, 3), covNtm: round(e.covNtm, 3) } : {}),
    ...(e.ttmAsOf ? { ttmAsOf: e.ttmAsOf } : {}),
  };
}

/**
 * Compute the dashboard row for one symbol.
 * epsFn(date) -> { ttm, ntm, estShare, covTtm?, covNtm? }
 */
export function computeRow({ symbol, meta, epsFn, rows, events, today }) {
  const warnings = [];
  const last = rows && rows.length ? { date: rows[rows.length - 1][0], price: rows[rows.length - 1][3] } : null;
  const { hi, lo } = range52w(rows, today);
  const now = point(epsFn, today, last ? last.price : null);
  const ev = (events || []).map((e) => {
    const px = closeOnOrBefore(rows, e.date);
    if (!px) return { id: e.date, label: e.label, date: e.date, price: null, ttm: null, ntm: null, missing: true };
    return point(epsFn, px.date, px.price, { id: e.date, label: e.label, tradeDate: px.date });
  });
  if (now.ttm !== null && now.ttm <= 0) warnings.push('Trailing EPS is negative: trailing PE not meaningful.');
  if (now.ntm !== null && now.ntm <= 0) warnings.push('Forward EPS is negative: forward PE not meaningful.');
  if (now.ttm === null) warnings.push('Insufficient reported quarters for trailing EPS.');
  if (now.ntm === null) warnings.push('Insufficient estimates to cover the next 12 months.');
  if (now.covTtm !== undefined && now.covTtm < 0.5) warnings.push(`Look-through coverage only ${(now.covTtm * 100).toFixed(0)}% of fund weight.`);
  return {
    symbol,
    name: meta?.name || symbol,
    type: meta?.type || 'stock',
    currency: meta?.currency || 'USD',
    status: rows && rows.length ? 'ok' : 'pending',
    last,
    now,
    hi52: hi ? point(epsFn, hi.date, hi.price) : null,
    lo52: lo ? point(epsFn, lo.date, lo.price) : null,
    events: ev,
    warnings,
  };
}

/** Weekly PE history for the detail chart. */
export function peHistory(epsFn, rows, fromDate) {
  const out = [];
  let lastWeek = null;
  for (let i = 0; i < (rows || []).length; i++) {
    const r = rows[i];
    if (fromDate && r[0] < fromDate) continue;
    const wk = Math.floor((toDay(r[0]) + 3) / 7); // Thursday-anchored week number
    const isLast = i === rows.length - 1;
    const nextWk = !isLast ? Math.floor((toDay(rows[i + 1][0]) + 3) / 7) : null;
    if (!isLast && nextWk === wk) continue; // keep last trading day of each week
    if (wk === lastWeek) continue;
    lastWeek = wk;
    const e = epsFn(r[0]);
    out.push([r[0], round(r[3], 2), e.ttm > 0 ? round(r[3] / e.ttm, 2) : null, e.ntm > 0 ? round(r[3] / e.ntm, 2) : null]);
  }
  return out;
}

/**
 * Merge a live quote into a stored row: live price, and extend the 52-week extremes
 * if today's intraday range has broken through them.
 */
export function mergeLive(row, quote, today) {
  const r = { ...row };
  if (quote && Number.isFinite(quote.price)) {
    r.price = quote.price;
    r.change = quote.change;
    r.changePct = quote.changePct;
    r.quoteTime = quote.time || null;
    r.quoteSource = quote.source;
    const nowEps = { ttm: row.now?.ttm ?? null, ntm: row.now?.ntm ?? null, estShare: row.now?.estShare ?? null };
    if (Number.isFinite(quote.dayHigh) && (!row.hi52 || quote.dayHigh > row.hi52.price)) {
      r.hi52 = { ...row.now, ...nowEps, date: today, price: quote.dayHigh, live: true };
    }
    if (Number.isFinite(quote.dayLow) && quote.dayLow > 0 && (!row.lo52 || quote.dayLow < row.lo52.price)) {
      r.lo52 = { ...row.now, ...nowEps, date: today, price: quote.dayLow, live: true };
    }
  } else {
    r.price = row.last ? row.last.price : null;
    r.quoteSource = 'last close';
  }
  return r;
}
