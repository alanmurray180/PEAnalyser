// Alpha Vantage (primary) and Financial Modeling Prep (fallback) adapters.
// Every function returns data in the internal shapes used by calc.js.

import { num, sleep, canonSymbol, round } from './util.js';

export class RateLimitError extends Error {}
export class PremiumError extends Error {}

/** Shared call budget + throttle for one worker invocation. */
export class Budget {
  constructor(avCalls = 60, avPerMin = 70) {
    this.left = avCalls;
    this.used = 0;
    this.fmpUsed = 0;
    this.gapMs = Math.ceil(60000 / Math.max(1, avPerMin));
    this.lastAv = 0;
  }
  canSpend(n = 1) { return this.left >= n; }
  async spendAv() {
    if (this.left <= 0) throw new RateLimitError('Alpha Vantage call budget for this run exhausted');
    const wait = this.lastAv + this.gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastAv = Date.now();
    this.left--;
    this.used++;
  }
}

// ---------------- Alpha Vantage ----------------

const avSym = (s) => canonSymbol(s); // AV accepts BRK-B style
const AV_URL = 'https://www.alphavantage.co/query';

export async function av(env, budget, params) {
  if (!env.AV_API_KEY) throw new Error('AV_API_KEY not configured');
  await budget.spendAv();
  const u = new URL(AV_URL);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  u.searchParams.set('apikey', env.AV_API_KEY);
  const res = await fetch(u.toString(), { headers: { 'User-Agent': 'pe-analyser-worker' } });
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
  const j = await res.json();
  const msg = j['Error Message'] || j.Note || j.Information;
  if (msg) {
    if (/frequency|rate limit|per minute|per day|spreading out/i.test(msg)) throw new RateLimitError(`Alpha Vantage: ${msg}`);
    if (/premium/i.test(msg)) throw new PremiumError(`Alpha Vantage: ${msg}`);
    throw new Error(`Alpha Vantage: ${msg}`);
  }
  return j;
}

export async function avEarnings(env, budget, symbol) {
  const j = await av(env, budget, { function: 'EARNINGS', symbol: avSym(symbol) });
  const quarters = (j.quarterlyEarnings || [])
    .map((q) => ({ end: q.fiscalDateEnding, reported: q.reportedDate || null, eps: num(q.reportedEPS) }))
    .filter((q) => q.end && q.eps !== null);
  if (!quarters.length) throw new Error('Alpha Vantage EARNINGS returned no quarterly data');
  return quarters;
}

export async function avEstimates(env, budget, symbol) {
  const j = await av(env, budget, { function: 'EARNINGS_ESTIMATES', symbol: avSym(symbol) });
  const qEst = [], fyEst = [];
  for (const e of j.estimates || []) {
    const h = String(e.horizon || '').toLowerCase();
    const eps = num(e.eps_estimate_average);
    if (!e.date || eps === null || h.includes('historical')) continue;
    const rec = { end: e.date, eps, analysts: num(e.eps_estimate_analyst_count) };
    if (h.includes('quarter')) qEst.push(rec);
    else if (h.includes('year')) fyEst.push(rec);
  }
  if (!qEst.length && !fyEst.length) throw new Error('Alpha Vantage EARNINGS_ESTIMATES returned no estimates');
  return { qEst, fyEst };
}

/** Daily history, split-adjusted only (not dividend-adjusted), from the raw close and split coefficients. */
export async function avHistory(env, budget, symbol, fromDate) {
  const j = await av(env, budget, {
    function: 'TIME_SERIES_DAILY_ADJUSTED',
    symbol: avSym(symbol),
    outputsize: 'full',
    entitlement: env.AV_ENTITLEMENT || undefined,
  });
  const ts = j['Time Series (Daily)'];
  if (!ts) throw new Error('Alpha Vantage returned no daily series');
  const dates = Object.keys(ts).sort().reverse();
  const rows = [];
  let factor = 1;
  for (const d of dates) {
    const r = ts[d];
    const h = num(r['2. high']), l = num(r['3. low']), c = num(r['4. close']);
    if (d >= fromDate && c !== null) rows.push([d, round(h / factor, 4), round(l / factor, 4), round(c / factor, 4)]);
    const sc = num(r['8. split coefficient']);
    if (sc && sc > 0 && sc !== 1) factor *= sc;
    if (d < fromDate) break;
  }
  return rows.reverse();
}

export async function avOverview(env, budget, symbol) {
  const j = await av(env, budget, { function: 'OVERVIEW', symbol: avSym(symbol) });
  if (!j || !j.Symbol) return null;
  return { name: j.Name || symbol, type: /etf/i.test(j.AssetType || '') ? 'etf' : 'stock', currency: j.Currency || 'USD', fyEnd: j.FiscalYearEnd || null };
}

export async function avEtfHoldings(env, budget, symbol) {
  const j = await av(env, budget, { function: 'ETF_PROFILE', symbol: avSym(symbol) });
  const items = (j.holdings || [])
    .map((h) => ({ symbol: canonSymbol(h.symbol), name: h.description || '', weight: num(h.weight) }))
    .filter((h) => h.symbol && h.symbol !== 'N-A' && h.weight !== null && h.weight > 0);
  if (!items.length) throw new Error('Alpha Vantage ETF_PROFILE returned no holdings');
  // AV reports weights as fractions (0.0712); guard against percentages
  const total = items.reduce((s, h) => s + h.weight, 0);
  if (total > 1.5) items.forEach((h) => (h.weight /= 100));
  return items;
}

/** Up to 100 symbols per call; premium endpoint. */
export async function avBulkQuotes(env, budget, symbols) {
  const out = new Map();
  for (let i = 0; i < symbols.length; i += 100) {
    const chunk = symbols.slice(i, i + 100);
    const j = await av(env, budget, { function: 'REALTIME_BULK_QUOTES', symbol: chunk.map(avSym).join(','), entitlement: env.AV_ENTITLEMENT || undefined });
    for (const q of j.data || []) {
      const price = num(q.close);
      if (price === null) continue;
      out.set(canonSymbol(q.symbol), {
        price,
        prevClose: num(q.previous_close),
        change: num(q.change),
        changePct: num(q.change_percent),
        dayHigh: num(q.high),
        dayLow: num(q.low),
        time: q.timestamp || null,
        source: 'Alpha Vantage bulk',
      });
    }
  }
  return out;
}

export async function avGlobalQuote(env, budget, symbol) {
  const j = await av(env, budget, { function: 'GLOBAL_QUOTE', symbol: avSym(symbol), entitlement: env.AV_ENTITLEMENT || undefined });
  const q = j['Global Quote'] || {};
  const price = num(q['05. price']);
  if (price === null) return null;
  return {
    price,
    prevClose: num(q['08. previous close']),
    change: num(q['09. change']),
    changePct: num(q['10. change percent']),
    dayHigh: num(q['03. high']),
    dayLow: num(q['04. low']),
    time: q['07. latest trading day'] || null,
    source: 'Alpha Vantage',
  };
}

// ---------------- FMP ----------------

const fmpSym = (s) => canonSymbol(s);
const FMP_URL = 'https://financialmodelingprep.com/stable/';

export async function fmp(env, budget, path, params = {}) {
  if (!env.FMP_API_KEY) throw new Error('FMP_API_KEY not configured');
  const u = new URL(path, FMP_URL);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  u.searchParams.set('apikey', env.FMP_API_KEY);
  budget.fmpUsed++;
  const res = await fetch(u.toString(), { headers: { 'User-Agent': 'pe-analyser-worker' } });
  if (res.status === 402 || res.status === 403) throw new PremiumError(`FMP ${path}: not available on current plan (${res.status})`);
  if (res.status === 429) throw new RateLimitError('FMP rate limit');
  if (!res.ok) throw new Error(`FMP ${path}: HTTP ${res.status}`);
  const j = await res.json();
  if (j && !Array.isArray(j) && (j['Error Message'] || j.error)) {
    const m = j['Error Message'] || j.error;
    if (/premium|subscription|upgrade|plan/i.test(m)) throw new PremiumError(`FMP ${path}: ${m}`);
    throw new Error(`FMP ${path}: ${m}`);
  }
  return j;
}

/** GAAP diluted EPS from quarterly income statements; filing date used as the report date. */
export async function fmpEarnings(env, budget, symbol) {
  const j = await fmp(env, budget, 'income-statement', { symbol: fmpSym(symbol), period: 'quarter', limit: 40 });
  const quarters = (j || [])
    .map((q) => ({ end: q.date, reported: (q.filingDate || q.acceptedDate || '').slice(0, 10) || null, eps: num(q.epsDiluted ?? q.eps) }))
    .filter((q) => q.end && q.eps !== null);
  if (!quarters.length) throw new Error('FMP income-statement returned no quarters');
  return quarters;
}

export async function fmpEstimates(env, budget, symbol) {
  const j = await fmp(env, budget, 'analyst-estimates', { symbol: fmpSym(symbol), period: 'annual', page: 0, limit: 10 });
  const fyEst = (j || []).map((e) => ({ end: e.date, eps: num(e.epsAvg), analysts: num(e.numAnalystsEps) })).filter((e) => e.end && e.eps !== null);
  if (!fyEst.length) throw new Error('FMP analyst-estimates returned nothing');
  return { qEst: [], fyEst };
}

/** FMP 'full' EOD history is split-adjusted, not dividend-adjusted (verified on NVDA's 2024 split). */
export async function fmpHistory(env, budget, symbol, fromDate) {
  const j = await fmp(env, budget, 'historical-price-eod/full', { symbol: fmpSym(symbol), from: fromDate });
  const arr = Array.isArray(j) ? j : j?.historical || [];
  const rows = arr
    .map((r) => [r.date, num(r.high), num(r.low), num(r.close)])
    .filter((r) => r[0] && r[3] !== null)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (!rows.length) throw new Error('FMP history returned nothing');
  return rows;
}

export async function fmpProfile(env, budget, symbol) {
  const j = await fmp(env, budget, 'profile', { symbol: fmpSym(symbol) });
  const p = Array.isArray(j) ? j[0] : null;
  if (!p) return null;
  return { name: p.companyName || symbol, type: p.isEtf || p.isFund ? 'etf' : 'stock', currency: p.currency || 'USD' };
}

export async function fmpEtfHoldings(env, budget, symbol) {
  const j = await fmp(env, budget, 'etf/holdings', { symbol: fmpSym(symbol) });
  const items = (j || [])
    .map((h) => ({ symbol: canonSymbol(h.asset), name: h.name || '', weight: num(h.weightPercentage) }))
    .filter((h) => h.symbol && h.weight !== null && h.weight > 0)
    .map((h) => ({ ...h, weight: h.weight / 100 }));
  if (!items.length) throw new Error('FMP etf/holdings returned nothing');
  return items;
}

function fmpQuoteRec(q) {
  return {
    price: num(q.price),
    prevClose: num(q.previousClose),
    change: num(q.change),
    changePct: num(q.changePercentage ?? q.changesPercentage),
    dayHigh: num(q.dayHigh),
    dayLow: num(q.dayLow),
    time: q.timestamp ? new Date(q.timestamp * 1000).toISOString() : null,
    source: 'FMP',
    name: q.name,
  };
}

export async function fmpBatchQuotes(env, budget, symbols) {
  const out = new Map();
  for (let i = 0; i < symbols.length; i += 100) {
    const chunk = symbols.slice(i, i + 100);
    const j = await fmp(env, budget, 'batch-quote', { symbols: chunk.map(fmpSym).join(',') });
    for (const q of j || []) if (num(q.price) !== null) out.set(canonSymbol(q.symbol), fmpQuoteRec(q));
  }
  return out;
}

export async function fmpQuote(env, budget, symbol) {
  const j = await fmp(env, budget, 'quote', { symbol: fmpSym(symbol) });
  const q = Array.isArray(j) ? j[0] : null;
  return q && num(q.price) !== null ? fmpQuoteRec(q) : null;
}

// ---------------- composite fetchers with fallback ----------------

async function firstOk(attempts) {
  const errors = [];
  for (const [label, fn] of attempts) {
    try {
      const v = await fn();
      if (v) return { value: v, source: label, errors };
    } catch (e) {
      if (e instanceof RateLimitError && label.startsWith('av')) throw e;
      errors.push(`${label}: ${e.message}`);
    }
  }
  const err = new Error(errors.join(' | ') || 'no provider returned data');
  err.errors = errors;
  throw err;
}

export async function fetchFundamentals(env, budget, symbol) {
  const act = await firstOk([
    ['av', () => avEarnings(env, budget, symbol)],
    ['fmp', () => fmpEarnings(env, budget, symbol)],
  ]);
  let est = { qEst: [], fyEst: [] }, estSource = null, estErrors = [];
  try {
    const r = await firstOk([
      ['av', () => avEstimates(env, budget, symbol)],
      ['fmp', () => fmpEstimates(env, budget, symbol)],
    ]);
    est = r.value; estSource = r.source; estErrors = r.errors;
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    estErrors = e.errors || [e.message];
  }
  const basis = {
    actual: act.source === 'av' ? 'Alpha Vantage reported EPS (Street basis)' : 'FMP GAAP diluted EPS',
    estimate: estSource === 'av' ? 'Alpha Vantage consensus' : estSource === 'fmp' ? 'FMP consensus' : 'none',
    mixed: estSource !== null && act.source !== estSource,
  };
  return { symbol, fetchedAt: Date.now(), quarters: act.value, qEst: est.qEst, fyEst: est.fyEst, basis, notes: [...act.errors, ...estErrors] };
}

export async function fetchHistory(env, budget, symbol, fromDate) {
  const r = await firstOk([
    ['av', () => avHistory(env, budget, symbol, fromDate)],
    ['fmp', () => fmpHistory(env, budget, symbol, fromDate)],
  ]);
  return { symbol, fetchedAt: Date.now(), from: fromDate, source: r.source, rows: r.value };
}

export async function fetchMeta(env, budget, symbol) {
  const r = await firstOk([
    ['fmp', () => fmpProfile(env, budget, symbol)],
    ['av', () => avOverview(env, budget, symbol)],
    ['av-etf', async () => ((await avEtfHoldings(env, budget, symbol)).length ? { name: symbol, type: 'etf', currency: 'USD' } : null)],
  ]);
  return r.value;
}

export async function fetchHoldings(env, budget, symbol, topN) {
  const r = await firstOk([
    ['av', () => avEtfHoldings(env, budget, symbol)],
    ['fmp', () => fmpEtfHoldings(env, budget, symbol)],
  ]);
  const sorted = r.value.sort((a, b) => b.weight - a.weight);
  const merged = new Map();
  for (const h of sorted) {
    const prev = merged.get(h.symbol);
    if (prev) prev.weight += h.weight; else merged.set(h.symbol, { ...h });
  }
  return { source: r.source, items: [...merged.values()].slice(0, topN), totalListed: sorted.length };
}

/** Quotes for many symbols, cheapest route first. Returns Map symbol -> quote. */
export async function fetchQuotes(env, budget, symbols, { perSymbolCap = 40 } = {}) {
  const order = String(env.QUOTE_PROVIDERS || 'av_bulk,fmp_batch,fmp,av').split(',').map((s) => s.trim());
  const out = new Map();
  const missing = () => symbols.filter((s) => !out.has(s));
  const notes = [];
  for (const p of order) {
    const need = missing();
    if (!need.length) break;
    try {
      if (p === 'av_bulk' && env.AV_API_KEY) (await avBulkQuotes(env, budget, need)).forEach((v, k) => out.set(k, v));
      else if (p === 'fmp_batch' && env.FMP_API_KEY) (await fmpBatchQuotes(env, budget, need)).forEach((v, k) => out.set(k, v));
      else if (p === 'fmp' && env.FMP_API_KEY) {
        for (const s of need.slice(0, perSymbolCap)) {
          const q = await fmpQuote(env, budget, s).catch(() => null);
          if (q) out.set(s, q);
        }
      } else if (p === 'av' && env.AV_API_KEY) {
        for (const s of need.slice(0, perSymbolCap)) {
          if (!budget.canSpend()) break;
          const q = await avGlobalQuote(env, budget, s).catch(() => null);
          if (q) out.set(s, q);
        }
      }
    } catch (e) {
      notes.push(`${p}: ${e.message}`);
    }
  }
  out.notes = notes;
  return out;
}
