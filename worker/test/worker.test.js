// End-to-end: mocked Alpha Vantage + FMP, in-memory KV, real worker code paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { runRefresh } from '../src/store.js';

const today = new Date().toISOString().slice(0, 10);
const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

function kv() {
  const m = new Map();
  return {
    m,
    async get(k, t) { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
  };
}

// Synthetic market: AAA splits 2:1 on 2024-07-01; raw pre-split prices are double.
const SPLIT = '2024-07-01';
function dailySeries(sym) {
  const ts = {};
  for (let d = '2019-01-02'; d <= today; d = addDays(d, 1)) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if (wd === 0 || wd === 6) continue;
    let adj = sym === 'ETF1' ? 400 : 100; // split-adjusted level
    if (d === '2026-03-02') adj *= 1.3; // a spike inside the 52w window
    const raw = sym === 'AAA' && d < SPLIT ? adj * 2 : adj;
    ts[d] = { '1. open': raw, '2. high': raw * 1.01, '3. low': raw * 0.99, '4. close': raw, '5. adjusted close': raw, '6. volume': 1, '7. dividend amount': 0, '8. split coefficient': sym === 'AAA' && d === SPLIT ? '2.0' : '1.0' };
  }
  return { 'Time Series (Daily)': ts };
}

function earnings(eps) {
  const q = [];
  for (let y = 2018; y <= 2026; y++) for (const md of ['03-31', '06-30', '09-30', '12-31']) {
    const end = `${y}-${md}`;
    const rep = addDays(end, 25);
    if (rep > today) continue;
    q.push({ fiscalDateEnding: end, reportedDate: rep, reportedEPS: String(eps), estimatedEPS: String(eps) });
  }
  return { quarterlyEarnings: q.reverse(), annualEarnings: [] };
}

const fyEnd = (y) => `${y}-12-31`;
const curY = Number(today.slice(0, 4));

function mockFetch(calls) {
  return async (url) => {
    const u = new URL(url);
    calls.push(u.hostname + u.pathname + '?' + (u.searchParams.get('function') || ''));
    const resp = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.hostname.includes('financialmodelingprep')) return resp({ 'Error Message': 'Premium endpoint' }, 402);
    const fn = u.searchParams.get('function');
    const sym = u.searchParams.get('symbol');
    switch (fn) {
      case 'OVERVIEW':
        return resp(sym === 'ETF1' ? {} : { Symbol: sym, Name: `${sym} Corp`, AssetType: 'Common Stock', Currency: 'USD' });
      case 'ETF_PROFILE':
        return resp({ holdings: [{ symbol: 'AAA', description: 'AAA Corp', weight: '0.30' }, { symbol: 'BBB', description: 'BBB Corp', weight: '0.20' }, { symbol: 'n/a', description: 'Cash', weight: '0.01' }] });
      case 'EARNINGS':
        return resp(earnings(sym === 'AAA' ? 1.25 : 0.5)); // AAA TTM = 5 ; BBB TTM = 2
      case 'EARNINGS_ESTIMATES':
        return resp({ estimates: [
          { date: fyEnd(curY), horizon: 'current fiscal year', eps_estimate_average: sym === 'AAA' ? '5.0' : '2.0' },
          { date: fyEnd(curY + 1), horizon: 'next fiscal year', eps_estimate_average: sym === 'AAA' ? '6.25' : '2.5' },
        ] });
      case 'TIME_SERIES_DAILY_ADJUSTED':
        return resp(dailySeries(sym));
      case 'REALTIME_BULK_QUOTES': {
        const px = { AAA: 110, BBB: 50, ETF1: 420 };
        return resp({ data: sym.split(',').map((s) => ({ symbol: s, close: String(px[s] ?? 10), previous_close: '100', change: '1', change_percent: '1.0%', high: String((px[s] ?? 10) * 1.01), low: String((px[s] ?? 10) * 0.99), timestamp: 'now' })) });
      }
      default:
        return resp({ 'Error Message': 'unknown ' + fn });
    }
  };
}

test('full refresh cycle then dashboard API', async () => {
  const calls = [];
  globalThis.fetch = mockFetch(calls);
  const env = { PE_KV: kv(), AV_API_KEY: 'x', FMP_API_KEY: 'y', AV_CALLS_PER_MIN: '100000', AV_CALLS_PER_RUN: '200', DASHBOARD_TOKEN: 'secret', ALLOWED_ORIGINS: 'https://example.github.io' };
  await env.PE_KV.put('cfg', JSON.stringify({ version: 1, basket: [{ symbol: 'AAA' }, { symbol: 'ETF1' }], events: [{ date: '2020-03-21', label: 'Weekend event' }] }));

  const run = await runRefresh(env);
  assert.equal(run.failed, 0, JSON.stringify(run.errors));
  assert.equal(run.stoppedBy, null);

  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };

  const unauth = await worker.fetch(new Request('https://w/api/dashboard'), env, ctx);
  assert.equal(unauth.status, 401);

  const res = await worker.fetch(new Request('https://w/api/dashboard', { headers: { Authorization: 'Bearer secret', Origin: 'https://example.github.io' } }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://example.github.io');
  const d = await res.json();
  const aaa = d.rows.find((r) => r.symbol === 'AAA');
  const etf = d.rows.find((r) => r.symbol === 'ETF1');

  assert.equal(aaa.type, 'stock');
  assert.equal(aaa.name, 'AAA Corp');
  assert.equal(aaa.price, 110);
  assert.equal(aaa.now.ttm, 5);
  // Split handled: pre-split event price must be split-adjusted (100, not 200)
  assert.equal(aaa.events[0].tradeDate, '2020-03-20'); // weekend rolls back to Friday
  assert.equal(aaa.events[0].price, 100);
  assert.equal(aaa.hi52.date, '2026-03-02');
  assert.ok(aaa.now.ntm > 5 && aaa.now.ntm < 6.25, `ntm ${aaa.now.ntm}`);

  assert.equal(etf.type, 'etf');
  assert.equal(etf.status, 'ok');
  assert.equal(etf.holdings.count, 2);
  // units: AAA 0.3*420/110, BBB 0.2*420/50 ; earnings scaled by 0.5 coverage
  const exp = ((0.3 * 420) / 110 * 5 + (0.2 * 420) / 50 * 2) / 0.5;
  assert.ok(Math.abs(etf.now.ttm - exp) < 1e-3, `${etf.now.ttm} vs ${exp}`);

  // detail endpoint
  const det = await (await worker.fetch(new Request('https://w/api/symbol/AAA', { headers: { Authorization: 'Bearer secret' } }), env, ctx)).json();
  assert.ok(det.history.length > 100);
  assert.ok(det.quarters.some((q) => q.est));
  const last = det.history[det.history.length - 1];
  assert.equal(last[2], 20); // 100 / 5

  // add symbol + event via API
  const add = await worker.fetch(new Request('https://w/api/basket', { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: JSON.stringify({ symbol: 'bbb' }) }), env, ctx);
  assert.equal((await add.json()).basket.length, 3);
  const ev = await worker.fetch(new Request('https://w/api/events', { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: JSON.stringify({ date: '2018-12-24', label: 'Xmas Eve low' }) }), env, ctx);
  assert.equal((await ev.json()).events[0].date, '2018-12-24');
  await Promise.all(waits);

  // history start must extend for the older event and be refetched
  const run2 = await runRefresh(env);
  assert.equal(run2.failed, 0, JSON.stringify(run2.errors));
  const d2 = await (await worker.fetch(new Request('https://w/api/dashboard', { headers: { Authorization: 'Bearer secret' } }), env, ctx)).json();
  assert.equal(d2.rows.length, 3);
  assert.ok(d2.rows.find((r) => r.symbol === 'BBB').status === 'ok');
  const xmas = d2.rows.find((r) => r.symbol === 'AAA').events.find((e) => e.id === '2018-12-24');
  assert.equal(xmas.missing, true); // mock data starts 2019; must flag, not crash
});
