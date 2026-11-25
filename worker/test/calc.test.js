import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuarterSeries, ttmAt, ntmAt, nextQuarterEnd, range52w, closeOnOrBefore, etfConstituents, etfEps, stockEps, computeRow, mergeLive } from '../src/calc.js';

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

// Dec fiscal year, quarterly EPS 1.0 for 2024–2025, 1.0/1.1/1.2 for 2026 Q1–Q3
function fund() {
  const quarters = [];
  const ends = ['2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30'];
  const eps = [1, 1, 1, 1, 1, 1, 1, 1, 1.0, 1.1, 1.2];
  ends.forEach((e, i) => quarters.push({ end: e, reported: addDays(e, 25), eps: eps[i] }));
  return { quarters, qEst: [], fyEst: [{ end: '2026-12-31', eps: 4.6 }, { end: '2027-12-31', eps: 6.0 }] };
}
function addDays(s, n) { return new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10); }

test('nextQuarterEnd handles month-end and 52/53-week calendars', () => {
  assert.equal(nextQuarterEnd('2026-09-30'), '2026-12-31');
  assert.equal(nextQuarterEnd('2026-12-31'), '2027-03-31');
  assert.equal(nextQuarterEnd('2026-03-31'), '2026-06-30');
  assert.equal(nextQuarterEnd('2026-10-25'), '2027-01-24');
});

test('quarter series fills estimates from FY residual', () => {
  const s = buildQuarterSeries(fund());
  const q4 = s.find((q) => q.end === '2026-12-31');
  close(q4.eps, 4.6 - 3.3);
  assert.equal(q4.est, true);
  const q27 = s.filter((q) => q.end.startsWith('2027'));
  assert.equal(q27.length, 4);
  q27.forEach((q) => close(q.eps, 1.5));
  assert.ok(!s.some((q) => q.end.startsWith('2028')), 'no estimates beyond FY coverage');
});

test('explicit quarterly estimate takes precedence and residual adjusts', () => {
  const f = fund();
  f.qEst = [{ end: '2027-03-31', eps: 1.2 }];
  const s = buildQuarterSeries(f);
  close(s.find((q) => q.end === '2027-03-31').eps, 1.2);
  close(s.find((q) => q.end === '2027-06-30').eps, (6 - 1.2) / 3);
});

test('TTM is point-in-time on report date', () => {
  const s = buildQuarterSeries(fund());
  // Q3 2026 reported 2026-10-25
  close(ttmAt(s, '2026-10-24').eps, 1 + 1 + 1.1 + 1.0); // Q3'25..Q2'26
  close(ttmAt(s, '2026-10-25').eps, 1 + 1.0 + 1.1 + 1.2); // Q4'25..Q3'26
  assert.equal(ttmAt(s, '2024-06-01'), null); // fewer than 4 reported quarters
});

test('NTM is time-weighted across quarters', () => {
  const s = buildQuarterSeries(fund());
  const n = ntmAt(s, '2026-12-31');
  close(n.eps, 6.0, 0.02); // ≈ FY2027
  assert.ok(n.estShare > 0.99);
  const mid = ntmAt(s, '2026-11-15');
  assert.ok(mid.eps > 5.8 && mid.eps < 6.0, `blend ${mid.eps}`);
  const hist = ntmAt(s, '2025-01-01');
  close(hist.eps, 4.0, 0.03); // realised 2025 actuals
  assert.ok(hist.estShare < 0.01);
  assert.equal(ntmAt(s, '2027-06-01'), null); // window runs past last estimate
});

test('52-week range and close lookup', () => {
  const rows = [['2025-11-20', 10, 9, 9.5], ['2025-11-26', 12, 8, 11], ['2026-06-01', 20, 15, 19], ['2026-11-24', 18, 17, 17.5]];
  const { hi, lo } = range52w(rows, '2026-11-25');
  assert.deepEqual(hi, { date: '2026-06-01', price: 20 });
  assert.deepEqual(lo, { date: '2025-11-26', price: 8 });
  assert.deepEqual(closeOnOrBefore(rows, '2026-06-03'), { date: '2026-06-01', price: 19 });
  assert.equal(closeOnOrBefore(rows, '2026-07-01'), null); // gap > 7 days
});

test('ETF look-through EPS equals aggregate earnings scaled for coverage', () => {
  const s = buildQuarterSeries(fund()); // TTM at 2026-11-25 = 4.3
  const holdings = { etfPx: 100, items: [{ symbol: 'A', weight: 0.3, px: 50 }, { symbol: 'B', weight: 0.2, px: 25 }, { symbol: 'C', weight: 0.1, px: 10 }] };
  const cons = etfConstituents(holdings, new Map([['A', s], ['B', s]])); // C has no data
  const e = etfEps(cons)('2026-11-25');
  // units: A 0.6, B 0.8 -> covered earnings 1.4*4.3 over 50% coverage
  close(e.ttm, (1.4 * 4.3) / 0.5);
  close(e.covTtm, 0.5);
  // harmonic-mean equivalence: covered value 50 / earnings 6.02 -> PE 8.31; ETF PE = 100 / 12.04
  close(100 / e.ttm, 50 / (1.4 * 4.3));
});

test('computeRow + mergeLive extend 52W extremes with live quote', () => {
  const s = buildQuarterSeries(fund());
  const rows = [['2026-01-05', 100, 90, 95], ['2026-06-01', 120, 110, 115], ['2026-11-24', 110, 105, 108]];
  const row = computeRow({ symbol: 'X', meta: { name: 'X Co' }, epsFn: stockEps(s), rows, events: [{ date: '2026-06-01', label: 'E' }], today: '2026-11-25' });
  close(row.now.ttm, 4.3);
  assert.equal(row.hi52.date, '2026-06-01');
  assert.equal(row.events[0].price, 115);
  const live = mergeLive(row, { price: 125, dayHigh: 126, dayLow: 107, source: 't' }, '2026-11-25');
  assert.equal(live.price, 125);
  assert.equal(live.hi52.date, '2026-11-25');
  assert.equal(live.hi52.price, 126);
  close(live.hi52.ttm, 4.3);
  assert.equal(live.lo52.date, '2026-01-05');
});
