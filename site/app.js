// PE Analyser front end — static, no build step. Talks to the Cloudflare Worker API.

const CFG = window.PE_CONFIG || {};
const LS = {
  get(k, d) { try { const v = localStorage.getItem('pe.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pe.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const S = {
  data: null,
  cfg: null,
  opts: Object.assign({ metric: 'both', view: 'mult', basis: 'pit', filter: 'all' }, LS.get('opts', {})),
  sort: LS.get('sort', { key: 'sym', dir: 1 }),
  apiBase: LS.get('apiBase', CFG.apiBase || ''),
  token: LS.get('token', ''),
  timer: null,
  loading: false,
};

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (x, dp = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '–' : x.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const fmtPct = (x, dp = 1) => (x === null || !Number.isFinite(x) ? '–' : (x > 0 ? '+' : '') + (x * 100).toFixed(dp) + '%');
const fDate = (iso, short) => {
  if (!iso) return '–';
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: short ? '2-digit' : 'numeric', timeZone: 'UTC' });
};
const ago = (ms) => {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};
const median = (a) => {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

// ---------------- API ----------------

async function api(path, init = {}) {
  if (!S.apiBase || S.apiBase.includes('REPLACE-ME')) { openSettings('Set the Worker API URL to begin.'); throw new Error('API URL not set'); }
  const res = await fetch(S.apiBase.replace(/\/$/, '') + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}), ...(init.headers || {}) },
  });
  if (res.status === 401) { openSettings('Access token required or incorrect.'); throw new Error('unauthorised'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function load() {
  if (S.loading) return;
  S.loading = true;
  try {
    const [data, cfg] = await Promise.all([api('/api/dashboard'), S.cfg ? Promise.resolve(S.cfg) : api('/api/config')]);
    S.data = data;
    S.cfg = cfg;
    render();
  } catch (e) {
    setStatus(`Could not load: ${e.message}`, true);
  } finally {
    S.loading = false;
  }
}

function schedule() {
  clearInterval(S.timer);
  S.timer = setInterval(() => { if (!document.hidden) load(); }, Math.max(15, CFG.refreshSeconds || 60) * 1000);
}

// ---------------- valuation helpers ----------------

function points() {
  const ev = (S.data?.events || []).map((e) => ({ key: 'ev:' + e.date, label: e.label, sub: fDate(e.date, true), date: e.date }));
  return [{ key: 'now', label: 'Now', sub: 'live' }, { key: 'hi52', label: '52W high', sub: 'per stock' }, { key: 'lo52', label: '52W low', sub: 'per stock' }, ...ev];
}

function getPoint(row, key) {
  if (key === 'now') return row.now ? { ...row.now, price: row.price, date: S.data?.generatedAt ? new Date(S.data.generatedAt).toISOString().slice(0, 10) : null } : null;
  if (key === 'hi52' || key === 'lo52') return row[key];
  const id = key.slice(3);
  return (row.events || []).find((e) => e.id === id) || null;
}

/** Returns {v} multiple, or {nm:true} for non-positive EPS, or null if missing. */
function ratio(row, pt, m) {
  if (!pt || !Number.isFinite(pt.price)) return null;
  const eps = S.opts.basis === 'cur' ? row.now?.[m] : pt[m];
  if (eps === null || eps === undefined || !Number.isFinite(eps)) return null;
  if (eps <= 0) return { nm: true };
  return { v: pt.price / eps, eps };
}

const metrics = () => (S.opts.metric === 'both' ? ['ttm', 'ntm'] : [S.opts.metric]);
const mLabel = { ttm: 'PE', ntm: 'Fwd' };

function cellValue(row, key, m) {
  const pt = getPoint(row, key);
  const r = ratio(row, pt, m);
  if (S.opts.view === 'rel' && key !== 'now') {
    const n = ratio(row, getPoint(row, 'now'), m);
    if (!r || !n || r.nm || n.nm) return { r, pt, rel: null };
    return { r, pt, rel: n.v / r.v - 1 };
  }
  return { r, pt };
}

function sortValue(row, key) {
  if (key === 'sym') return row.symbol;
  if (key === 'price') return row.price;
  if (key === 'chg') return row.changePct;
  if (key === 'ttm') return row.now?.ttm;
  if (key === 'ntm') return row.now?.ntm;
  if (key === 'g') return growth(row);
  if (key === 'pos') return position(row);
  const [pk, m] = key.split('|');
  const c = cellValue(row, pk, m);
  if (S.opts.view === 'rel' && pk !== 'now') return c.rel;
  return c.r && !c.r.nm ? c.r.v : null;
}

const growth = (row) => (row.now?.ttm > 0 && Number.isFinite(row.now?.ntm) ? row.now.ntm / row.now.ttm - 1 : null);

function rangeMetric() { return S.opts.metric === 'ttm' ? 'ttm' : 'ntm'; }
function position(row) {
  const m = rangeMetric();
  const lo = ratio(row, row.lo52, m), hi = ratio(row, row.hi52, m), cur = ratio(row, getPoint(row, 'now'), m);
  if (!lo || !hi || !cur || lo.nm || hi.nm || cur.nm || hi.v === lo.v) return null;
  return (cur.v - lo.v) / (hi.v - lo.v);
}

// ---------------- render ----------------

function setStatus(msg, isErr) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('warn', !!isErr);
}

function visibleRows() {
  const rows = (S.data?.rows || []).filter((r) => S.opts.filter === 'all' || r.type === S.opts.filter);
  const { key, dir } = S.sort;
  return rows.slice().sort((a, b) => {
    const va = sortValue(a, key), vb = sortValue(b, key);
    const na = va === null || va === undefined || Number.isNaN(va), nb = vb === null || vb === undefined || Number.isNaN(vb);
    if (na && nb) return a.symbol.localeCompare(b.symbol);
    if (na) return 1;
    if (nb) return -1;
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
  });
}

function render() {
  const d = S.data;
  if (!d) return;
  const qt = d.quotesAt ? new Date(d.quotesAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–';
  const src = [...new Set(d.rows.map((r) => r.quoteSource).filter(Boolean))].join(', ');
  const lr = d.status?.lastRun;
  const bits = [`Prices ${qt}${src ? ` (${src})` : ''}`, `fundamentals snapshot ${ago(d.baseBuiltAt)}`];
  if (d.status?.pending) bits.push(`${d.status.pending} loading`);
  if (lr) bits.push(`last data run ${ago(lr.at)}: ${lr.done} fetched${lr.failed ? `, ${lr.failed} failed` : ''}${lr.remaining ? `, ${lr.remaining} queued` : ''}`);
  else bits.push('no data run has completed yet');
  if (lr?.stoppedBy === 'rate-limit') bits.push('AV rate limit hit');
  if (d.status?.errorCount) bits.push(`${d.status.errorCount} symbols with errors (see Settings)`);
  setStatus(bits.join(' · '), lr?.stoppedBy === 'rate-limit' || !lr);
  document.querySelectorAll('.seg').forEach((seg) => seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(S.opts[seg.dataset.key] === b.dataset.v))));
  renderTiles();
  renderTable();
  renderManage();
  $('#legend-note').innerHTML =
    S.opts.view === 'rel'
      ? `“Now vs point”: today’s multiple relative to the multiple at each date.<span class="swatch" style="background:var(--div-pos-bg);border:1px solid var(--div-pos)"></span>dearer now<span class="swatch" style="background:var(--div-neg-bg);border:1px solid var(--div-neg)"></span>cheaper now. Hover any cell for price, EPS and date.`
      : `PE = trailing (last four reported quarters). Fwd = next-12-months EPS. ${S.opts.basis === 'cur' ? 'Current EPS applied to each historical price.' : 'EPS as known at each date.'} Hover any cell for price, EPS and date; click a row for history.`;
}

function renderTiles() {
  const rows = (S.data?.rows || []).filter((r) => r.status === 'ok' && (S.opts.filter === 'all' ? r.type === 'stock' : r.type === S.opts.filter));
  const label = S.opts.filter === 'etf' ? 'ETFs' : 'stocks';
  const med = (key, m) => median(rows.map((r) => { const x = ratio(r, getPoint(r, key), m); return x && !x.nm ? x.v : null; }));
  const tiles = [
    ['Median trailing PE', med('now', 'ttm'), `${rows.length} ${label}, live prices`],
    ['Median forward PE', med('now', 'ntm'), 'next 12 months consensus'],
    ['Median fwd PE at 52W high', med('hi52', 'ntm'), 'each at its own high'],
    ['Median fwd PE at 52W low', med('lo52', 'ntm'), 'each at its own low'],
  ];
  const g = median(rows.map(growth));
  tiles.push(['Median implied EPS growth', null, 'NTM vs TTM', g]);
  $('#tiles').innerHTML = tiles
    .map(([k, v, s, pct]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${pct !== undefined ? fmtPct(pct) : v === null ? '–' : fmt(v) + '×'}</div><div class="s">${esc(s)}</div></div>`)
    .join('');
}

function tipFor(row, key, m, pt) {
  if (!pt) return 'No data';
  const eps = S.opts.basis === 'cur' ? row.now?.[m] : pt[m];
  const lines = [];
  lines.push(`<b>${esc(row.symbol)}</b> · ${esc(key === 'now' ? 'Now' : key === 'hi52' ? '52W high' : key === 'lo52' ? '52W low' : pt.label || '')}`);
  if (pt.tradeDate || pt.date) lines.push(`Price date: ${fDate(pt.tradeDate || pt.date)}${pt.live ? ' (today, live)' : ''}`);
  if (pt.missing) lines.push('No price history for this date.');
  lines.push(`Price: ${fmt(pt.price, 2)}`);
  lines.push(`${m === 'ttm' ? 'Trailing' : 'Forward 12m'} EPS: ${fmt(eps, 2)}${S.opts.basis === 'cur' ? ' (current)' : ''}`);
  if (m === 'ttm' && pt.ttmAsOf && S.opts.basis === 'pit') lines.push(`Last quarter in TTM: ${fDate(pt.ttmAsOf)}`);
  if (m === 'ntm' && Number.isFinite(pt.estShare) && S.opts.basis === 'pit') lines.push(`Estimates share of window: ${Math.round(pt.estShare * 100)}%${key !== 'now' && pt.estShare < 0.99 ? ' (rest realised: hindsight)' : ''}`);
  if (pt.covTtm !== undefined) lines.push(`Look-through coverage: ${Math.round((m === 'ttm' ? pt.covTtm : pt.covNtm) * 100)}% of fund`);
  return lines.join('<br>');
}

function miniRange(row) {
  const m = rangeMetric();
  const lo = ratio(row, row.lo52, m), hi = ratio(row, row.hi52, m), cur = ratio(row, getPoint(row, 'now'), m);
  if (!lo || !hi || !cur || lo.nm || hi.nm || cur.nm) return '<span class="na">–</span>';
  const vals = [lo.v, hi.v, cur.v];
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const W = 96, pad = 6, x = (v) => (mx === mn ? W / 2 : pad + ((v - mn) / (mx - mn)) * (W - 2 * pad));
  const tip = `${mLabel[m]} at 52W low ${fmt(lo.v)}× · now ${fmt(cur.v)}× · at 52W high ${fmt(hi.v)}×`;
  return `<svg class="mini" width="${W}" height="16" viewBox="0 0 ${W} 16" role="img" aria-label="${esc(tip)}" data-tip="${esc(tip)}">
    <line class="track" x1="${x(lo.v)}" x2="${x(hi.v)}" y1="8" y2="8"/>
    <circle class="end" cx="${x(lo.v)}" cy="8" r="2.5"/><circle class="end" cx="${x(hi.v)}" cy="8" r="2.5"/>
    <circle class="cur" cx="${x(cur.v)}" cy="8" r="4.5"/></svg>`;
}

function renderTable() {
  const pts = points();
  const ms = metrics();
  const rows = visibleRows();
  const sortAttr = (k) => (S.sort.key === k ? ` aria-sort="${S.sort.dir > 0 ? 'ascending' : 'descending'}"` : '');
  const th = (k, label, cls = '') => `<th class="sortable ${cls}" data-sort="${k}"${sortAttr(k)}>${label}</th>`;

  let h1 = `<tr><th class="sym sortable" rowspan="2" data-sort="sym"${sortAttr('sym')}>Symbol</th><th colspan="5" class="grp">Live / EPS</th>`;
  let h2 = `<tr>${th('price', 'Price')}${th('chg', 'Day')}${th('ttm', 'TTM EPS')}${th('ntm', 'NTM EPS')}${th('g', 'Growth')}`;
  pts.forEach((p, i) => {
    h1 += `<th colspan="${ms.length}" class="grp gstart">${esc(p.label)}<small>${esc(p.sub || '')}</small></th>`;
    ms.forEach((m, j) => (h2 += th(`${p.key}|${m}`, mLabel[m], j === 0 ? 'gstart' : '')));
    if (i === 2) { h1 += `<th rowspan="2" class="grp gstart sortable" data-sort="pos"${sortAttr('pos')}>52W ${mLabel[rangeMetric()]} range<small>low · now · high</small></th>`; }
  });
  h1 += '</tr>';
  h2 += '</tr>';

  const body = rows.map((row) => {
    const warn = [...(row.warnings || []), ...(row.errors || [])];
    const flag = warn.length ? ` <span class="warn" data-tip="${esc(warn.join('<br>'))}" aria-label="${warn.length} warnings">⚠</span>` : '';
    const typeTag = row.type === 'etf' ? '<span class="tag">ETF</span>' : '';
    let tr = `<tr data-sym="${esc(row.symbol)}"><td class="sym"><b>${esc(row.symbol)}</b>${typeTag}${flag}<span class="nm">${esc(row.name || '')}</span></td>`;
    if (row.status !== 'ok') {
      const span = 5 + pts.length * ms.length + 1;
      return tr + `<td colspan="${span}" style="text-align:left" class="na">${row.status === 'error' ? 'Data error — see ⚠' : 'Loading data… (fetched in the background; may take one or two refresh cycles)'}</td></tr>`;
    }
    const g = growth(row);
    tr += `<td>${fmt(row.price, 2)}</td><td>${fmtPct(Number.isFinite(row.changePct) ? row.changePct / 100 : null, 2)}</td>`;
    tr += `<td>${fmt(row.now?.ttm, 2)}</td><td>${fmt(row.now?.ntm, 2)}</td><td>${fmtPct(g)}</td>`;
    pts.forEach((p, i) => {
      ms.forEach((m, j) => {
        const c = cellValue(row, p.key, m);
        const cls = [j === 0 ? 'gstart' : ''];
        let txt;
        if (S.opts.view === 'rel' && p.key !== 'now') {
          txt = c.rel === null ? (c.r?.nm ? 'n/m' : '–') : fmtPct(c.rel, 0);
          if (c.rel !== null && c.rel > 0.02) cls.push('rel-pos');
          if (c.rel !== null && c.rel < -0.02) cls.push('rel-neg');
        } else txt = !c.r ? '–' : c.r.nm ? 'n/m' : fmt(c.r.v);
        if (txt === '–' || txt === 'n/m') cls.push('na');
        tr += `<td class="${cls.join(' ')}" data-tip="${esc(tipFor(row, p.key, m, c.pt))}">${txt}</td>`;
      });
      if (i === 2) tr += `<td class="gstart">${miniRange(row)}</td>`;
    });
    return tr + '</tr>';
  });
  $('#grid').innerHTML = `<thead>${h1}${h2}</thead><tbody>${body.join('') || `<tr><td class="sym na">No symbols</td></tr>`}</tbody>`;
}

function renderManage() {
  const cfg = S.cfg;
  if (!cfg) return;
  const byRow = new Map((S.data?.rows || []).map((r) => [r.symbol, r]));
  $('#basket').innerHTML = cfg.basket
    .map((b) => `<li>${esc(b.symbol)}${(byRow.get(b.symbol)?.type || b.type) === 'etf' ? ' <span class="tag">ETF</span>' : ''}<button data-del-sym="${esc(b.symbol)}" aria-label="Remove ${esc(b.symbol)}">×</button></li>`)
    .join('');
  $('#events').innerHTML = cfg.events
    .map((e) => `<li>${esc(e.label)} · ${fDate(e.date)}<button data-del-ev="${esc(e.date)}" aria-label="Remove ${esc(e.label)}">×</button></li>`)
    .join('');
}

// ---------------- detail ----------------

async function openDetail(sym) {
  const row = S.data?.rows.find((r) => r.symbol === sym);
  const dlg = $('#detail');
  $('#d-title').textContent = `${sym}${row?.name && row.name !== sym ? ' — ' + row.name : ''}`;
  $('#d-sub').textContent = 'Loading…';
  $('#d-body').innerHTML = '';
  if (!dlg.open) dlg.showModal();
  try {
    const d = await api('/api/symbol/' + encodeURIComponent(sym));
    renderDetail(row, d);
  } catch (e) {
    $('#d-sub').textContent = 'Could not load: ' + e.message;
  }
}

function renderDetail(row, d) {
  const upd = row?.updated || {};
  $('#d-sub').textContent = [
    d.type === 'etf' ? 'ETF (look-through)' : 'Stock',
    d.histSource ? `prices: ${d.histSource === 'av' ? 'Alpha Vantage' : 'FMP'}` : null,
    upd.fund ? `earnings updated ${ago(upd.fund)}` : null,
    upd.etf ? `holdings updated ${ago(upd.etf)}` : null,
    d.basis ? `EPS: ${d.basis.actual}; estimates: ${d.basis.estimate}` : null,
  ].filter(Boolean).join(' · ');

  let html = `<div class="chart-legend"><span class="swatch" style="background:var(--series-1)"></span>Trailing PE<span class="swatch" style="background:var(--series-2)"></span>Forward PE (historical values use realised EPS — hindsight) · shaded = last 52 weeks · dotted = reference dates</div>`;
  html += chartSvg(d.history, d.events);
  html += `<ol class="notes" start="1">${(d.events || []).map((e) => `<li>${esc(e.label)} — ${fDate(e.date)}</li>`).join('')}</ol>`;
  html += '<div class="d-grid">';
  if (d.quarters) {
    html += `<div><h2>Quarterly EPS</h2><div class="scroll"><table><thead><tr><th>Quarter end</th><th>Reported</th><th>EPS</th><th>Type</th></tr></thead><tbody>${d.quarters
      .slice()
      .reverse()
      .map((q) => `<tr><td>${fDate(q.end)}</td><td>${q.est ? '–' : fDate(q.reported)}</td><td>${fmt(q.eps, 2)}</td><td>${q.est ? (q.src === 'quarter' ? 'Consensus (qtr)' : 'Consensus (FY residual)') : 'Actual'}</td></tr>`)
      .join('')}</tbody></table></div></div>`;
  }
  if (d.holdings) {
    const tot = d.holdings.reduce((s, h) => s + h.weight, 0);
    html += `<div><h2>Top holdings used (${Math.round(tot * 100)}% of fund)</h2><div class="scroll"><table><thead><tr><th>Holding</th><th>Weight</th><th>TTM EPS</th><th>NTM EPS</th><th>Fwd PE*</th></tr></thead><tbody>${d.holdings
      .map((h) => `<tr><td>${esc(h.symbol)}</td><td>${fmt(h.weight * 100, 2)}%</td><td>${fmt(h.ttm, 2)}</td><td>${fmt(h.ntm, 2)}</td><td>${h.ntm > 0 && h.px ? fmt(h.px / h.ntm) : h.ntm !== null ? 'n/m' : '–'}</td></tr>`)
      .join('')}</tbody></table></div><p class="muted" style="font-size:11px;margin-top:6px">* at holdings-snapshot price. Holdings without EPS are excluded and coverage scaled.</p></div>`;
  }
  const notes = [...(row?.warnings || []), ...(row?.errors || []), ...(d.notes || [])];
  if (notes.length) html += `<div><h2>Notes</h2><ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`;
  html += '</div>';
  $('#d-body').innerHTML = html;
  wireChart();
}

let chartState = null;
function chartSvg(hist, events) {
  if (!hist || hist.length < 2) return '<p class="muted">Not enough price history yet.</p>';
  const W = 1000, H = 320, m = { l: 44, r: 92, t: 22, b: 26 };
  const day = (s) => Date.parse(s + 'T00:00:00Z') / 864e5;
  const x0 = day(hist[0][0]), x1 = day(hist[hist.length - 1][0]);
  const vals = hist.flatMap((h) => [h[2], h[3]]).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!vals.length) return '<p class="muted">No positive-earnings history to chart.</p>';
  const p98 = vals[Math.floor(vals.length * 0.98)] || vals[vals.length - 1];
  const yMax = niceMax(Math.min(vals[vals.length - 1], p98 * 1.15));
  const X = (d) => m.l + ((day(d) - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - Math.min(v, yMax) / yMax) * (H - m.t - m.b);
  const path = (idx) => {
    let s = '', pen = false;
    for (const h of hist) {
      const v = h[idx];
      if (!Number.isFinite(v) || v <= 0 || v > yMax) { pen = false; continue; }
      s += `${pen ? 'L' : 'M'}${X(h[0]).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
    }
    return s;
  };
  const ticks = [];
  const step = yMax / 5;
  for (let v = 0; v <= yMax + 1e-9; v += step) ticks.push(v);
  let g = ticks.map((v) => `<line class="gl" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${fmt(v, 0)}×</text>`).join('');
  const yrs = [];
  for (let y = Number(hist[0][0].slice(0, 4)) + 1; y <= Number(hist[hist.length - 1][0].slice(0, 4)); y++) yrs.push(y);
  g += yrs.map((y) => `<text x="${X(y + '-01-01')}" y="${H - 8}" text-anchor="middle">${y}</text>`).join('');
  const last = hist[hist.length - 1][0];
  const bandFrom = new Date(Date.parse(last + 'T00:00:00Z') - 365 * 864e5).toISOString().slice(0, 10);
  const band = `<rect class="band" x="${X(bandFrom < hist[0][0] ? hist[0][0] : bandFrom)}" y="${m.t}" width="${X(last) - X(bandFrom < hist[0][0] ? hist[0][0] : bandFrom)}" height="${H - m.t - m.b}"/>`;
  const evs = (events || [])
    .map((e, i) => (e.date >= hist[0][0] && e.date <= last ? `<line class="ev" x1="${X(e.date)}" x2="${X(e.date)}" y1="${m.t}" y2="${H - m.b}"/><text x="${X(e.date)}" y="${m.t - 6}" text-anchor="middle" data-tip="${esc(e.label + ' — ' + fDate(e.date))}">${i + 1}</text>` : ''))
    .join('');
  // direct end labels
  const lastT = [...hist].reverse().find((h) => h[2] > 0), lastF = [...hist].reverse().find((h) => h[3] > 0);
  let yT = lastT ? Y(lastT[2]) : null, yF = lastF ? Y(lastF[3]) : null;
  if (yT !== null && yF !== null && Math.abs(yT - yF) < 14) { const mid = (yT + yF) / 2; if (yT <= yF) { yT = mid - 7; yF = mid + 7; } else { yT = mid + 7; yF = mid - 7; } }
  const lbl = (lastT ? `<text class="lbl" x="${W - m.r + 8}" y="${yT + 4}">PE ${fmt(lastT[2])}×</text>` : '') + (lastF ? `<text class="lbl" x="${W - m.r + 8}" y="${yF + 4}">Fwd ${fmt(lastF[3])}×</text>` : '');
  chartState = { hist, X, Y, W, H, m, yMax };
  const clipped = vals.filter((v) => v > yMax).length;
  const clipNote = clipped ? `<p class="muted" style="font-size:11px">Values above ${fmt(yMax, 0)}× omitted (${clipped} weekly points; near-zero earnings).</p>` : '';
  return `<svg class="chart" id="pe-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trailing and forward PE history">
    ${band}${g}<line class="ax" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>${evs}
    <path class="l1" d="${path(2)}"/><path class="l2" d="${path(3)}"/>${lbl}
    <g id="xh" visibility="hidden"><line class="xh" y1="${m.t}" y2="${H - m.b}"/><circle class="dot1" r="4.5"/><circle class="dot2" r="4.5"/></g>
    <rect id="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/></svg>${clipNote}`;
}

function niceMax(v) {
  if (!(v > 0)) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

function wireChart() {
  const svg = $('#pe-chart');
  if (!svg || !chartState) return;
  const { hist, X, Y } = chartState;
  const xh = $('#xh', svg), hit = $('#hit', svg), tip = $('#tip');
  const xs = hist.map((h) => X(h[0]));
  hit.addEventListener('pointermove', (ev) => {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] < p.x) lo = mid; else hi = mid; }
    const i = Math.abs(xs[lo] - p.x) < Math.abs(xs[hi] - p.x) ? lo : hi;
    const h = hist[i];
    xh.setAttribute('visibility', 'visible');
    const line = xh.querySelector('line');
    line.setAttribute('x1', xs[i]); line.setAttribute('x2', xs[i]);
    const [d1, d2] = xh.querySelectorAll('circle');
    const place = (c, v) => { if (v > 0 && v <= chartState.yMax) { c.setAttribute('cx', xs[i]); c.setAttribute('cy', Y(v)); c.style.display = ''; } else c.style.display = 'none'; };
    place(d1, h[2]); place(d2, h[3]);
    showTip(`<b>${fDate(h[0])}</b><br>Price ${fmt(h[1], 2)}<br>Trailing PE ${h[2] > 0 ? fmt(h[2]) + '×' : 'n/m'}<br>Forward PE ${h[3] > 0 ? fmt(h[3]) + '×' : 'n/m'}`, ev.clientX, ev.clientY);
  });
  hit.addEventListener('pointerleave', () => { xh.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}

// ---------------- tooltip ----------------

function showTip(html, x, y) {
  const tip = $('#tip');
  const host = document.querySelector('dialog[open]') || document.body; // dialogs sit in the top layer
  if (tip.parentElement !== host) host.appendChild(tip);
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
  tip.style.left = Math.max(8, left) + 'px';
  tip.style.top = Math.max(8, top) + 'px';
}

document.addEventListener('pointerover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) return;
  showTip(t.dataset.tip, e.clientX, e.clientY);
});
document.addEventListener('pointermove', (e) => {
  const t = e.target.closest('[data-tip]');
  if (t) showTip(t.dataset.tip, e.clientX, e.clientY);
  else if (!e.target.closest('#hit')) $('#tip').hidden = true;
});

// ---------------- settings ----------------

async function loadDiagnostics() {
  const el = $('#s-diag');
  if (!el) return;
  try {
    const st = await api('/api/status');
    const lr = st.lastRun;
    const errs = st.syms.filter((x) => x.errors && Object.keys(x.errors).length);
    el.innerHTML =
      (lr
        ? `<p>Last run ${ago(lr.at)} (${(lr.ms / 1000).toFixed(1)} s): ${lr.done} fetched, ${lr.failed} failed, ${lr.remaining} queued; AV calls ${lr.avCalls}, FMP calls ${lr.fmpCalls}${lr.stoppedBy ? `; stopped by ${esc(lr.stoppedBy)}` : ''}.</p>`
        : '<p>No run has completed yet.</p>') +
      (errs.length
        ? `<ul class="notes">${errs.map((x) => Object.entries(x.errors).map(([k, v]) => `<li><b>${esc(x.symbol)}</b> ${esc(k)}: ${esc(v.msg)}</li>`).join('')).join('')}</ul>`
        : '<p>No symbol errors.</p>') +
      (lr?.errors?.length ? `<p>Last run messages:</p><ul class="notes">${lr.errors.slice(0, 10).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '');
  } catch (e) {
    el.textContent = 'Diagnostics unavailable: ' + e.message;
  }
}

function openSettings(msg) {
  const dlg = $('#settings');
  if (S.token || !msg) loadDiagnostics();
  $('#s-api').value = S.apiBase && !S.apiBase.includes('REPLACE-ME') ? S.apiBase : '';
  $('#s-token').value = S.token;
  if (msg) setStatus(msg, true);
  if (!dlg.open) dlg.showModal();
}

// ---------------- wiring ----------------

function wire() {
  document.querySelectorAll('.seg').forEach((seg) =>
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      S.opts[seg.dataset.key] = b.dataset.v;
      LS.set('opts', S.opts);
      render();
    }),
  );
  $('#grid').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: k === 'sym' ? 1 : -1 };
      LS.set('sort', S.sort);
      renderTable();
      return;
    }
    const tr = e.target.closest('tbody tr[data-sym]');
    if (tr) openDetail(tr.dataset.sym);
  });
  $('#d-close').addEventListener('click', () => $('#detail').close());
  $('#detail').addEventListener('click', (e) => { if (e.target.id === 'detail') $('#detail').close(); });
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#settings-form').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    S.apiBase = $('#s-api').value.trim();
    S.token = $('#s-token').value.trim();
    LS.set('apiBase', S.apiBase);
    LS.set('token', S.token);
    S.cfg = null;
    setTimeout(load, 0);
  });
  $('#btn-refresh').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try { await api('/api/refresh', { method: 'POST', body: '{}' }); await load(); } catch (err) { setStatus('Refresh failed: ' + err.message, true); }
    b.disabled = false;
  });
  $('#form-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const symbol = $('#add-symbol').value.trim().toUpperCase();
    if (!symbol) return;
    try {
      S.cfg = await api('/api/basket', { method: 'POST', body: JSON.stringify({ symbol, type: $('#add-type').value || undefined }) });
      $('#add-symbol').value = '';
      await load();
    } catch (err) { setStatus('Add failed: ' + err.message, true); }
  });
  $('#form-event').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = $('#ev-date').value;
    try {
      S.cfg = await api('/api/events', { method: 'POST', body: JSON.stringify({ date, label: $('#ev-label').value.trim() || date }) });
      $('#ev-label').value = '';
      await load();
    } catch (err) { setStatus('Add failed: ' + err.message, true); }
  });
  document.querySelector('.manage').addEventListener('click', async (e) => {
    const s = e.target.closest('[data-del-sym]'), v = e.target.closest('[data-del-ev]');
    try {
      if (s && confirm(`Remove ${s.dataset.delSym} from the basket?`)) { S.cfg = await api('/api/basket/' + encodeURIComponent(s.dataset.delSym), { method: 'DELETE' }); await load(); }
      if (v) { S.cfg = await api('/api/events/' + v.dataset.delEv, { method: 'DELETE' }); await load(); }
    } catch (err) { setStatus('Update failed: ' + err.message, true); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
}

wire();
render();
load();
schedule();
