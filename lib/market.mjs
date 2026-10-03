// Market data from Yahoo Finance's public chart endpoint (no API key) + XTB symbol mapping.
import path from 'node:path';
import { config, pmsPaths, readJson } from './store.mjs';

const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh) pocket-bridge' };

// XTB suffix -> Yahoo suffix. XTB uses e.g. AAPL.US, CDR.PL, SXR8.DE, VUAA.UK
const SUFFIX = {
  US: '', PL: '.WA', DE: '.DE', UK: '.L', FR: '.PA', NL: '.AS', ES: '.MC', IT: '.MI', CH: '.SW',
  BE: '.BR', PT: '.LS', SE: '.ST', DK: '.CO', NO: '.OL', FI: '.HE', CZ: '.PR', AT: '.VI', IE: '.IR',
};

// Market overview shown in the ticker tape and available to agents as context.
export const BENCHMARKS = [
  { symbol: 'WIG20.WA', name: 'WIG20' },
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: '^NDX', name: 'Nasdaq 100' },
  { symbol: '^GDAXI', name: 'DAX' },
  { symbol: 'EURPLN=X', name: 'EUR/PLN' },
  { symbol: 'USDPLN=X', name: 'USD/PLN' },
  { symbol: 'GC=F', name: 'Złoto' },
  { symbol: 'BZ=F', name: 'Ropa Brent' },
  { symbol: '^VIX', name: 'VIX' },
  { symbol: 'BTC-USD', name: 'Bitcoin' },
];

// Optional manual overrides: <PMS_DIR>/data/symbols.json  {"XYZ.PL": "XYZ.WA"}
export function toYahoo(xtbSymbol) {
  const overrides = readJson(path.join(pmsPaths.data, 'symbols.json'), {});
  const s = String(xtbSymbol).trim().toUpperCase();
  if (overrides[s]) return overrides[s];
  const m = s.match(/^(.+)\.([A-Z]{2})$/);
  if (m && m[2] in SUFFIX) return m[1] + SUFFIX[m[2]];
  return s; // already a Yahoo symbol (e.g. ^GSPC, EURPLN=X) or unknown
}

const cache = new Map(); // key -> { at, value }
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function chart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${symbol}`);
  const r = (await res.json())?.chart?.result?.[0];
  if (!r) throw new Error(`No data for ${symbol}`);
  return r;
}

// London quotes some instruments in pence (GBp).
function normalize(price, currency) {
  if (currency === 'GBp' || currency === 'GBX') return { price: price / 100, currency: 'GBP' };
  return { price, currency: (currency || '').toUpperCase() };
}

export async function quote(symbol) {
  const y = toYahoo(symbol);
  return cached(`q:${y}`, 60_000, async () => {
    const m = (await chart(y, '1d', '1d')).meta;
    const now = normalize(m.regularMarketPrice, m.currency);
    const prev = normalize(m.chartPreviousClose ?? m.previousClose, m.currency);
    return {
      symbol, yahoo: y, name: m.longName || m.shortName || y,
      price: now.price, prevClose: prev.price, currency: now.currency,
      changePct: prev.price ? ((now.price / prev.price) - 1) * 100 : null,
      time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    };
  });
}

export async function quotes(symbols) {
  const out = await Promise.all(symbols.map((s) => quote(s).catch((e) => ({ symbol: s, error: e.message }))));
  return out;
}

export async function fxRate(from, to = config.baseCurrency) {
  from = (from || to).toUpperCase();
  if (from === to) return 1;
  const q = await quote(`${from}${to}=X`);
  return q.price;
}

// Daily closes: [{ date: 'YYYY-MM-DD', close }]
export async function history(symbol, range = '6mo') {
  const y = toYahoo(symbol);
  return cached(`h:${y}:${range}`, 60 * 60_000, async () => {
    const r = await chart(y, range, '1d');
    const closes = r.indicators?.quote?.[0]?.close || [];
    const div = r.meta.currency === 'GBp' ? 100 : 1;
    return (r.timestamp || []).map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] == null ? null : closes[i] / div }))
      .filter((p) => p.close != null);
  });
}

function returns(series) {
  const map = new Map();
  for (let i = 1; i < series.length; i++) map.set(series[i].date, series[i].close / series[i - 1].close - 1);
  return map;
}

function pearson(a, b) {
  const n = a.length;
  if (n < 10) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
  return va && vb ? cov / Math.sqrt(va * vb) : null;
}

// Correlation matrix of daily returns, aligned on common dates.
export async function correlations(symbols, range = '6mo') {
  const rets = await Promise.all(symbols.map(async (s) => returns(await history(s, range).catch(() => []))));
  const matrix = {};
  symbols.forEach((a, i) => {
    matrix[a] = {};
    symbols.forEach((b, j) => {
      const dates = [...rets[i].keys()].filter((d) => rets[j].has(d));
      const r = pearson(dates.map((d) => rets[i].get(d)), dates.map((d) => rets[j].get(d)));
      matrix[a][b] = r == null ? null : Math.round(r * 100) / 100;
    });
  });
  return { range, method: 'Pearson, daily returns', matrix };
}

// Price series for charts. range -> Yahoo interval; intraday cached briefly so charts stay live.
const INTERVAL = { '1d': '5m', '5d': '30m', '1mo': '1d', '3mo': '1d', '6mo': '1d', '1y': '1d', '2y': '1wk', '5y': '1wk' };

export async function series(symbol, range = '1mo') {
  const y = toYahoo(symbol);
  const interval = INTERVAL[range] || '1d';
  const ttl = range === '1d' ? 60_000 : range === '5d' ? 5 * 60_000 : 30 * 60_000;
  return cached(`s:${y}:${range}`, ttl, async () => {
    const r = await chart(y, range, interval);
    const div = r.meta.currency === 'GBp' ? 100 : 1;
    const closes = r.indicators?.quote?.[0]?.close || [];
    // Daily bars from different exchanges carry different opening times – align them on the calendar day.
    const daily = !/m$/.test(interval);
    const points = (r.timestamp || []).map((t, i) => ({ t: daily ? Math.floor(t / 86400) * 86400000 : t * 1000, close: closes[i] == null ? null : closes[i] / div }))
      .filter((p) => p.close != null);
    const prev = r.meta.chartPreviousClose ?? r.meta.previousClose;
    return {
      symbol, yahoo: y, range, interval, currency: normalize(1, r.meta.currency).currency,
      prevClose: prev == null ? null : prev / div,
      price: r.meta.regularMarketPrice / div,
      points,
    };
  });
}
