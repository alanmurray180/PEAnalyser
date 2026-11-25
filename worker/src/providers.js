// Alpha Vantage (primary) and Financial Modeling Prep (fallback) adapters.
// Every function returns data in the internal shapes used by calc.js.

import { num, sleep, canonSymbol, round } from './util.js';

export class RateLimitError extends Error {}
export class PremiumError extends Error {}
/** AV says the key is a free key: every further call this run would fail the same way. */
export class FreeKeyError extends RateLimitError {}

/**
 * Classify an Alpha Vantage "Information"/"Note"/"Error Message" text. Order matters: plan-feature
 * messages mention "requests per minute" too, and must not be read as rate limits.
 */
export function classifyAvMessage(msg) {
  const m = String(msg || '');
  if (/standard api (call )?(rate )?limit|25 (api )?requests per day|requests per day/i.test(m)) return 'free-key';
  if (/premium endpoint|is a premium|premium (feature|function|data)|entitlement|realtime|real-time|delayed|subscribe to (a|the|any)/i.test(m)) return 'plan';
  if (/spreading out|per second|call volume|frequency|rate limit|too many/i.test(m)) return 'rate';
  if (/invalid api call|invalid api key|apikey is invalid/i.test(m)) return 'invalid';
  return 'other';
}

export const avKey = (env) => String(env.AV_API_KEY || '').trim();

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
  const key = avKey(env);
  if (!key) throw new Error('AV_API_KEY not configured');
  await budget.spendAv();
  const u = new URL(AV_URL);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  u.searchParams.set('apikey', key);
  const res = await fetch(u.toString(), { headers: { 'User-Agent': 'pe-analyser-worker' } });
  if (res.status === 429) throw new RateLimitError('Alpha Vantage HTTP 429');
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
  const j = await res.json();
  const msg = j['Error Message'] || j.Note || j.Information;
  if (msg) {
    const kind = classifyAvMessage(msg);
    const text = `Alpha Vantage (${params.function}): ${msg}`;
    if (kind === 'free-key') throw new FreeKeyError(`Alpha Vantage is treating the API key as a FREE key (25 calls/day). Check the AV_API_KEY secret matches your premium key exactly. ${text}`);
    if (kind === 'rate') throw new RateLimitError(text);
    if (kind === 'plan') throw new PremiumError(text);
    throw new Error(text);
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
export async function avHistory(env, budget, symbol, fromDate, compact = false) {
  const j = await av(env, budget, {
    function: 'TIME_SERIES_DAILY_ADJUSTED',
    symbol: avSym(symbol),
    outputsize: compact ? 'compact' : 'full',
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

// Plan capabilities learned at runtime (per isolate), so page polls don't keep spending calls on
// features the plan lacks. Re-tested every 6 hours.
const caps = { bulkOffUntil: 0, entitlementOffUntil: 0 };
const CAP_RETRY_MS = 6 * 3600000;
const entitlement = (env) => (env.AV_ENTITLEMENT && Date.now() > caps.entitlementOffUntil ? env.AV_ENTITLEMENT : undefined);

async function avWithEntitlement(env, budget, params) {
  const ent = entitlement(env);
  try {
    return await av(env, budget, { ...params, entitlement: ent });
  } catch (e) {
    if (ent && e instanceof PremiumError) {
      caps.entitlementOffUntil = Date.now() + CAP_RETRY_MS; // plan lacks it: use the default feed
      return av(env, budget, params);
    }
    throw e;
  }
}

/** Up to 100 symbols per call; needs AV's higher premium tiers. */
export async function avBulkQuotes(env, budget, symbols) {
  const out = new Map();
  if (Date.now() < caps.bulkOffUntil) throw new PremiumError('REALTIME_BULK_QUOTES not on this plan (cached)');
  for (let i = 0; i < symbols.length; i += 100) {
    const chunk = symbols.slice(i, i + 100);
    let j;
    try {
      j = await avWithEntitlement(env, budget, { function: 'REALTIME_BULK_QUOTES', symbol: chunk.map(avSym).join(',') });
    } catch (e) {
      if (e instanceof PremiumError) caps.bulkOffUntil = Date.now() + CAP_RETRY_MS;
      throw e;
    }
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
  const j = await avWithEntitlement(env, budget, { function: 'GLOBAL_QUOTE', symbol: avSym(symbol) });
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

/** Raw probe of the key and plan features, for the dashboard's Data status panel. */
export async function avDiagnose(env) {
  const key = avKey(env);
  const raw = String(env.AV_API_KEY || '');
  const out = {
    key: { set: !!key, length: key.length, last4: key.slice(-4), hadWhitespace: raw !== key },
    probes: [],
  };
  const probe = async (label, params) => {
    const u = new URL(AV_URL);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('apikey', key);
    try {
      const res = await fetch(u.toString());
      const j = await res.json().catch(() => ({}));
      const msg = j['Error Message'] || j.Note || j.Information || null;
      out.probes.push({ label, http: res.status, ok: !msg, kind: msg ? classifyAvMessage(msg) : 'ok', message: msg ? String(msg).slice(0, 400) : null });
    } catch (e) {
      out.probes.push({ label, ok: false, kind: 'network', message: e.message });
    }
  };
  await probe('Earnings (EARNINGS)', { function: 'EARNINGS', symbol: 'IBM' });
  await probe('Estimates (EARNINGS_ESTIMATES)', { function: 'EARNINGS_ESTIMATES', symbol: 'IBM' });
  await probe('Daily history (TIME_SERIES_DAILY_ADJUSTED)', { function: 'TIME_SERIES_DAILY_ADJUSTED', symbol: 'IBM', outputsize: 'compact' });
  await probe('ETF holdings (ETF_PROFILE)', { function: 'ETF_PROFILE', symbol: 'QQQ' });
  await probe('Quote (GLOBAL_QUOTE)', { function: 'GLOBAL_QUOTE', symbol: 'IBM' });
  if (env.AV_ENTITLEMENT) await probe(`Quote with entitlement=${env.AV_ENTITLEMENT}`, { function: 'GLOBAL_QUOTE', symbol: 'IBM', entitlement: env.AV_ENTITLEMENT });
  await probe('Bulk quotes (REALTIME_BULK_QUOTES)', { function: 'REALTIME_BULK_QUOTES', symbol: 'IBM,MSFT' });
  const kinds = out.probes.map((p) => p.kind);
  out.verdict = kinds.includes('free-key')
    ? 'Alpha Vantage is treating this key as a FREE key. The AV_API_KEY secret in Cloudflare does not match your premium key (or the subscription is not active on it).'
    : kinds.includes('rate')
      ? 'Rate-limited right now. Something else may be using the same key (another app or dashboard), or the plan limit is lower than AV_CALLS_PER_MIN.'
      : kinds.slice(0, 4).every((k) => k === 'ok')
        ? 'Key is recognised and the core endpoints work.' + (kinds.includes('plan') ? ' Some quote features are not on this plan; the Worker falls back automatically.' : '')
        : 'See the individual results below.';
  return out;
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

/**
 * Daily history. With a previous snapshot, fetch only the recent window (AV compact = 100 days) and
 * append it; if the overlap disagrees (a new split re-based old prices), fall back to a full refetch.
 */
export async function fetchHistory(env, budget, symbol, fromDate, prev = null) {
  const prevRows = prev?.rows || [];
  if (prevRows.length > 20) {
    const lastPrev = prevRows[prevRows.length - 1][0];
    const ageDays = (Date.now() - Date.parse(lastPrev + 'T00:00:00Z')) / 864e5;
    if (ageDays < 120) {
      try {
        const r = await firstOk([
          ['av', () => avHistory(env, budget, symbol, '1900-01-01', true)],
          ['fmp', () => fmpHistory(env, budget, symbol, new Date(Date.now() - 150 * 864e5).toISOString().slice(0, 10))],
        ]);
        const recent = r.value;
        const prevClose = new Map(prevRows.map((x) => [x[0], x[3]]));
        const overlap = recent.filter((x) => prevClose.has(x[0]));
        const consistent = overlap.length >= 3 && overlap.every((x) => Math.abs(x[3] / prevClose.get(x[0]) - 1) < 0.005);
        if (consistent && recent.length) {
          const firstNew = recent[0][0];
          const rows = prevRows.filter((x) => x[0] < firstNew).concat(recent);
          return { symbol, fetchedAt: Date.now(), from: fromDate, source: r.source, rows, mode: 'incremental' };
        }
      } catch (e) {
        if (e instanceof RateLimitError) throw e;
      }
    }
  }
  const r = await firstOk([
    ['av', () => avHistory(env, budget, symbol, fromDate)],
    ['fmp', () => fmpHistory(env, budget, symbol, fromDate)],
  ]);
  return { symbol, fetchedAt: Date.now(), from: fromDate, source: r.source, rows: r.value, mode: 'full' };
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
