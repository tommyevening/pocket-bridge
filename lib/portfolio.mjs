// Transaction ledger, positions (average cost) and valuation in the base currency (PLN).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, pmsPaths, readJson, writeJson } from './store.mjs';
import { quote, fxRate, series } from './market.mjs';

const ledgerFile = path.join(pmsPaths.data, 'transactions.json');
const snapshotFile = path.join(pmsPaths.data, 'snapshot.json');

export const loadTransactions = () => readJson(ledgerFile, []);

const round = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

function txKey(t) {
  if (t.orderId) return `order:${t.orderId}:${t.symbol}:${t.side}`;
  return 'h:' + crypto.createHash('sha1').update([t.executedAt, t.symbol, t.side, t.quantity, t.price].join('|')).digest('hex').slice(0, 16);
}

// Normalizes and appends transactions, skipping ones already in the ledger. Returns the added ones.
export function addTransactions(list, source) {
  const ledger = loadTransactions();
  const seen = new Set(ledger.map((t) => t.id));
  const added = [];
  for (const raw of list) {
    const t = {
      executedAt: raw.executedAt || raw.executed_at,
      symbol: String(raw.symbol || '').trim().toUpperCase(),
      name: raw.name || undefined,
      side: String(raw.side || '').toUpperCase().startsWith('S') ? 'SELL' : 'BUY',
      quantity: Number(raw.quantity),
      price: Number(raw.price),
      currency: String(raw.currency || '').toUpperCase() || undefined,
      valueBase: raw.valueBase ?? raw.value_account_currency ?? undefined,
      fxRate: raw.fxRate ?? raw.fx_rate ?? undefined,
      commission: raw.commission ?? undefined,
      orderId: raw.orderId ?? raw.order_id ?? undefined,
      source: source?.type || 'manual',
      sourceRef: source?.ref,
    };
    if (!t.symbol || !(t.quantity > 0) || !(t.price > 0) || !t.executedAt) continue;
    t.id = txKey(t);
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    ledger.push(t);
    added.push(t);
  }
  ledger.sort((a, b) => String(a.executedAt).localeCompare(String(b.executedAt)));
  if (added.length) writeJson(ledgerFile, ledger);
  return added;
}

// Opening balance: open positions as shown in xStation at a point in time (quantity + average open price).
// Transactions executed after asOf are applied on top; earlier ones are already reflected in it.
export const loadSnapshot = () => readJson(snapshotFile, null);

export function setSnapshot({ positions: list, asOf, source }) {
  const snap = {
    asOf: asOf || new Date().toISOString(),
    source: source || 'manual',
    positions: list.map((p) => ({
      symbol: String(p.symbol).trim().toUpperCase(), name: p.name || undefined,
      quantity: Number(p.quantity), avgPrice: Number(p.avgPrice ?? p.avg_price ?? p.price),
      currency: p.currency ? String(p.currency).toUpperCase() : undefined,
      costBase: p.costBase ?? undefined,
    })).filter((p) => p.symbol && p.quantity > 0 && p.avgPrice > 0),
  };
  writeJson(snapshotFile, snap);
  return snap;
}

// Average-cost positions per symbol.
export function positions() {
  const pos = new Map();
  const snap = loadSnapshot();
  for (const s of snap?.positions || []) {
    pos.set(s.symbol, {
      symbol: s.symbol, name: s.name, currency: s.currency, quantity: s.quantity, cost: s.quantity * s.avgPrice,
      costBase: s.costBase || 0, costBaseKnown: Boolean(s.costBase), realized: 0, commissions: 0, firstBuy: snap.asOf, lastTrade: snap.asOf,
    });
  }
  for (const t of loadTransactions()) {
    if (snap && Date.parse(t.executedAt) <= Date.parse(snap.asOf)) continue;
    const p = pos.get(t.symbol) || { symbol: t.symbol, name: t.name, currency: t.currency, quantity: 0, cost: 0, costBase: 0, costBaseKnown: true, realized: 0, commissions: 0, firstBuy: null, lastTrade: null };
    p.name = p.name || t.name;
    p.lastTrade = t.executedAt;
    p.commissions += Number(t.commission) || 0;
    if (t.side === 'BUY') {
      p.firstBuy = p.firstBuy || t.executedAt;
      p.quantity += t.quantity;
      p.cost += t.quantity * t.price;
      const base = t.valueBase ?? (t.fxRate ? t.quantity * t.price * t.fxRate : (t.currency === config.baseCurrency ? t.quantity * t.price : null));
      if (base == null) p.costBaseKnown = false; else p.costBase += base;
    } else {
      const avg = p.quantity ? p.cost / p.quantity : 0;
      const avgBase = p.quantity ? p.costBase / p.quantity : 0;
      const q = Math.min(t.quantity, p.quantity);
      p.realized += q * (t.price - avg);
      p.quantity -= q;
      p.cost -= q * avg;
      p.costBase -= q * avgBase;
    }
    pos.set(t.symbol, p);
  }
  return [...pos.values()].map((p) => ({ ...p, quantity: round(p.quantity, 6), avgPrice: p.quantity ? p.cost / p.quantity : null }));
}

// Positions with live prices, values in base currency, P&L and weights.
export async function valuation({ includeClosed = false } = {}) {
  const all = positions();
  const open = all.filter((p) => p.quantity > 1e-9);
  const rows = await Promise.all(open.map(async (p) => {
    try {
      const q = await quote(p.symbol);
      const fx = await fxRate(q.currency || p.currency);
      const value = p.quantity * q.price * fx;
      // Unknown historical FX -> approximate cost with today's rate (flagged).
      const costBase = p.costBaseKnown ? p.costBase : p.cost * (await fxRate(p.currency || q.currency));
      return {
        symbol: p.symbol, yahoo: q.yahoo, name: p.name || q.name, quantity: p.quantity, currency: q.currency,
        avgPrice: round(p.avgPrice, 4), price: round(q.price, 4), changePct: round(q.changePct),
        value: round(value), costBase: round(costBase), costApprox: !p.costBaseKnown,
        pnl: round(value - costBase), pnlPct: round(costBase ? (value / costBase - 1) * 100 : null),
        dayPnl: q.prevClose ? round(p.quantity * (q.price - q.prevClose) * fx) : null,
        realized: round(p.realized, 2), quoteTime: q.time,
      };
    } catch (e) {
      return { symbol: p.symbol, name: p.name, quantity: p.quantity, error: e.message };
    }
  }));
  const total = rows.reduce((s, r) => s + (r.value || 0), 0);
  for (const r of rows) r.weightPct = total ? round((r.value || 0) / total * 100) : null;
  rows.sort((a, b) => (b.value || 0) - (a.value || 0));
  const cost = rows.reduce((s, r) => s + (r.costBase || 0), 0);
  const day = rows.reduce((s, r) => s + (r.dayPnl || 0), 0);
  return {
    baseCurrency: config.baseCurrency,
    asOf: new Date().toISOString(),
    totals: {
      value: round(total), cost: round(cost), pnl: round(total - cost), pnlPct: round(cost ? (total / cost - 1) * 100 : null),
      dayPnl: round(day), dayPct: round(total - day ? day / (total - day) * 100 : null), positions: rows.length,
    },
    positions: rows,
    closed: includeClosed ? all.filter((p) => p.quantity <= 1e-9).map((p) => ({ symbol: p.symbol, name: p.name, realized: round(p.realized), currency: p.currency, lastTrade: p.lastTrade })) : undefined,
  };
}

// ---- notes: the user's own updates about companies / ETFs, dropped into <PMS_DIR>/notes ----

const NOTE_EXT = new Set(['.md', '.txt', '.csv', '.json', '.html']);

export function listNotes() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (NOTE_EXT.has(path.extname(e.name).toLowerCase())) {
        const st = fs.statSync(p);
        out.push({ file: path.relative(pmsPaths.notes, p), modified: st.mtime.toISOString(), bytes: st.size });
      }
    }
  };
  if (fs.existsSync(pmsPaths.notes)) walk(pmsPaths.notes);
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

export function readNote(file) {
  const p = path.resolve(pmsPaths.notes, file);
  if (!p.startsWith(path.resolve(pmsPaths.notes) + path.sep)) throw new Error('Path outside notes folder');
  return fs.readFileSync(p, 'utf8').slice(0, 50_000);
}

// Value over time of the CURRENT open positions in base currency (quantities held constant,
// prices and FX historical). range: 1d (5-min), 5d, 1mo, 3mo, 6mo, 1y.
export async function portfolioHistory(range = '1mo') {
  const open = positions().filter((p) => p.quantity > 1e-9);
  if (!open.length) return { range, points: [] };
  const fxRange = range === '1d' ? '5d' : range; // FX trades 24h; a slightly wider window lets us forward-fill
  const priceSeries = await Promise.all(open.map((p) => series(p.symbol, range).catch(() => null)));
  const ccys = [...new Set(priceSeries.filter(Boolean).map((s) => s.currency).filter((c) => c !== config.baseCurrency))];
  const fxSeries = Object.fromEntries(await Promise.all(ccys.map(async (c) => [c, await series(`${c}${config.baseCurrency}=X`, fxRange).catch(() => null)])));

  // Union timeline: every timestamp any instrument printed.
  const times = [...new Set(priceSeries.flatMap((s) => (s ? s.points.map((p) => p.t) : [])))].sort((a, b) => a - b);
  const at = (pts, t, fallback) => { // last value at or before t (forward fill)
    let lo = 0, hi = pts.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (pts[mid].t <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best >= 0 ? pts[best].close : fallback;
  };
  const points = times.map((t) => {
    let value = 0;
    open.forEach((p, i) => {
      const s = priceSeries[i];
      if (!s) return;
      const px = at(s.points, t, s.prevClose ?? s.points[0]?.close);
      const fx = s.currency === config.baseCurrency ? 1 : at(fxSeries[s.currency]?.points || [], t, fxSeries[s.currency]?.points?.[0]?.close ?? 1);
      value += p.quantity * px * fx;
    });
    return { t, value: Math.round(value * 100) / 100 };
  });
  // Start of the window for change calculation: previous close for intraday, first point otherwise.
  let base = points[0]?.value ?? null;
  if (range === '1d') {
    base = 0;
    open.forEach((p, i) => {
      const s = priceSeries[i];
      if (!s) return;
      const fxPts = fxSeries[s.currency]?.points || [];
      const fx = s.currency === config.baseCurrency ? 1 : (fxPts.find((x) => x.t >= (points[0]?.t ?? 0))?.close ?? fxPts[0]?.close ?? 1);
      base += p.quantity * (s.prevClose ?? s.points[0]?.close ?? 0) * fx;
    });
  }
  const last = points.at(-1)?.value ?? null;
  return {
    range, baseCurrency: config.baseCurrency, base: base && Math.round(base * 100) / 100, points,
    change: last != null && base ? Math.round((last - base) * 100) / 100 : null,
    changePct: last != null && base ? Math.round((last / base - 1) * 10000) / 100 : null,
  };
}
