// PE Analyser API — Cloudflare Worker
// Secrets (wrangler secret put): AV_API_KEY, FMP_API_KEY, DASHBOARD_TOKEN (optional but recommended)

import { loadConfig, saveConfig, loadState, kvGet, runRefresh, rebuildBase, symbolDetail, cfgNum } from './store.js';
import { Budget, fetchQuotes, avDiagnose } from './providers.js';
import { mergeLive } from './calc.js';
import { canonSymbol, isoDate, todayISO } from './util.js';

let quoteCache = { at: 0, key: '', data: null, notes: [] };

function corsHeaders(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (allowed.includes('*') ? '*' : origin) : 'null',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (data, status, cors) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });

function authorised(env, req) {
  if (!env.DASHBOARD_TOKEN) return true;
  const h = req.headers.get('Authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (tok.length !== env.DASHBOARD_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < tok.length; i++) diff |= tok.charCodeAt(i) ^ env.DASHBOARD_TOKEN.charCodeAt(i);
  return diff === 0;
}

async function liveQuotes(env, symbols) {
  const key = symbols.slice().sort().join(',');
  const ttl = cfgNum(env, 'QUOTE_TTL_SECONDS', 15) * 1000;
  if (quoteCache.key === key && Date.now() - quoteCache.at < ttl) return quoteCache;
  const budget = new Budget(cfgNum(env, 'QUOTE_AV_CAP', 20), 300);
  const data = await fetchQuotes(env, budget, symbols);
  quoteCache = { at: Date.now(), key, data, notes: data.notes || [] };
  return quoteCache;
}

async function dashboard(env, ctx) {
  let base = await kvGet(env, 'base');
  const cfg = await loadConfig(env);
  const state = await loadState(env);
  // Rebuild here only if the snapshot is missing or older than the data/config (e.g. a run was cut off
  // before it could rebuild). Never start fetches from a page load: that caused overlapping runs.
  if (!base || base.cfgVersion !== cfg.version || (state.dataAt && base.builtAt < state.dataAt)) {
    base = await rebuildBase(env, cfg, state);
  }
  const symbols = base.rows.map((r) => r.symbol);
  const q = await liveQuotes(env, symbols);
  const today = todayISO();
  const rows = base.rows.map((r) => {
    const quote = q.data.get(r.symbol);
    const merged = mergeLive(r, quote, today);
    if (quote?.name && (!r.name || r.name === r.symbol)) merged.name = quote.name;
    return merged;
  });
  const pending = rows.filter((r) => r.status !== 'ok').length;
  return {
    generatedAt: Date.now(),
    baseBuiltAt: base.builtAt,
    quotesAt: q.at,
    quoteNotes: q.notes,
    events: base.events,
    rows,
    status: {
      pending,
      lastRun: state.lastRun || null,
      errorCount: Object.values(state.syms).filter((v) => Object.values(v.errors || {}).some((e) => e.v === 2)).length,
    },
  };
}

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    if (path === '' || path === '/api/health') return json({ ok: true, service: 'pe-analyser' }, 200, cors);
    if (!path.startsWith('/api/')) return json({ error: 'not found' }, 404, cors);
    if (!authorised(env, req)) return json({ error: 'unauthorised' }, 401, cors);

    try {
      if (req.method === 'GET' && path === '/api/dashboard') return json(await dashboard(env, ctx), 200, cors);

      if (req.method === 'GET' && path === '/api/avcheck') return json(await avDiagnose(env), 200, cors);

      if (req.method === 'GET' && path === '/api/config') return json(await loadConfig(env), 200, cors);

      if (req.method === 'GET' && path === '/api/status') {
        const state = await loadState(env);
        const syms = Object.entries(state.syms).map(([s, v]) => ({ symbol: s, type: v.meta?.type, fundAt: v.fundAt, histAt: v.histAt, etfAt: v.etfAt, errors: Object.fromEntries(Object.entries(v.errors || {}).filter(([, e]) => e.v === 2)) }));
        return json({ lastRun: state.lastRun, baseAt: state.baseAt, syms }, 200, cors);
      }

      let m = path.match(/^\/api\/symbol\/([A-Za-z0-9.\-^]+)$/);
      if (req.method === 'GET' && m) return json(await symbolDetail(env, canonSymbol(m[1])), 200, cors);

      if (req.method === 'POST' && path === '/api/basket') {
        const body = await req.json();
        const sym = canonSymbol(body.symbol);
        if (!/^[A-Z0-9][A-Z0-9\-^]{0,14}$/.test(sym)) return json({ error: 'invalid symbol' }, 400, cors);
        const cfg = await loadConfig(env);
        if (!cfg.basket.some((b) => b.symbol === sym)) {
          const entry = { symbol: sym };
          if (body.type === 'stock' || body.type === 'etf') entry.type = body.type;
          cfg.basket.push(entry);
          await saveConfig(env, cfg);
          ctx.waitUntil(runRefresh(env, { force: [sym] }).catch(() => {}));
        }
        return json(cfg, 200, cors);
      }

      m = path.match(/^\/api\/basket\/([A-Za-z0-9.\-^]+)$/);
      if (req.method === 'DELETE' && m) {
        const sym = canonSymbol(m[1]);
        const cfg = await loadConfig(env);
        cfg.basket = cfg.basket.filter((b) => b.symbol !== sym);
        await saveConfig(env, cfg);
        return json(cfg, 200, cors);
      }

      if (req.method === 'POST' && path === '/api/events') {
        const body = await req.json();
        if (!isoDate(body.date)) return json({ error: 'date must be YYYY-MM-DD' }, 400, cors);
        const label = String(body.label || body.date).slice(0, 60);
        const cfg = await loadConfig(env);
        cfg.events = cfg.events.filter((e) => e.date !== body.date).concat([{ date: body.date, label }]);
        await saveConfig(env, cfg);
        return json(cfg, 200, cors);
      }

      m = path.match(/^\/api\/events\/(\d{4}-\d{2}-\d{2})$/);
      if (req.method === 'DELETE' && m) {
        const cfg = await loadConfig(env);
        cfg.events = cfg.events.filter((e) => e.date !== m[1]);
        await saveConfig(env, cfg);
        return json(cfg, 200, cors);
      }

      if (req.method === 'POST' && path === '/api/refresh') {
        const body = await req.json().catch(() => ({}));
        const force = Array.isArray(body.symbols) ? body.symbols : body.symbol ? [body.symbol] : [];
        ctx.waitUntil(runRefresh(env, { force }).catch(() => {}));
        return json({ queued: true }, 202, cors);
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: e.message }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRefresh(env));
  },
};
