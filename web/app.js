// PMS Terminal: headline feed (newest first, PILNE highlighted), live portfolio with charts,
// symbol pages, impact radar, ask bar and the "Dodaj operacje" panel.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');

const api = async (path, opts = {}) => {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-pms': '1', ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${path}`);
  return body;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (d) => new Intl.NumberFormat('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (x, d = 0) => (x == null ? '—' : nf(d).format(x));
const signed = (x, d = 0) => (x == null ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${nf(d).format(Math.abs(x))}`);
const pct = (x) => (x == null ? '—' : `${signed(x, 2)}%`);
const cls = (x) => (x == null || Math.abs(x) < 0.005 ? 'flat' : x > 0 ? 'up' : 'down');
const arrow = (x) => ({ up: '▲', down: '▼', flat: '■' }[cls(x)]);
const price = (x) => (x == null ? '—' : nf(x >= 1000 ? 2 : x >= 10 ? 2 : 3).format(x));
const qty = (x) => (x == null ? '—' : new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 4 }).format(x));
const time = (iso) => new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
const day = (iso) => {
  const d = new Date(iso), t = new Date();
  const diff = Math.round((new Date(t.toDateString()) - new Date(d.toDateString())) / 864e5);
  return diff === 0 ? 'Dziś' : diff === 1 ? 'Wczoraj' : d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
};
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 60 ? `${m} min temu` : `${Math.round(m / 60)} godz. temu`; };
const KIND = { daily: 'Poranny brief', answer: 'Odpowiedź', alert: 'Alert', news: 'Analiza newsa' };
const DIR = { up: '▲', down: '▼', flat: '■' };
const dirCls = (d) => (d === 'up' ? 'up' : d === 'down' ? 'down' : 'flat');
const RANGE_LABEL = { '1d': '1D', '5d': '5D', '1mo': '1M', '3mo': '3M', '1y': '1R' };
// Impact tickers like "USD/PLN" -> Yahoo FX symbol for thumbnails.
const toChartSymbol = (t) => { const m = String(t || '').match(/^([A-Z]{3})\/([A-Z]{3})$/); return m ? `${m[1]}${m[2]}=X` : t; };
const isHot = (r) => r.urgency === 'pilne';

// Report bodies are written by an agent from web research: keep a strict allowlist.
const ALLOWED = new Set(['H2', 'H3', 'H4', 'P', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'STRONG', 'EM', 'B', 'I', 'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'BR', 'SPAN', 'CODE', 'SMALL', 'HR', 'SUP', 'SUB']);
function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const walk = (node) => {
    for (const el of [...node.children]) {
      if (!ALLOWED.has(el.tagName)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'svg', 'MATH', 'TEMPLATE'].includes(el.tagName)) { el.remove(); continue; }
        walk(el); el.replaceWith(...el.childNodes); continue;
      }
      const href = el.tagName === 'A' ? el.getAttribute('href') : null;
      for (const a of [...el.attributes]) el.removeAttribute(a.name);
      if (href && /^https?:\/\//i.test(href)) { el.setAttribute('href', href); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      walk(el);
    }
  };
  const root = doc.body.firstElementChild;
  walk(root);
  return root.innerHTML;
}

// ---------- theme ----------
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
if (store.get('pms-theme')) document.documentElement.dataset.theme = store.get('pms-theme');
$('#btn-theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = cur === 'light' ? 'dark' : 'light';
  store.set('pms-theme', document.documentElement.dataset.theme);
  route();
});
$('#dateline').textContent = new Date().toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

// ---------- charts (plain SVG) ----------
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function sparkline(closes, { w = 64, h = 22, ref } = {}) {
  if (!closes || closes.length < 2) return '<svg class="spark"></svg>';
  const base = ref ?? closes[0];
  const min = Math.min(...closes, base), max = Math.max(...closes, base), span = max - min || 1;
  const x = (i) => (i / (closes.length - 1)) * w, y = (v) => h - 2 - ((v - min) / span) * (h - 4);
  const color = closes.at(-1) >= base ? css('--up') : css('--down');
  const d = closes.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

// Area/line chart with baseline, optional reference line, crosshair + tooltip (pointer and keyboard).
function lineChart(el, pts, { base, ref, height = 170, intraday = false, fmt = (v) => money(v, 2), unit = '' } = {}) {
  el.innerHTML = '';
  el.classList.remove('loading');
  if (!pts?.length) { el.innerHTML = '<div class="empty" style="padding:20px 0">Brak danych do wykresu</div>'; return; }
  const W = Math.max(240, el.clientWidth || 360), H = height, pl = 0, pr = 52, pt = 8, pb = 20;
  const vals = pts.map((p) => p.v);
  const extra = [base, ref?.value].filter((x) => x != null);
  let min = Math.min(...vals, ...extra), max = Math.max(...vals, ...extra);
  const padV = (max - min || Math.abs(max) * 0.01 || 1) * 0.08; min -= padV; max += padV;
  const t0 = pts[0].t, t1 = pts.at(-1).t || t0 + 1;
  const X = (t) => pl + ((t - t0) / (t1 - t0 || 1)) * (W - pl - pr);
  const Y = (v) => pt + (1 - (v - min) / (max - min)) * (H - pt - pb);
  const up = vals.at(-1) >= (base ?? vals[0]);
  const color = up ? css('--up') : css('--down');
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${X(t1).toFixed(1)},${H - pb}L${X(t0).toFixed(1)},${H - pb}Z`;
  const gid = `g${Math.random().toString(36).slice(2, 8)}`;
  const ticks = [0, 1, 2, 3].map((i) => min + ((max - min) * i) / 3);
  const xt = [0, 0.33, 0.66, 1].map((f) => pts[Math.min(pts.length - 1, Math.round(f * (pts.length - 1)))].t);
  const fmtT = (t) => (intraday ? new Date(t).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) : new Date(t).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' }));
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" tabindex="0" role="img" aria-label="Wykres, ostatnia wartość ${esc(fmt(vals.at(-1)))}">
    <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".22"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map((v) => `<line class="grid-line" x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis" x="${W - pr + 6}" y="${Y(v) + 3}">${esc(money(v, v >= 1000 ? 0 : 2))}</text>`).join('')}
    ${xt.map((t, i) => `<text class="axis" x="${X(t)}" y="${H - 5}" text-anchor="${i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}">${esc(fmtT(t))}</text>`).join('')}
    ${base != null ? `<line class="base-line" x1="${pl}" x2="${W - pr}" y1="${Y(base)}" y2="${Y(base)}"/>` : ''}
    ${ref ? `<line class="ref-line" x1="${pl}" x2="${W - pr}" y1="${Y(ref.value)}" y2="${Y(ref.value)}"/><text class="ref-label" x="${pl + 4}" y="${Y(ref.value) - 5}">${esc(ref.label)}</text>` : ''}
    <path d="${area}" fill="url(#${gid})"/>
    <path class="line" d="${line}" stroke="${color}"/>
    <g class="hover" style="display:none"><line class="cross" y1="${pt}" y2="${H - pb}"/><circle class="dot" r="4.5" fill="${color}"/></g>
    <rect x="0" y="0" width="${W - pr}" height="${H}" fill="transparent"/>
  </svg>`;
  const svg = $('svg', el), g = $('.hover', svg), tip = document.createElement('div');
  tip.className = 'tip'; tip.style.display = 'none'; el.append(tip);
  const show = (i) => {
    const p = pts[i]; const x = X(p.t), y = Y(p.v);
    g.style.display = ''; $('.cross', g).setAttribute('x1', x); $('.cross', g).setAttribute('x2', x);
    $('.dot', g).setAttribute('cx', x); $('.dot', g).setAttribute('cy', y);
    tip.replaceChildren();
    const b = document.createElement('b'); b.textContent = `${fmt(p.v)}${unit}`;
    const s = document.createElement('span');
    const chg = base != null ? ` · ${pct((p.v / base - 1) * 100)}` : '';
    s.textContent = (intraday ? new Date(p.t).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : new Date(p.t).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' })) + chg;
    tip.append(b, s); tip.style.display = '';
    const scale = el.clientWidth / W;
    tip.style.left = `${Math.min(Math.max(x * scale, 60), el.clientWidth - 60)}px`;
    tip.style.top = `${Math.max(0, y * scale - 52)}px`;
  };
  const hide = () => { g.style.display = 'none'; tip.style.display = 'none'; };
  const nearest = (clientX) => {
    const r = svg.getBoundingClientRect(); const t = t0 + (((clientX - r.left) / r.width) * W - pl) / (W - pl - pr) * (t1 - t0);
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].t < t) lo = m; else hi = m; }
    return Math.abs(pts[lo].t - t) < Math.abs(pts[hi].t - t) ? lo : hi;
  };
  let kb = pts.length - 1;
  svg.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(kb));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') kb = Math.max(0, kb - 1); else if (e.key === 'ArrowRight') kb = Math.min(pts.length - 1, kb + 1); else return;
    e.preventDefault(); show(kb);
  });
}

// ---------- data ----------
let state = { reports: [], portfolio: null, market: [], status: null, sparks: {}, thumbs: {}, history: null, news: [], range: store.get('pms-range') || '1d', tab: store.get('pms-tab') || 'news', newsFilter: 'all' };

async function loadAll() {
  const [reports, portfolio, market, news] = await Promise.all([
    api('/api/reports?limit=60').catch(() => state.reports),
    api('/api/portfolio').catch(() => state.portfolio),
    api('/api/market').catch(() => state.market),
    api('/api/news').catch(() => state.news),
  ]);
  Object.assign(state, { reports, portfolio, market, news });
  const held = (portfolio?.positions || []).map((p) => p.symbol);
  const thumbSyms = [...new Set([...held, ...reports.slice(0, 40).map(thumbSymbol)].filter(Boolean))];
  const [sparks, thumbs] = await Promise.all([
    held.length ? api(`/api/spark?range=1mo&symbols=${encodeURIComponent(held.join(','))}`).catch(() => ({})) : {},
    thumbSyms.length ? api(`/api/spark?range=5d&symbols=${encodeURIComponent(thumbSyms.join(','))}`).catch(() => ({})) : {},
  ]);
  Object.assign(state, { sparks, thumbs });
  renderTape();
  renderBreaking();
}

async function loadHistory() {
  state.history = await api(`/api/portfolio/history?range=${state.range}`).catch(() => state.history);
}

function renderTape() {
  const own = (state.portfolio?.positions || []).filter((p) => !p.error).map((p) => ({ label: p.symbol, price: p.price, changePct: p.changePct, own: true }));
  const mkt = state.market.filter((q) => !q.error).map((q) => ({ label: q.label, price: q.price, changePct: q.changePct }));
  const items = [...own, ...mkt];
  if (!items.length) { $('#tape').innerHTML = '<span class="tick"><span class="px">Brak notowań</span></span>'; return; }
  const html = items.map((i) => `<span class="tick${i.own ? ' own' : ''}"><b>${esc(i.label)}</b><span class="px">${price(i.price)}</span><span class="${cls(i.changePct)}">${arrow(i.changePct)} ${pct(i.changePct)}</span></span>`).join('');
  $('#tape').innerHTML = html + html;
}

function renderBreaking() {
  const r = state.reports.find((x) => isHot(x) && Date.now() - Date.parse(x.createdAt) < 24 * 3600e3);
  const n = state.news.find((x) => x.urgency === 'pilne');
  // The freshest PILNE item wins: a PMS analysis or a raw headline from the feed.
  const pick = r && (!n || r.createdAt >= n.publishedAt) ? { href: `/r/${r.id}`, title: r.title, at: r.createdAt } : n ? { href: `/n/${n.id}`, title: `${n.title}`, at: n.publishedAt, src: n.source } : null;
  const el = $('#breaking');
  el.hidden = !pick;
  if (!pick) return;
  el.href = pick.href;
  el.dataset.link = '';
  el.innerHTML = `<span class="pilne">PILNE</span><span class="t">${esc(pick.title)}</span><span class="time">${pick.src ? esc(pick.src) + ' · ' : ''}${ago(pick.at)}</span>`;
}

// ---------- home ----------
function thumbSymbol(r) { return toChartSymbol(r.primaryTicker || r.impacts?.find((i) => i.ticker)?.ticker || r.tickers?.[0] || null); }

function thumb(r, big = false) {
  const sym = thumbSymbol(r);
  const s = sym && state.thumbs[sym];
  const label = r.primaryTicker || r.impacts?.[0]?.ticker || r.tickers?.[0] || 'Rynek';
  const chg = s?.prevClose && s?.price ? (s.price / s.prevClose - 1) * 100 : null;
  const imp = r.impacts?.find((i) => (i.ticker || '').toUpperCase() === String(label).toUpperCase()) || r.impacts?.[0];
  const spark = s?.closes?.length > 1 ? sparkline(s.closes, { w: big ? 260 : 150, h: big ? 110 : 64 }).replace('class="spark"', '') : '';
  const hot = isHot(r);
  return `<a class="thumb ${hot ? 'hot' : esc(r.sentiment)}" href="/r/${esc(r.id)}" data-link aria-hidden="true" tabindex="-1">
    <span class="tk">${esc(label)}</span>${chg != null ? `<span class="ch ${hot ? '' : cls(chg)}" title="Zmiana w 5 dni">5D ${arrow(chg)} ${pct(chg)}</span>` : ''}
    ${hot ? spark.replace(/stroke="[^"]+"/, 'stroke="#fff"') : spark}
    ${imp ? `<span class="arrow ${dirCls(imp.direction)}">${DIR[imp.direction] || '■'}</span>` : ''}
  </a>`;
}

function urgencyTag(r) { return isHot(r) ? '<span class="pilne">PILNE</span>' : r.urgency === 'wazne' ? '<span class="wazne">WAŻNE</span>' : ''; }

function impactChips(impacts, max = 6) {
  return (impacts || []).slice(0, max).map((i) => `<span class="chip" title="${esc(i.event)}"><span>${esc(i.ticker || 'Rynek')}</span><span class="${dirCls(i.direction)}">${DIR[i.direction] || '■'}</span><span class="p">${Math.round(i.probability ?? 0)}%</span>${i.horizon ? `<span class="p">${esc(i.horizon)}</span>` : ''}</span>`).join('');
}

function renderLead(r) {
  if (!r) {
    return `<section class="lead"><div class="kicker">Witaj w PMS</div><h1>Zadaj pierwsze pytanie albo uruchom poranny brief</h1>
      <p class="dek">Pytania możesz nagrywać na Pockecie albo wpisywać powyżej. Operacje z XTB dodasz przyciskiem „+ Dodaj operacje”.</p></section>`;
  }
  return `<section class="lead${isHot(r) ? ' hot' : ''}"><div class="lead-wrap"><div>
    <div class="kicker">${urgencyTag(r)} ${esc(KIND[r.kind] || r.kind)} <span class="time">${day(r.createdAt)} · ${time(r.createdAt)}</span> <span class="sent ${esc(r.sentiment)}">${esc(r.sentiment)}</span></div>
    <a href="/r/${esc(r.id)}" data-link><h1 class="hl">${esc(r.title)}</h1></a>
    <p class="dek">${esc(r.dek)}</p>
    <div class="chips">${impactChips(r.impacts, 8)}</div></div>
    ${thumb(r, true)}</div>
  </section>`;
}

function renderFeed(list) {
  if (!list.length) return '<div class="empty">Tu pojawią się kolejne nagłówki: odpowiedzi, alerty ze skanu newsów i poranne briefy.</div>';
  return `<ul class="feed">${list.map((r) => `<li class="${esc(r.sentiment)}${isHot(r) ? ' hot' : ''}">
    <div class="t"><b>${time(r.createdAt)}</b>${day(r.createdAt)}</div>
    <div>
      <div class="kicker">${urgencyTag(r)} ${esc(KIND[r.kind] || r.kind)}${r.tickers?.length ? ` <span class="time">${r.tickers.slice(0, 5).map(esc).join(' · ')}</span>` : ''}</div>
      <a href="/r/${esc(r.id)}" data-link><h3 class="hl">${esc(r.title)}</h3></a>
      <p>${r.question ? `<span class="q">„${esc(r.question)}” </span>` : ''}${esc(r.dek)}</p>
      <div class="chips">${impactChips(r.impacts, 4)}</div>
    </div>${thumb(r)}</li>`).join('')}</ul>`;
}

function rangeTabs(current, id) {
  return `<div class="ranges" role="group" aria-label="Zakres" data-ranges="${id}">${Object.entries(RANGE_LABEL).map(([k, l]) => `<button type="button" data-range="${k}" aria-pressed="${k === current}">${l}</button>`).join('')}</div>`;
}

function renderPortfolio() {
  const p = state.portfolio;
  if (!p || !p.positions?.length) {
    return `<div class="panel"><h2>Portfel</h2><div class="empty" style="padding:4px 0"><b>Brak pozycji.</b> Kliknij „+ Dodaj operacje” i wrzuć zrzut ekranu pozycji z xStation albo potwierdzenie transakcji.</div></div>`;
  }
  const t = p.totals, h = state.history;
  const rows = p.positions.map((r) => r.error
    ? `<tr><td><span class="sym">${esc(r.symbol)}</span><span class="nm">brak notowań</span></td><td colspan="4" class="muted">${esc(r.error).slice(0, 40)}</td></tr>`
    : `<tr class="row" data-href="/p/${esc(r.symbol)}" tabindex="0"><td><span class="sym">${esc(r.symbol)}</span><span class="nm">${esc(r.name)}</span></td>
       <td>${sparkline(state.sparks[r.symbol]?.closes)}</td>
       <td><span class="wbar"><span style="width:${Math.min(100, r.weightPct || 0)}%"></span></span>${nf(1).format(r.weightPct || 0)}%</td>
       <td class="${cls(r.changePct)}">${pct(r.changePct)}</td>
       <td class="${cls(r.pnlPct)}" title="${r.costApprox ? 'Koszt przeliczony po bieżącym kursie walut' : ''}">${pct(r.pnlPct)}${r.costApprox ? '*' : ''}</td></tr>`).join('');
  return `<div class="panel" id="pf"><h2>Portfel <span class="live">LIVE · ${esc(p.baseCurrency)}</span></h2>
    <div class="big num">${money(t.value, 2)}<small>${esc(p.baseCurrency)}</small></div>
    <div class="kpis">
      <div class="kpi"><div class="l">Dziś</div><div class="v ${cls(t.dayPnl)}">${arrow(t.dayPnl)} ${signed(t.dayPnl, 2)} <span style="font-weight:500">(${pct(t.dayPct)})</span></div></div>
      <div class="kpi"><div class="l">Wynik łącznie</div><div class="v ${cls(t.pnl)}">${arrow(t.pnl)} ${signed(t.pnl, 2)} <span style="font-weight:500">(${pct(t.pnlPct)})</span></div></div>
    </div>
    <div class="chart-head">${rangeTabs(state.range, 'pf')}<span class="chg ${cls(h?.changePct)}">${h ? `${arrow(h.changePct)} ${pct(h.changePct)}` : ''}</span></div>
    <div class="chart" id="pf-chart"></div>
    <table class="pos" style="margin-top:12px"><thead><tr><th>Walor</th><th>1M</th><th>Waga</th><th>Dziś</th><th>Wynik</th></tr></thead><tbody>${rows}</tbody></table>
    ${rows.includes('*') ? '<p class="hint">* koszt w PLN przeliczony po bieżącym kursie walut (brak kursu z dnia zakupu)</p>' : ''}
  </div>`;
}

function mountPortfolioChart() {
  const el = $('#pf-chart');
  if (!el || !state.history) return;
  lineChart(el, state.history.points.map((p) => ({ t: p.t, v: p.value })), { base: state.history.base, intraday: ['1d', '5d'].includes(state.range), unit: ` ${state.portfolio?.baseCurrency || ''}` });
}

function renderRadar() {
  const held = new Set((state.portfolio?.positions || []).map((p) => p.symbol));
  const latest = new Map();
  for (const r of state.reports.slice(0, 25)) for (const i of r.impacts || []) {
    const k = i.ticker || 'Rynek';
    if (!latest.has(k)) latest.set(k, { ...i, reportId: r.id });
  }
  const items = [...latest.entries()].sort((a, b) => (held.has(b[0]) - held.has(a[0])) || (b[1].probability - a[1].probability)).slice(0, 10);
  if (!items.length) return '';
  return `<div class="panel"><h2>Radar wpływu <span>ostatnie oceny</span></h2><ul class="radar">${items.map(([k, i]) => `
    <li><span class="tk">${esc(k)}</span><a class="ev hl" href="/r/${esc(i.reportId)}" data-link title="${esc(i.event)}">${esc(i.event)}</a>
    <span class="pr ${dirCls(i.direction)}">${DIR[i.direction] || '■'} ${Math.round(i.probability ?? 0)}%</span></li>`).join('')}</ul></div>`;
}

const ST = { pending: 'w kolejce', running: 'pracuje', done: 'gotowe', failed: 'błąd', ignored: 'pominięte' };
const KIND_JOB = { ingest: 'Import', scan: 'Skan', daily: 'Brief', voice: 'Pocket', ask: 'Pytanie' };
function jobsList(list) {
  return list.map((c) => `<li><span class="st ${esc(c.status)}">${ST[c.status] || esc(c.status)}</span>
    <span class="tx" title="${esc(c.resultSummary || c.text)}">${esc(KIND_JOB[c.kind] || '')}${KIND_JOB[c.kind] ? ': ' : ''}${c.reportId ? `<a class="hl" href="/r/${esc(c.reportId)}" data-link>${esc(c.text)}</a>` : esc(c.resultSummary || c.text)}</span></li>`).join('');
}
function renderJobs() {
  const list = (state.status?.commands || []).filter((c) => c.status !== 'ignored').slice(0, 6);
  return list.length ? `<div class="panel"><h2>Zadania</h2><ul class="jobs">${jobsList(list)}</ul></div>` : '';
}

// ---------- news feed (raw headlines about the holdings; analysis on click) ----------
function newsThumb(n) {
  const t = n.tickers[0];
  const s = state.thumbs[t];
  const hot = n.urgency === 'pilne';
  const chg = state.portfolio?.positions?.find((p) => p.symbol === t)?.changePct ?? null;
  if (n.image && !hot) return `<a class="thumb img" href="/n/${esc(n.id)}" data-link aria-hidden="true" tabindex="-1"><img src="${esc(n.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="tk">${esc(t)}</span></a>`;
  const spark = s?.closes?.length > 1 ? sparkline(s.closes, { w: 150, h: 64 }).replace('class="spark"', '') : '';
  return `<a class="thumb ${hot ? 'hot' : chg == null ? '' : chg >= 0 ? 'bullish' : 'bearish'}" href="/n/${esc(n.id)}" data-link aria-hidden="true" tabindex="-1">
    <span class="tk">${esc(t)}</span>${chg != null ? `<span class="ch ${hot ? '' : cls(chg)}" title="Zmiana dziś">${arrow(chg)} ${pct(chg)}</span>` : ''}
    ${hot ? spark.replace(/stroke="[^"]+"/, 'stroke="#fff"') : spark}</a>`;
}

function renderNewsFeed() {
  const held = state.portfolio?.positions || [];
  const items = state.news.filter((n) => state.newsFilter === 'all' || n.tickers.includes(state.newsFilter));
  const counts = Object.fromEntries(held.map((p) => [p.symbol, state.news.filter((n) => n.tickers.includes(p.symbol)).length]));
  const chips = `<div class="filters" role="group" aria-label="Filtr walorów">
    <button type="button" data-nfilter="all" aria-pressed="${state.newsFilter === 'all'}">Wszystkie <span>${state.news.length}</span></button>
    ${held.map((p) => `<button type="button" data-nfilter="${esc(p.symbol)}" aria-pressed="${state.newsFilter === p.symbol}">${esc(p.symbol)} <span class="${cls(p.changePct)}">${arrow(p.changePct)}${pct(p.changePct)}</span> <span>${counts[p.symbol] || 0}</span></button>`).join('')}
  </div>`;
  if (!items.length) return chips + '<div class="empty">Brak newsów dla wybranego waloru w ostatnich 30 dniach.</div>';
  return chips + `<ul class="feed nfeed">${items.slice(0, 80).map((n) => `<li class="${n.urgency === 'pilne' ? 'hot' : ''}">
    <div class="t"><b>${time(n.publishedAt)}</b>${day(n.publishedAt)}</div>
    <div>
      <div class="kicker">${n.urgency === 'pilne' ? '<span class="pilne">PILNE</span>' : n.urgency === 'wazne' ? '<span class="wazne">WAŻNE</span>' : ''} <span class="time">${esc(n.source)}</span>
        ${n.tickers.map((t) => `<span class="chip sm">${esc(t)}</span>`).join('')}</div>
      <a href="/n/${esc(n.id)}" data-link><h3 class="hl">${esc(n.title)}</h3></a>
      <div class="nmeta">${n.reportId ? '<span class="done">✓ Analiza PMS gotowa</span>' : n.analyzing ? '<span class="busy">◌ Analiza w toku…</span>' : '<span class="cta">Analizuj wpływ na portfel →</span>'}</div>
    </div>${newsThumb(n)}</li>`).join('')}</ul>`;
}

function renderHome() {
  // Strictly newest first; PILNE stories are highlighted (banner + red treatment), not re-ordered.
  const [lead, ...feed] = state.reports;
  const tabs = `<div class="tabs" role="tablist">
    <button role="tab" data-tab="news" aria-selected="${state.tab === 'news'}">Newsy o Twoich spółkach <span>${state.news.length}</span></button>
    <button role="tab" data-tab="analyses" aria-selected="${state.tab === 'analyses'}">Analizy PMS <span>${feed.length}</span></button>
  </div>`;
  view.innerHTML = `<div class="grid">
    <div>${renderLead(lead)}${tabs}<div id="tab-body">${state.tab === 'news' ? renderNewsFeed() : renderFeed(feed)}</div></div>
    <aside><div id="pf-wrap">${renderPortfolio()}</div>${renderRadar()}<div id="jobs">${renderJobs()}</div></aside>
  </div>`;
  mountPortfolioChart();
}

function refreshPortfolioPanel() {
  const wrap = $('#pf-wrap');
  if (!wrap) return;
  wrap.innerHTML = renderPortfolio();
  mountPortfolioChart();
}

// ---------- article ----------
function renderImpactsTable(impacts) {
  if (!impacts?.length) return '';
  return `<table class="impacts"><thead><tr><th>Walor</th><th>Zdarzenie</th><th>Kierunek</th><th>Szansa</th><th>Horyzont</th></tr></thead><tbody>${impacts.map((i) => {
    const p = Math.max(0, Math.min(100, Math.round(i.probability ?? 0)));
    return `<tr><td class="tk">${esc(i.ticker || '—')}</td><td>${esc(i.event)}</td><td class="dir ${dirCls(i.direction)}">${DIR[i.direction] || '■'} ${esc(i.direction)}</td>
      <td class="prob"><span class="bar"><span style="width:${p}%"></span></span>${p}%</td><td class="muted">${esc(i.horizon || '')}${i.magnitude ? ' · ' + esc(i.magnitude) : ''}</td></tr>
      ${i.rationale ? `<tr class="why"><td></td><td colspan="4">${esc(i.rationale)}</td></tr>` : ''}`;
  }).join('')}</tbody></table>`;
}

async function renderArticle(id, newsItem) {
  view.innerHTML = '<div class="empty">Ładowanie…</div>';
  let r;
  try { r = await api(`/api/reports/${encodeURIComponent(id)}`); } catch { view.innerHTML = '<div class="empty">Nie znaleziono raportu. <a class="hl" href="/" data-link>Wróć</a></div>'; return; }
  document.title = `${r.title} · PMS`;
  const pos = new Map((state.portfolio?.positions || []).map((p) => [p.symbol, p]));
  const related = [...new Set([...(r.tickers || []), ...(r.impacts || []).map((i) => i.ticker)])].map((t) => pos.get(t)).filter(Boolean);
  view.innerHTML = `<div class="article"><article>
    <a class="back" href="/" data-link>← Strona główna</a>
    <div class="kicker" style="margin-top:18px">${urgencyTag(r)} ${esc(KIND[r.kind] || r.kind)} <span class="time">${new Date(r.createdAt).toLocaleString('pl-PL')}</span> <span class="sent ${esc(r.sentiment)}">${esc(r.sentiment)}</span></div>
    <h1>${esc(r.title)}</h1>
    <p class="dek">${esc(r.dek)}</p>
    ${r.question ? `<p class="question">„${esc(r.question)}”</p>` : ''}
    ${(r.news || newsItem) ? (() => { const n = r.news || newsItem; return `<p class="srcbox">Analiza newsa: <a href="${esc(/^https?:/i.test(n.url) ? n.url : '#')}" target="_blank" rel="noopener noreferrer">„${esc(n.title)}”</a> <span class="muted">· ${esc(n.source || '')}${n.publishedAt ? ' · ' + new Date(n.publishedAt).toLocaleString('pl-PL') : ''}</span></p>`; })() : ''}
    ${renderImpactsTable(r.impacts)}
    <div class="body">${sanitize(r.bodyHtml)}</div>
    ${r.sources?.length ? `<div class="body"><h2>Źródła</h2></div><ol class="sources">${r.sources.map((s) => /^https?:\/\//i.test(s.url) ? `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a>${s.date ? ` <span class="muted">· ${esc(s.date)}</span>` : ''}</li>` : '').join('')}</ol>` : ''}
  </article>
  <aside>
    ${related.length ? `<div class="panel"><h2>Twoje pozycje w tym tekście</h2><table class="pos"><thead><tr><th>Walor</th><th>1M</th><th>Dziś</th><th>Wynik</th></tr></thead><tbody>${related.map((p) => `<tr class="row" data-href="/p/${esc(p.symbol)}" tabindex="0"><td><span class="sym">${esc(p.symbol)}</span><span class="nm">${esc(p.name)}</span></td><td>${sparkline(state.sparks[p.symbol]?.closes)}</td><td class="${cls(p.changePct)}">${pct(p.changePct)}</td><td class="${cls(p.pnlPct)}">${pct(p.pnlPct)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${renderRadar()}
  </aside></div>`;
  window.scrollTo(0, 0);
}

// ---------- symbol page ----------
let symRange = '1mo';
async function renderSymbol(sym, keepScroll = false) {
  if (!keepScroll) view.innerHTML = '<div class="empty">Ładowanie…</div>';
  let d;
  try { d = await api(`/api/symbol/${encodeURIComponent(sym)}?range=${symRange}`); } catch (e) { view.innerHTML = `<div class="empty">Brak danych dla ${esc(sym)}. <a class="hl" href="/" data-link>Wróć</a></div>`; return; }
  const q = d.quote, p = d.position, s = d.series;
  document.title = `${sym} · PMS`;
  const intraday = ['1d', '5d'].includes(symRange);
  const base = intraday && symRange === '1d' ? s.prevClose : s.points[0]?.close;
  const last = s.points.at(-1)?.close, chg = base ? (last / base - 1) * 100 : null;
  view.innerHTML = `<div class="article"><article>
    <a class="back" href="/" data-link>← Strona główna</a>
    <div class="sym-head"><h1>${esc(q.name || sym)}</h1><span class="muted mono">${esc(sym)} · ${esc(q.yahoo)}</span></div>
    <div class="sym-head"><span class="px">${price(q.price)} <small class="muted" style="font-size:14px">${esc(q.currency)}</small></span><span class="chg ${cls(q.changePct)}">${arrow(q.changePct)} ${pct(q.changePct)} dziś</span><span class="live">LIVE</span></div>
    <div class="chart-head">${rangeTabs(symRange, 'sym')}<span class="chg ${cls(chg)}">${arrow(chg)} ${pct(chg)} w okresie</span></div>
    <div class="chart" id="sym-chart"></div>
    ${p ? `<div class="stats">
      <div class="kpi"><div class="l">Ilość</div><div class="v">${qty(p.quantity)}</div></div>
      <div class="kpi"><div class="l">Śr. cena</div><div class="v">${price(p.avgPrice)} ${esc(p.currency)}</div></div>
      <div class="kpi"><div class="l">Wartość</div><div class="v">${money(p.value, 2)} PLN</div></div>
      <div class="kpi"><div class="l">Wynik</div><div class="v ${cls(p.pnl)}">${arrow(p.pnl)} ${signed(p.pnl, 2)} (${pct(p.pnlPct)})</div></div>
      <div class="kpi"><div class="l">Dziś</div><div class="v ${cls(p.dayPnl)}">${arrow(p.dayPnl)} ${signed(p.dayPnl, 2)} PLN</div></div>
      <div class="kpi"><div class="l">Waga</div><div class="v">${nf(1).format(p.weightPct || 0)}%</div></div>
    </div>` : '<p class="hint">Nie masz tego waloru w portfelu.</p>'}
    <h2 class="section-h" style="margin-top:24px">Analizy o ${esc(sym)} <small>${d.reports.length || 'brak'}</small></h2>
    ${renderFeed(d.reports)}
  </article><aside>${renderRadar()}</aside></div>`;
  lineChart($('#sym-chart'), s.points.map((x) => ({ t: x.t, v: x.close })), {
    base, height: 260, intraday, fmt: (v) => price(v), unit: ` ${q.currency}`,
    ref: p?.avgPrice ? { value: p.avgPrice, label: `Śr. cena zakupu ${price(p.avgPrice)}` } : undefined,
  });
  if (!keepScroll) window.scrollTo(0, 0);
}

// ---------- news page: analysis on demand ----------
let newsPoll = null;
async function renderNews(nid) {
  clearTimeout(newsPoll);
  let d;
  try { d = await api(`/api/news/${nid}`); } catch { view.innerHTML = '<div class="empty">Nie znaleziono newsa. <a class="hl" href="/" data-link>Wróć</a></div>'; return; }
  if (d.reportId) return renderArticle(d.reportId, d.item);
  // Start an analysis only if none was ever requested; otherwise keep waiting for the running one.
  if (!d.status) { await api(`/api/news/${nid}/analyze`, { method: 'POST', body: '{}' }).catch(() => {}); d.status = 'pending'; }
  const n = d.item;
  document.title = `${n.title} · PMS`;
  const waiting = d.status === 'failed'
    ? `<div class="analyzing failed"><b>Nie udało się przygotować analizy.</b> <button class="btn" id="retry">Spróbuj ponownie</button></div>`
    : `<div class="analyzing"><div class="spinner" aria-hidden="true"></div><div><b>Claude analizuje ten news pod kątem Twojego portfela…</b><br>
       <span class="muted">${d.status === 'running' ? 'Czyta artykuł i liczy wpływ na pozycje' : d.busyWith ? `Najpierw kończy: „${esc(String(d.busyWith).slice(0, 60))}”${d.queuePosition > 0 ? ` (pozycja ${d.queuePosition + 1} w kolejce)` : ''}` : 'Startuje'} · zwykle 1–2 minuty. Strona odświeży się sama.</span></div></div>`;
  view.innerHTML = `<div class="article"><article>
    <a class="back" href="/" data-link>← Strona główna</a>
    <div class="kicker" style="margin-top:18px">${n.urgency === 'pilne' ? '<span class="pilne">PILNE</span>' : n.urgency === 'wazne' ? '<span class="wazne">WAŻNE</span>' : ''} <span class="time">${esc(n.source)} · ${new Date(n.publishedAt).toLocaleString('pl-PL')}</span></div>
    <h1>${esc(n.title)}</h1>
    <p class="srcbox">Oryginał: <a href="${esc(/^https?:/i.test(n.url) ? n.url : '#')}" target="_blank" rel="noopener noreferrer">${esc(n.source)} ↗</a> · dotyczy: ${n.tickers.map((t) => `<a class="hl mono" href="/p/${esc(t)}" data-link>${esc(t)}</a>`).join(', ')}</p>
    ${waiting}
  </article><aside>${renderRadar()}</aside></div>`;
  $('#retry')?.addEventListener('click', async () => { await api(`/api/news/${nid}/analyze`, { method: 'POST', body: '{}' }).catch(() => {}); renderNews(nid); });
  if (d.status !== 'failed') newsPoll = setTimeout(() => { if (location.pathname === `/n/${nid}`) renderNews(nid); }, 3000);
  window.scrollTo(0, 0);
}

// ---------- routing ----------
async function route() {
  const path = location.pathname;
  let m;
  if ((m = path.match(/^\/r\/([\w-]+)/))) return renderArticle(m[1]);
  if ((m = path.match(/^\/n\/([a-f0-9]{16})/))) return renderNews(m[1]);
  if ((m = path.match(/^\/p\/([\w.^=%-]+)/))) return renderSymbol(decodeURIComponent(m[1]));
  document.title = 'PMS Terminal';
  renderHome();
}
const go = (href) => { history.pushState(null, '', href); route(); };
document.addEventListener('click', async (e) => {
  const tb = e.target.closest('[data-tab]');
  if (tb) { state.tab = tb.dataset.tab; store.set('pms-tab', state.tab); renderHome(); return; }
  const nf = e.target.closest('[data-nfilter]');
  if (nf) { state.newsFilter = nf.dataset.nfilter; $('#tab-body').innerHTML = renderNewsFeed(); return; }
  const rb = e.target.closest('[data-range]');
  if (rb) {
    const group = rb.parentElement.dataset.ranges;
    if (group === 'pf') { state.range = rb.dataset.range; store.set('pms-range', state.range); $('#pf-chart')?.classList.add('loading'); await loadHistory(); refreshPortfolioPanel(); }
    else { symRange = rb.dataset.range; $('#sym-chart')?.classList.add('loading'); renderSymbol(decodeURIComponent(location.pathname.slice(3)), true); }
    return;
  }
  const row = e.target.closest('tr[data-href]');
  if (row) return go(row.dataset.href);
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
document.addEventListener('keydown', (e) => { const row = e.target.closest?.('tr[data-href]'); if (row && e.key === 'Enter') go(row.dataset.href); });
addEventListener('popstate', route);

// ---------- status + actions ----------
let lastDone = null;
async function pollStatus() {
  try {
    const s = await api('/api/status');
    state.status = s;
    const el = $('#status');
    const runningAll = s.commands.filter((c) => c.status === 'running');
    const running = runningAll.find((c) => ['news', 'ask', 'voice'].includes(c.kind)) || runningAll[0];
    el.classList.toggle('busy', Boolean(s.busy));
    const label = { daily: 'poranny brief', ingest: 'import XTB', scan: 'skan newsów', news: 'analiza newsa' };
    $('.txt', el).textContent = running ? `Pracuje: ${label[running.kind] || running.text}${runningAll.length > 1 ? ` +${runningAll.length - 1}` : ''}` : s.queue.length ? `W kolejce: ${s.queue.length}` : 'Gotowy';
    el.title = $('.txt', el).textContent;
    const done = s.commands.filter((c) => c.status === 'done' || c.status === 'failed').map((c) => c.id + c.status).join();
    if (lastDone !== null && done !== lastDone) { await loadAll(); await loadHistory(); if (location.pathname === '/') renderHome(); renderOps(); }
    lastDone = done;
    const jobs = $('#jobs'); if (jobs) jobs.innerHTML = renderJobs();
    if ($('#ops').open) renderOpsJobs();
  } catch { $('#status .txt').textContent = 'Offline'; }
}

$('#ask').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#ask-input');
  const text = input.value.trim();
  if (!text) return;
  input.disabled = true;
  try { await api('/api/ask', { method: 'POST', body: JSON.stringify({ text }) }); input.value = ''; input.placeholder = 'Przyjęte. Odpowiedź pojawi się na górze listy za 2–4 min'; }
  catch { input.placeholder = 'Nie udało się wysłać. Czy serwer działa?'; }
  input.disabled = false;
  pollStatus();
});

$('#btn-daily').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try { await api('/api/daily', { method: 'POST', body: '{}' }); } catch {}
  setTimeout(() => (e.target.disabled = false), 5000);
  pollStatus();
});

// ---------- "Dodaj operacje" ----------
const ops = $('#ops');
const KIND_HINT = {
  transactions: 'Claude odczyta plik (PDF, mail, zrzut ekranu, CSV) i doda transakcje do księgi. Duplikaty (ten sam numer zlecenia) są pomijane.',
  snapshot: 'Uwaga: wrzucony stan ZASTĄPI wszystkie obecne pozycje. Plik musi pokazywać pełną listę otwartych pozycji (wolumen i średnią cenę), np. zrzut z xStation.',
  manual: '',
};
$('#btn-ops').addEventListener('click', () => { renderOps(); ops.showModal(); });
$('#ops-kind').addEventListener('change', (e) => {
  const manual = e.target.value === 'manual';
  $('#ops-upload').hidden = manual;
  $('#ops-manual').hidden = !manual;
  $('#ops-hint').textContent = KIND_HINT[e.target.value];
  $('#ops-hint').classList.toggle('warn', e.target.value === 'snapshot');
  if (manual && !$('#ops-manual [name=executedAt]').value) {
    const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    $('#ops-manual [name=executedAt]').value = d.toISOString().slice(0, 16);
  }
});

async function upload(files) {
  const kind = $('#ops-kind').value;
  if (kind === 'snapshot' && !confirm('Stan portfela zastąpi wszystkie obecne pozycje. Kontynuować?')) return;
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) { alert(`${f.name}: plik większy niż 20 MB`); continue; }
    try {
      await api('/api/operations/upload', { method: 'POST', body: f, headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(f.name), 'x-kind': kind } });
    } catch (e) { alert(`${f.name}: ${e.message}`); }
  }
  pollStatus();
}
const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => upload([...e.dataTransfer.files]));
$('#pick').addEventListener('click', () => $('#file').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } });
$('#file').addEventListener('change', (e) => { upload([...e.target.files]); e.target.value = ''; });
// Dropping a file anywhere on the page opens the panel.
document.addEventListener('dragover', (e) => { if (!ops.open && e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); renderOps(); ops.showModal(); } });

$('#ops-manual').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const num = (v) => Number(String(v).replace(/\s/g, '').replace(',', '.'));
  const t = { symbol: f.get('symbol').trim().toUpperCase(), side: f.get('side'), quantity: num(f.get('quantity')), price: num(f.get('price')), currency: f.get('currency'), executedAt: new Date(f.get('executedAt')).toISOString() };
  try {
    const r = await api('/api/operations/manual', { method: 'POST', body: JSON.stringify({ transactions: [t] }) });
    if (!r.added) alert('Nie dodano transakcji: sprawdź dane albo to duplikat.');
    else { e.target.reset(); await loadAll(); await loadHistory(); if (location.pathname === '/') renderHome(); renderOps(); }
  } catch (err) { alert(err.message); }
});

function renderOpsJobs() {
  const list = (state.status?.commands || []).filter((c) => c.kind === 'ingest').slice(0, 6);
  $('#ops-jobs').innerHTML = list.length ? jobsList(list) : '<li class="muted">Brak importów</li>';
}

async function renderOps() {
  renderOpsJobs();
  const d = await api('/api/transactions').catch(() => null);
  if (!d) return;
  const snap = d.snapshot;
  $('#ops-ledger').innerHTML = `
    ${snap ? `<p class="hint">Stan wyjściowy: ${snap.positions.length} pozycji z ${new Date(snap.asOf).toLocaleString('pl-PL')} (${esc(snap.source)}). Transakcje późniejsze są doliczane.</p>` : ''}
    ${d.transactions.length ? `<table><thead><tr><th>Data</th><th>Walor</th><th>Strona</th><th>Ilość</th><th>Cena</th><th>Źródło</th></tr></thead><tbody>${d.transactions.slice(0, 15).map((t) => `
      <tr><td>${new Date(t.executedAt).toLocaleDateString('pl-PL')}</td><td>${esc(t.symbol)}</td><td class="${t.side === 'BUY' ? 'up' : 'down'}">${t.side === 'BUY' ? '▲ Kupno' : '▼ Sprzedaż'}</td><td>${qty(t.quantity)}</td><td>${price(t.price)} ${esc(t.currency || '')}</td><td class="muted">${esc(t.source)}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Brak transakcji po stanie wyjściowym.</p>'}`;
}

// ---------- boot + live refresh ----------
await loadAll();
await loadHistory();
await pollStatus();
route();
setInterval(pollStatus, 4000);
// Live: quotes, tape and portfolio every 60 s (server caches Yahoo for 60 s).
setInterval(async () => {
  await loadAll();
  await loadHistory();
  if (location.pathname === '/') refreshPortfolioPanel();
  else if (location.pathname.startsWith('/p/') && ['1d', '5d'].includes(symRange)) renderSymbol(decodeURIComponent(location.pathname.slice(3)), true);
}, 60_000);
addEventListener('resize', () => { clearTimeout(window.__rz); window.__rz = setTimeout(() => (location.pathname === '/' ? mountPortfolioChart() : null), 150); });
