// News feed about the holdings: Yahoo Finance search news (US stocks, ETFs, indices) +
// Google News RSS (Polish companies, any name/keyword). Cached, de-duplicated, newest first.
import path from 'node:path';
import crypto from 'node:crypto';
import { pmsPaths, readJson, writeJson } from './store.mjs';
import { toYahoo } from './market.mjs';

const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh) pocket-bridge' };
const indexFile = path.join(pmsPaths.data, 'news-index.json'); // newsId -> { item, reportId, commandId }
const cache = new Map();

const id = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const decode = (s) => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const tag = (xml, t) => decode((xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]);

// What to search for, per holding. Override in <PMS_DIR>/data/news-queries.json:
// { "XTB.PL": { "q": "XTB S.A. broker", "lang": "pl" } }
// Built-in tweaks for names that are also publishers or common words.
const DEFAULT_QUERIES = {
  'XTB.PL': { q: 'XTB (akcje OR spółka OR wyniki OR klientów OR dywidenda OR kurs)', lang: 'pl', excludeSources: ['xtb.com', 'xtb'] },
};

export function queryFor(pos) {
  const overrides = { ...DEFAULT_QUERIES, ...readJson(path.join(pmsPaths.data, 'news-queries.json'), {}) };
  if (overrides[pos.symbol]) return { lang: 'en', ...overrides[pos.symbol] };
  const pl = pos.symbol.endsWith('.PL');
  const name = String(pos.name || pos.symbol.split('.')[0]);
  const etf = /ishares|vanguard|ucits|etf|xtrackers|amundi|spdr|invesco/i.test(name);
  if (etf) {
    const idx = [[/s&p\s*500/i, 'S&P 500'], [/nasdaq[\s-]*100/i, 'Nasdaq 100'], [/europe energy|energy sector/i, 'European energy stocks oil'],
      [/msci world/i, 'MSCI World stocks'], [/emerging/i, 'emerging markets stocks'], [/stoxx\s*600|europe/i, 'European stocks STOXX 600'], [/gold/i, 'gold price']]
      .find(([re]) => re.test(name));
    return { q: idx ? idx[1] : name.replace(/ucits|etf|\(acc\)|acc|usd|eur/gi, '').trim(), lang: 'en', etf: true };
  }
  const clean = name.replace(/\b(S\.?A\.?|Spółka Akcyjna|Spólka Akcyjna|Corp(oration)?|Inc\.?|plc|AG|SE|N\.?V\.?|Ltd\.?)\b/gi, '').replace(/\s+/g, ' ').trim();
  return { q: pl ? `"${clean}"` : clean, lang: pl ? 'pl' : 'en' };
}

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  try {
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    if (hit) return hit.value; // keep serving the last good copy
    throw e;
  }
}

async function yahooNews(symbol) {
  const y = toYahoo(symbol);
  return cached(`y:${y}`, 10 * 60_000, async () => {
    const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(y)}&newsCount=20&quotesCount=0`, { headers: UA });
    if (!res.ok) throw new Error(`Yahoo news ${res.status}`);
    const d = await res.json();
    return (d.news || [])
      .filter((n) => !n.relatedTickers || n.relatedTickers.includes(y)) // Yahoo search is fuzzy; keep items tagged with the ticker
      .map((n) => ({
        id: id(n.link || n.title), title: n.title, url: n.link, source: n.publisher, provider: 'yahoo',
        publishedAt: new Date(n.providerPublishTime * 1000).toISOString(),
        image: n.thumbnail?.resolutions?.find((r) => r.width <= 200)?.url || n.thumbnail?.resolutions?.[0]?.url || null,
      }));
  });
}

async function googleNews(q, lang) {
  const loc = lang === 'pl' ? 'hl=pl&gl=PL&ceid=PL:pl' : 'hl=en-US&gl=US&ceid=US:en';
  return cached(`g:${lang}:${q}`, 10 * 60_000, async () => {
    const res = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:30d')}&${loc}`, { headers: UA });
    if (!res.ok) throw new Error(`Google News ${res.status}`);
    const xml = await res.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 25).map(([, it]) => {
      const source = tag(it, 'source');
      const title = tag(it, 'title').replace(new RegExp(`\\s+-\\s+${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
      const url = tag(it, 'link');
      return { id: id(url || title), title, url, source, provider: 'google', publishedAt: new Date(tag(it, 'pubDate')).toISOString(), image: null };
    });
  });
}

const HOT_WORDS = /(wynik|results|earnings|guidance|prognoz|rekomendac|downgrad|upgrad|przejęci|przejm|acquisi|takeover|emisj|dywidend|dividend|cła|tariff|sankcj|sanction|pozew|lawsuit|profit warning|ostrzeżeni|skup akcji|buyback|umow[aęy] (istotn|znacz)|kontrakt)/i;

// Merged, de-duplicated feed for the given positions (from valuation(): symbol, name, changePct).
export async function newsFeed(positions, { symbol } = {}) {
  const list = positions.filter((p) => !symbol || p.symbol === symbol);
  const perPos = await Promise.all(list.map(async (p) => {
    const q = queryFor(p);
    const sources = [googleNews(q.q, q.lang).catch(() => [])];
    if (!p.symbol.endsWith('.PL')) {
      // Yahoo tags lots of listicles with big tickers – keep only headlines that actually name the company/index.
      const words = [p.symbol.split('.')[0], ...String(q.q).replace(/"/g, '').split(/\s+/).filter((w) => w.length > 2 && !/^(stocks|oil|OR|AND)$/i.test(w) && !/[()]/.test(w))];
      const re = new RegExp(`\\b(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i');
      sources.push(yahooNews(p.symbol).then((l) => l.filter((n) => re.test(n.title))).catch(() => []));
    }
    if (q.etf && q.lang === 'en') sources.push(googleNews(q.q, 'pl').catch(() => [])); // Polish coverage of the index too
    const excluded = (q.excludeSources || []).map((x) => x.toLowerCase());
    return (await Promise.all(sources)).flat()
      .filter((n) => !excluded.some((x) => String(n.source).toLowerCase() === x || String(n.source).toLowerCase().includes(x)))
      .map((n) => ({ ...n, tickers: [p.symbol] }));
  }));

  const index = readJson(indexFile, {});
  const byKey = new Map();
  for (const n of perPos.flat()) {
    if (!n.title || Number.isNaN(Date.parse(n.publishedAt))) continue;
    const key = n.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 70);
    const prev = byKey.get(key);
    if (prev) { prev.tickers = [...new Set([...prev.tickers, ...n.tickers])]; prev.image ||= n.image; continue; }
    byKey.set(key, { ...n });
  }
  const changes = Object.fromEntries(positions.map((p) => [p.symbol, p.changePct]));
  const now = Date.now();
  const items = [...byKey.values()].map((n) => {
    const ageH = (now - Date.parse(n.publishedAt)) / 3600e3;
    const bigMove = n.tickers.some((t) => Math.abs(changes[t] ?? 0) >= 3);
    const hotWord = HOT_WORDS.test(n.title);
    // PILNE: fresh news on a holding that is moving hard today, or fresh news with a market-moving keyword.
    const urgency = ageH <= 12 && (bigMove || hotWord) ? 'pilne' : ageH <= 48 && hotWord ? 'wazne' : 'normal';
    const known = index[n.id];
    return { ...n, urgency, reportId: known?.reportId || null, analyzing: Boolean(known?.commandId && !known?.reportId) };
  });
  return items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 150);
}

export function getNewsEntry(newsId) { return readJson(indexFile, {})[newsId] || null; }

export function setNewsEntry(newsId, patch) {
  const index = readJson(indexFile, {});
  index[newsId] = { ...(index[newsId] || {}), ...patch };
  writeJson(indexFile, index);
  return index[newsId];
}
