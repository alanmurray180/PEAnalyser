// KV persistence, refresh scheduling and assembly of the dashboard snapshot.
//
// KV keys
//   cfg            { version, basket:[{symbol,type?}], events:[{date,label}] }
//   state          { syms:{SYM:{meta,fundAt,histAt,histFrom,etfAt,errors}}, baseAt, cfgVersion, lastRun }
//   fund:SYM       normalised earnings actuals + estimates
//   hist:SYM       split-adjusted daily [date,high,low,close]
//   etf:SYM        top holdings with weights and prices at snapshot
//   base           precomputed dashboard rows (prices merged live at request time)

import { DEFAULT_BASKET, DEFAULT_EVENTS } from './defaults.js';
import { Budget, RateLimitError, fetchFundamentals, fetchHistory, fetchMeta, fetchHoldings, fetchQuotes } from './providers.js';
import { buildQuarterSeries, stockEps, etfConstituents, etfEps, computeRow, peHistory } from './calc.js';
import { todayISO, addDays, canonSymbol } from './util.js';

const H = 3600000;
const ERROR_BACKOFF_MS = 6 * H;

export const cfgNum = (env, k, d) => {
  const n = Number(env[k]);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export async function kvGet(env, key) {
  return env.PE_KV.get(key, 'json');
}
export async function kvPut(env, key, val) {
  return env.PE_KV.put(key, JSON.stringify(val));
}

export async function loadConfig(env) {
  const c = await kvGet(env, 'cfg');
  if (c && Array.isArray(c.basket)) return c;
  return { version: 1, basket: DEFAULT_BASKET.map((b) => ({ ...b })), events: DEFAULT_EVENTS.map((e) => ({ ...e })) };
}

export async function saveConfig(env, cfg) {
  cfg.version = (cfg.version || 0) + 1;
  cfg.events.sort((a, b) => (a.date < b.date ? -1 : 1));
  await kvPut(env, 'cfg', cfg);
  return cfg;
}

export async function loadState(env) {
  return (await kvGet(env, 'state')) || { syms: {}, baseAt: 0, cfgVersion: 0 };
}

export function histStart(env, cfg, today) {
  const base = env.HIST_START || '2019-01-01';
  const evMin = cfg.events.reduce((m, e) => (e.date < m ? e.date : m), base);
  const yearAgo = addDays(today, -400);
  return [base, addDays(evMin, -10), yearAgo].sort()[0];
}

const entityType = (b, st) => b.type || st?.meta?.type || 'stock';

async function loadHoldingsMap(env, cfg, state) {
  const m = new Map();
  for (const b of cfg.basket) {
    if (entityType(b, state.syms[b.symbol]) !== 'etf') continue;
    const h = await kvGet(env, `etf:${b.symbol}`);
    if (h) m.set(b.symbol, h);
  }
  return m;
}

function recentError(st, kind, now) {
  const e = st?.errors?.[kind];
  return e && now - e.at < ERROR_BACKOFF_MS;
}

/** Decide what needs fetching. Missing data first, then stalest. */
export function planTasks(env, cfg, state, holdingsMap, now, force = new Set()) {
  const fundTtl = cfgNum(env, 'FUND_TTL_HOURS', 24) * H;
  const histTtl = cfgNum(env, 'HIST_TTL_HOURS', 12) * H;
  const etfTtl = cfgNum(env, 'ETF_TTL_DAYS', 7) * 24 * H;
  const start = histStart(env, cfg, todayISO(now));
  const tasks = [];
  const add = (sym, kind, at, ttl, cost) => {
    const st = state.syms[sym];
    const forced = force.has(sym);
    if (!forced && recentError(st, kind, now)) return;
    const age = at ? now - at : Infinity;
    if (!forced && age < ttl) return;
    tasks.push({ sym, kind, cost, pri: at ? 1 : 0, age: forced ? Infinity : age });
  };
  const constituents = new Set();
  for (const b of cfg.basket) {
    const st = state.syms[b.symbol] || {};
    if (!st.meta) add(b.symbol, 'meta', 0, 0, 1);
    const type = entityType(b, st);
    const histStale = st.histFrom && st.histFrom > start ? 0 : st.histAt;
    add(b.symbol, 'hist', histStale, histTtl, 1);
    if (type === 'etf') {
      add(b.symbol, 'etf', st.etfAt, etfTtl, 2);
      for (const h of holdingsMap.get(b.symbol)?.items || []) constituents.add(h.symbol);
    } else {
      add(b.symbol, 'fund', st.fundAt, fundTtl, 2);
    }
  }
  const basketSyms = new Set(cfg.basket.map((b) => b.symbol));
  for (const c of constituents) {
    if (basketSyms.has(c) && entityType(cfg.basket.find((b) => b.symbol === c), state.syms[c]) === 'stock') continue;
    add(c, 'fund', state.syms[c]?.fundAt, fundTtl, 2);
  }
  // meta must precede everything else for the same symbol (type detection)
  const order = { meta: 0, etf: 1, hist: 2, fund: 3 };
  const ageCmp = (a, b) => (a.age === b.age ? 0 : b.age > a.age ? 1 : -1);
  tasks.sort((a, b) => (a.kind === 'meta') - (b.kind === 'meta') ? (b.kind === 'meta') - (a.kind === 'meta') : a.pri - b.pri || ageCmp(a, b) || order[a.kind] - order[b.kind]);
  return { tasks, start };
}

async function runTask(env, budget, task, cfg, state, start) {
  const st = (state.syms[task.sym] ||= {});
  const b = cfg.basket.find((x) => x.symbol === task.sym);
  if (b && task.kind !== 'meta' && task.kind !== 'hist') {
    // type may have been detected earlier in this run
    const t = entityType(b, st);
    if ((t === 'etf' && task.kind === 'fund') || (t === 'stock' && task.kind === 'etf')) return false;
  }
  const topN = cfgNum(env, 'ETF_TOP_N', 50);
  switch (task.kind) {
    case 'meta': {
      const meta = await fetchMeta(env, budget, task.sym);
      const b = cfg.basket.find((x) => x.symbol === task.sym);
      st.meta = { ...meta, type: b?.type || meta.type };
      return;
    }
    case 'fund': {
      const f = await fetchFundamentals(env, budget, task.sym);
      await kvPut(env, `fund:${task.sym}`, f);
      st.fundAt = Date.now();
      return;
    }
    case 'hist': {
      const prev = st.histFrom && st.histFrom <= start ? await kvGet(env, `hist:${task.sym}`) : null;
      const h = await fetchHistory(env, budget, task.sym, start, prev);
      await kvPut(env, `hist:${task.sym}`, h);
      st.histAt = Date.now();
      st.histFrom = start;
      return;
    }
    case 'etf': {
      const h = await fetchHoldings(env, budget, task.sym, topN);
      const syms = [task.sym, ...h.items.map((i) => i.symbol)];
      const quotes = await fetchQuotes(env, budget, syms, { perSymbolCap: topN + 1 });
      const etfQ = quotes.get(task.sym);
      if (!etfQ) throw new Error(`no price for ${task.sym} at holdings snapshot`);
      const items = h.items.map((i) => ({ ...i, px: quotes.get(i.symbol)?.price ?? null }));
      await kvPut(env, `etf:${task.sym}`, { symbol: task.sym, fetchedAt: Date.now(), source: h.source, etfPx: etfQ.price, items, totalListed: h.totalListed });
      st.etfAt = Date.now();
      return;
    }
  }
}

/**
 * One refresh cycle. Cloudflare stops background work after ~30 s, so the cycle is time-boxed,
 * checkpoints state after every task (progress survives a cut-off), and re-plans as it goes
 * (types and ETF holdings discovered mid-run create new work).
 */
export async function runRefresh(env, { avCalls, maxMs, force = [] } = {}) {
  const t0 = Date.now();
  const limitMs = maxMs ?? cfgNum(env, 'RUN_SECONDS', 20) * 1000;
  const lock = await kvGet(env, 'lock');
  if (lock && t0 - lock.at < limitMs + 15000 && !force.length) return { skipped: 'another run in progress' };
  await env.PE_KV.put('lock', JSON.stringify({ at: t0 }), { expirationTtl: 60 });

  const cfg = await loadConfig(env);
  const state = await loadState(env);
  const budget = new Budget(avCalls ?? cfgNum(env, 'AV_CALLS_PER_RUN', 60), cfgNum(env, 'AV_CALLS_PER_MIN', 70));
  const forced = new Set(force.map(canonSymbol));
  const attempted = new Set();
  const log = { done: 0, failed: 0, stoppedBy: null, errors: [] };
  let remaining = 0;
  let changed = false;
  const checkpoint = async () => {
    state.lastRun = { at: t0, ms: Date.now() - t0, avCalls: budget.used, fmpCalls: budget.fmpUsed, ...log, remaining };
    try { await kvPut(env, 'state', state); } catch { /* KV per-key write rate; next checkpoint will catch up */ }
  };

  while (true) {
    if (Date.now() - t0 > limitMs) { log.stoppedBy = 'time'; break; }
    const holdingsMap = await loadHoldingsMap(env, cfg, state);
    const { tasks, start } = planTasks(env, cfg, state, holdingsMap, Date.now(), forced);
    const todo = tasks.filter((t) => !attempted.has(t.sym + ':' + t.kind));
    remaining = todo.length;
    const task = todo.find((t) => {
      const st = state.syms[t.sym];
      // wait for type detection on basket symbols without an explicit type
      return t.kind === 'meta' || st?.meta || st?.errors?.meta || !cfg.basket.some((b) => b.symbol === t.sym && !b.type);
    });
    if (!task) break;
    if (!budget.canSpend(task.cost)) { log.stoppedBy = 'budget'; break; }
    attempted.add(task.sym + ':' + task.kind);
    try {
      const r = await runTask(env, budget, task, cfg, state, start);
      if (r !== false) {
        const st = state.syms[task.sym];
        if (st.errors) delete st.errors[task.kind];
        log.done++;
        changed = true;
      }
    } catch (e) {
      if (e instanceof RateLimitError) { log.stoppedBy = 'rate-limit'; log.errors.push(e.message); break; }
      ((state.syms[task.sym] ||= {}).errors ||= {})[task.kind] = { msg: String(e.message).slice(0, 500), at: Date.now() };
      log.failed++;
      log.errors.push(`${task.sym} ${task.kind}: ${e.message}`);
      changed = true;
    }
    remaining = Math.max(0, remaining - 1);
    if (changed) state.dataAt = Date.now();
    await checkpoint();
  }

  if (changed || !state.baseAt || state.cfgVersion !== cfg.version) {
    try {
      await rebuildBase(env, cfg, state);
      state.baseAt = Date.now();
      state.cfgVersion = cfg.version;
    } catch (e) {
      log.errors.push(`snapshot rebuild: ${e.message}`); // dashboard rebuilds on next load
    }
  }
  await checkpoint();
  await env.PE_KV.delete('lock').catch(() => {});
  return state.lastRun;
}

/** Load everything needed to value one entity. memo caches constituent series across ETFs. */
export async function loadEntity(env, sym, type, memo = new Map()) {
  const getSeries = async (s) => {
    if (!memo.has(s)) {
      const f = await kvGet(env, `fund:${s}`);
      memo.set(s, { fund: f, series: buildQuarterSeries(f) });
    }
    return memo.get(s);
  };
  const hist = await kvGet(env, `hist:${sym}`);
  const rows = hist?.rows || [];
  if (type === 'etf') {
    const holdings = await kvGet(env, `etf:${sym}`);
    const seriesBySym = new Map();
    for (const h of holdings?.items || []) seriesBySym.set(h.symbol, (await getSeries(h.symbol)).series);
    const cons = etfConstituents(holdings, seriesBySym);
    return { rows, hist, holdings, cons, epsFn: etfEps(cons) };
  }
  const { fund, series } = await getSeries(sym);
  return { rows, hist, fund, series, epsFn: stockEps(series) };
}

export async function rebuildBase(env, cfg, state) {
  const today = todayISO();
  const memo = new Map();
  // prefetch every earnings record in parallel (sequential KV reads are the slow part)
  const holdingsMap = await loadHoldingsMap(env, cfg, state);
  const need = new Set(cfg.basket.map((b) => b.symbol));
  holdingsMap.forEach((h) => (h.items || []).forEach((i) => need.add(i.symbol)));
  await Promise.all([...need].map(async (s) => {
    const f = await kvGet(env, `fund:${s}`);
    memo.set(s, { fund: f, series: buildQuarterSeries(f) });
  }));
  const rows = await Promise.all(cfg.basket.map(async (b) => {
    const st = state.syms[b.symbol] || {};
    const type = entityType(b, st);
    const ent = await loadEntity(env, b.symbol, type, memo);
    const row = computeRow({ symbol: b.symbol, meta: { ...st.meta, type }, epsFn: ent.epsFn, rows: ent.rows, events: cfg.events, today });
    row.updated = { fund: st.fundAt || null, hist: st.histAt || null, etf: st.etfAt || null };
    row.errors = Object.entries(st.errors || {}).map(([k, v]) => `${k}: ${v.msg}`);
    if (type === 'stock') {
      row.basis = ent.fund?.basis || null;
      if (ent.fund?.basis?.mixed) row.warnings.push('Actual and estimate EPS come from different providers; bases may differ (GAAP vs adjusted).');
      if (!ent.fund) row.status = 'pending';
    } else {
      const items = ent.holdings?.items || [];
      const withData = ent.cons.filter((c) => c.series.length).length;
      row.holdings = {
        count: items.length,
        withEps: withData,
        weight: Math.round(items.reduce((s, i) => s + i.weight, 0) * 1000) / 1000,
        asOf: ent.holdings?.fetchedAt || null,
        source: ent.holdings?.source || null,
      };
      if (!ent.holdings) row.status = 'pending';
      else if (withData < items.length) row.warnings.push(`EPS loaded for ${withData}/${items.length} holdings so far.`);
    }
    if (row.errors.length && row.status === 'pending') row.status = 'error';
    return row;
  }));
  const base = { builtAt: Date.now(), cfgVersion: cfg.version, today, events: cfg.events, rows };
  await kvPut(env, 'base', base);
  return base;
}

/** Detail view for one symbol: quarters, PE history and holdings. */
export async function symbolDetail(env, sym) {
  const cfg = await loadConfig(env);
  const state = await loadState(env);
  const b = cfg.basket.find((x) => x.symbol === sym) || { symbol: sym };
  const st = state.syms[sym] || {};
  const type = entityType(b, st);
  const ent = await loadEntity(env, sym, type);
  const from = cfg.events.length ? [cfg.events[0].date, addDays(todayISO(), -5 * 365)].sort()[0] : addDays(todayISO(), -5 * 365);
  const out = {
    symbol: sym,
    type,
    meta: st.meta || null,
    history: peHistory(ent.epsFn, ent.rows, addDays(from, -30)),
    events: cfg.events,
    histSource: ent.hist?.source || null,
  };
  if (type === 'etf') {
    const seriesOf = new Map(ent.cons.map((c) => [c.symbol, c]));
    const today = todayISO();
    out.holdings = (ent.holdings?.items || []).map((h) => {
      const c = seriesOf.get(h.symbol);
      const e = c && c.series.length ? stockEps(c.series)(today) : null;
      return { symbol: h.symbol, name: h.name, weight: h.weight, px: h.px, ttm: e?.ttm ?? null, ntm: e?.ntm ?? null };
    });
    out.holdingsSource = ent.holdings?.source || null;
  } else {
    out.quarters = (ent.series || []).slice(-16);
    out.basis = ent.fund?.basis || null;
    out.notes = ent.fund?.notes || [];
  }
  return out;
}
