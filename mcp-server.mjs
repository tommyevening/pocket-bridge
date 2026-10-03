#!/usr/bin/env node
// MCP server "pms": the personal portfolio system exposed as tools.
// Used by the headless agents (voice questions, daily brief, XTB e-mail import) and usable
// directly from Claude Code / Claude Desktop.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config, getCommand, listCommands, updateCommand } from './lib/store.mjs';
import { valuation, loadTransactions, addTransactions, listNotes, readNote, setSnapshot, loadSnapshot } from './lib/portfolio.mjs';
import { quotes, history, correlations, BENCHMARKS } from './lib/market.mjs';
import { saveReport, listReports, getReport } from './lib/reports.mjs';
import { newsFeed } from './lib/news.mjs';

const server = new McpServer({ name: 'pms', version: '2.0.0' });
const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });
const tool = (name, description, inputSchema, fn) => server.registerTool(name, { description, inputSchema }, async (args) => {
  try { return await fn(args); } catch (e) { return fail(String(e.message || e)); }
});

// ---------- portfolio ----------

tool('get_portfolio',
  `Current portfolio: open positions with live price, value in ${config.baseCurrency}, P&L, day change and weight. include_closed adds closed positions with realized P&L.`,
  { include_closed: z.boolean().optional() },
  async ({ include_closed }) => json(await valuation({ includeClosed: include_closed })));

tool('get_transactions',
  'Executed trades from the ledger (imported from XTB confirmation e-mails), oldest first. Optional filter by XTB symbol.',
  { symbol: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() },
  async ({ symbol, limit = 200 }) => json(loadTransactions().filter((t) => !symbol || t.symbol === symbol.toUpperCase()).slice(-limit)));

tool('add_transactions',
  'Append executed trades to the ledger. Use ONLY for data parsed from an XTB confirmation, or when the user explicitly states they executed a trade. Never invent trades. Duplicates are skipped.',
  {
    transactions: z.array(z.object({
      executedAt: z.string().describe('ISO date-time of execution'),
      symbol: z.string().describe('XTB symbol, e.g. CDR.PL, AAPL.US, SXR8.DE, VUAA.UK'),
      name: z.string().optional(),
      side: z.enum(['BUY', 'SELL']),
      quantity: z.number().positive(),
      price: z.number().positive().describe('Price per unit in instrument currency'),
      currency: z.string().describe('Instrument currency, e.g. PLN, USD, EUR'),
      valueBase: z.number().optional().describe(`Total value in account currency (${config.baseCurrency}) if stated`),
      fxRate: z.number().optional().describe('Conversion rate instrument->account currency if stated'),
      commission: z.number().optional(),
      orderId: z.string().optional(),
    })),
    source_ref: z.string().optional().describe('E-mail/message id or "voice"'),
    source_type: z.enum(['xtb-email', 'manual', 'voice']).optional(),
  },
  async ({ transactions, source_ref, source_type = 'manual' }) => {
    const added = addTransactions(transactions, { type: source_type, ref: source_ref });
    return json({ added: added.length, skippedAsDuplicateOrInvalid: transactions.length - added.length, transactions: added });
  });

tool('set_portfolio_snapshot',
  'REPLACE the opening balance with a full list of currently open positions (e.g. from an xStation screenshot or positions export). Use ONLY when the document clearly shows ALL open positions and the user chose "stan portfela". Trades executed after as_of are applied on top.',
  {
    positions: z.array(z.object({
      symbol: z.string().describe('XTB symbol, e.g. SXR8.DE, NVDA.US, CNDX.UK, SNT.PL'),
      name: z.string().optional(),
      quantity: z.number().positive(),
      avgPrice: z.number().positive().describe('Average open price in instrument currency'),
      currency: z.string().optional(),
    })),
    as_of: z.string().optional().describe('ISO time the snapshot reflects; default now'),
    source: z.string().optional(),
  },
  async ({ positions, as_of, source }) => {
    const prev = loadSnapshot();
    const snap = setSnapshot({ positions, asOf: as_of, source });
    return json({ replaced: Boolean(prev), previousCount: prev?.positions?.length || 0, snapshot: snap });
  });

// ---------- market ----------

tool('get_quotes',
  'Live quotes (price, day change %, currency). Accepts XTB symbols (CDR.PL, AAPL.US) or Yahoo symbols (^GSPC, EURPLN=X, GC=F). Without symbols returns the market overview (indices, FX, gold, oil, VIX, BTC).',
  { symbols: z.array(z.string()).optional() },
  async ({ symbols }) => json(await quotes(symbols?.length ? symbols : BENCHMARKS.map((b) => b.symbol))));

tool('get_price_history',
  'Daily closing prices for a symbol. range: 1mo, 3mo, 6mo, 1y, 2y, 5y.',
  { symbol: z.string(), range: z.enum(['1mo', '3mo', '6mo', '1y', '2y', '5y']).optional() },
  async ({ symbol, range = '6mo' }) => json(await history(symbol, range)));

tool('get_correlations',
  'Correlation matrix (Pearson, daily returns) between symbols. Default: all open positions + S&P 500, WIG20, EUR/PLN, USD/PLN, gold, Brent. Use to relate world events (rates, oil, FX) to holdings.',
  { symbols: z.array(z.string()).optional(), range: z.enum(['3mo', '6mo', '1y', '2y']).optional() },
  async ({ symbols, range = '6mo' }) => {
    let list = symbols;
    if (!list?.length) {
      const v = await valuation();
      list = [...v.positions.map((p) => p.symbol), '^GSPC', 'WIG20.WA', 'EURPLN=X', 'USDPLN=X', 'GC=F', 'BZ=F'];
    }
    return json(await correlations(list.slice(0, 25), range));
  });

tool('get_news',
  'Recent news headlines about the holdings (Yahoo Finance + Google News), newest first, with source, url, tickers and urgency (pilne/wazne/normal). Optional filter by XTB symbol.',
  { symbol: z.string().optional(), limit: z.number().int().min(1).max(150).optional() },
  async ({ symbol, limit = 40 }) => {
    const v = await valuation();
    const items = await newsFeed(v.positions.filter((p) => !p.error), { symbol: symbol?.toUpperCase() });
    return json(items.slice(0, limit).map(({ image, ...n }) => n));
  });

// ---------- notes ----------

tool('list_notes', "List the user's own notes/updates about companies and ETFs (PMS/notes on Google Drive), newest first.", {},
  async () => json(listNotes()));

tool('read_note', 'Read one note by its path as returned by list_notes.', { file: z.string() },
  async ({ file }) => ({ content: [{ type: 'text', text: readNote(file) }] }));

// ---------- reports ----------

const impact = z.object({
  ticker: z.string().optional().describe('Affected holding (XTB symbol) or market, e.g. CDR.PL, USD/PLN'),
  event: z.string().describe('The world event / driver'),
  direction: z.enum(['up', 'down', 'flat']).describe('Expected price direction for the ticker'),
  probability: z.number().min(0).max(100).describe('Subjective probability (%) that the direction materializes within the horizon'),
  horizon: z.enum(['1d', '1w', '1m', '3m', '6m+']).optional(),
  magnitude: z.enum(['low', 'medium', 'high']).optional(),
  rationale: z.string().optional(),
});

tool('save_report',
  `Publish a report to the PMS front page and as an HTML file in ${config.outputDir}. kind: answer (reply to a question), daily (morning brief), alert.`,
  {
    kind: z.enum(['answer', 'daily', 'alert', 'news']),
    title: z.string().describe('Headline, punchy, in Polish, max ~90 chars'),
    dek: z.string().describe('1–2 sentence lead / TL;DR'),
    question: z.string().optional().describe('The original question, for answers'),
    sentiment: z.enum(['bullish', 'bearish', 'neutral', 'mixed']).describe('Overall implication for the portfolio'),
    urgency: z.enum(['pilne', 'wazne', 'normal']).describe('pilne = market-moving for the holdings right now (big surprise, >3% move, earnings/guidance shock, central-bank or tariff decision hitting a holding); wazne = notable; normal = background/analysis'),
    tickers: z.array(z.string()).optional(),
    impacts: z.array(impact).optional(),
    body_html: z.string().describe('Article body as an HTML fragment (h2, p, ul, blockquote, table). No <html>/<head>/<style>.'),
    sources: z.array(z.object({ title: z.string(), url: z.string(), date: z.string().optional() })).optional(),
    command_id: z.string().optional(),
    news: z.object({ title: z.string(), url: z.string(), source: z.string().optional(), publishedAt: z.string().optional() }).optional().describe('For kind=news: the original article'),
  },
  async (args) => json(saveReport(args)));

tool('list_reports', 'Recent reports (newest first) with headline, dek and impacts. Useful to compare with earlier assessments.',
  { limit: z.number().int().min(1).max(100).optional(), kind: z.enum(['answer', 'daily', 'alert', 'news']).optional() },
  async ({ limit = 10, kind }) => json(listReports({ limit, kind }).map(({ bodyHtml, ...r }) => r)));

tool('get_report', 'Full report by id.', { id: z.string() },
  async ({ id }) => (getReport(id) ? json(getReport(id)) : fail(`No report ${id}`)));

// ---------- command queue ----------

const brief = (c) => ({ id: c.id, kind: c.kind, status: c.status, text: c.text, createdAt: c.createdAt, reportId: c.reportId });

tool('list_commands', 'Voice/typed commands received by the bridge, newest first.',
  { status: z.enum(['pending', 'running', 'done', 'failed', 'ignored']).optional(), limit: z.number().int().min(1).max(100).optional() },
  async ({ status, limit }) => json(listCommands({ status, limit }).map(brief)));

tool('get_command', 'Full details of one command.', { id: z.string() }, async ({ id }) => {
  const c = getCommand(id);
  if (!c) return fail(`No command ${id}`);
  const { raw, ...rest } = c;
  return json(rest);
});

tool('complete_command', 'Mark a command done or failed with a short summary.',
  { id: z.string(), status: z.enum(['done', 'failed']).default('done'), summary: z.string().optional() },
  async ({ id, status, summary }) => json(brief(updateCommand(id, { status, resultSummary: summary, finishedAt: new Date().toISOString() }))));

await server.connect(new StdioServerTransport());
