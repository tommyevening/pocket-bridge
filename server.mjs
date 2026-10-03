#!/usr/bin/env node
// pocket-bridge / PMS: receives HeyPocket webhooks (voice questions), imports XTB trade confirmations
// from the Google Drive PMS folder, runs a daily portfolio brief, and serves the local front page.
// Every job is a headless Claude Code run with the "pms" MCP server.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { ROOT, config, pmsPaths, getCommand, saveCommand, updateCommand, listCommands, readJson, writeJson } from './lib/store.mjs';
import { valuation, portfolioHistory, positions, loadTransactions, loadSnapshot, addTransactions } from './lib/portfolio.mjs';
import { quotes, quote, series, BENCHMARKS } from './lib/market.mjs';
import { listReports, getReport } from './lib/reports.mjs';
import { newsFeed, getNewsEntry, setNewsEntry } from './lib/news.mjs';
import { matchTrigger, DEFAULT_TRIGGERS } from './lib/trigger.mjs';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const bridgeToken = process.env.BRIDGE_TOKEN || '';

// ---------- signature verification ----------

function verifySignature(rawBody, headers) {
  if (!config.webhookSecret) return { ok: false, reason: 'POCKET_WEBHOOK_SECRET not set' };
  const sig = String(headers['x-heypocket-signature'] || '').replace(/^sha256=/, '');
  const ts = String(headers['x-heypocket-timestamp'] || '');
  if (!sig || !ts) return { ok: false, reason: 'missing signature headers' };
  const tsMs = Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > 10 * 60 * 1000) return { ok: false, reason: 'stale timestamp' };
  const mac = crypto.createHmac('sha256', config.webhookSecret).update(`${ts}.`).update(rawBody).digest();
  // Docs don't pin the encoding; accept hex or base64.
  for (const candidate of [mac.toString('hex'), mac.toString('base64')]) {
    const a = Buffer.from(candidate), b = Buffer.from(sig);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true };
  }
  return { ok: false, reason: 'bad signature' };
}

// ---------- transcript extraction ----------

function transcriptToText(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.map((s) => (typeof s === 'string' ? s : s.text || '')).join(' ');
  if (Array.isArray(t.segments)) return transcriptToText(t.segments);
  return t.text || t.content || '';
}

async function fetchTranscript(recordingId) {
  if (!config.pocketApiKey) return '';
  const url = `${config.pocketApiBase}/public/recordings/${encodeURIComponent(recordingId)}?include_transcript=true&include_summarizations=false`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${config.pocketApiKey}` } });
  if (!res.ok) throw new Error(`Pocket API ${res.status}`);
  const body = await res.json();
  return transcriptToText(body?.data?.transcript);
}

function summaryText(summarizations) {
  if (!summarizations) return '';
  const list = Array.isArray(summarizations) ? summarizations : Object.values(summarizations);
  return list.map((s) => s?.summary?.markdown || s?.summary || s?.markdown || s?.content || '')
    .filter((x) => typeof x === 'string').join('\n\n').slice(0, 4000);
}

// Returns { command, reason } — command is the text to execute, or null with a reason to ignore.
function classify(text, durationSec) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return { command: null, reason: 'empty transcript' };
  if (config.requireTrigger) {
    // The trigger phrase decides, regardless of length: "XTB news, ..." in the first sentence -> PMS.
    const t = matchTrigger(clean, config.triggerPhrases.length ? config.triggerPhrases : DEFAULT_TRIGGERS);
    return t.matched ? { command: t.command, reason: null } : { command: null, reason: 'no trigger phrase in first sentence' };
  }
  if (config.maxDurationSec && durationSec && durationSec > config.maxDurationSec) {
    return { command: null, reason: `duration ${Math.round(durationSec)}s > MAX_DURATION_SEC` };
  }
  return { command: clean, reason: null };
}

// ---------- intake ----------

async function ingestWebhook(payload) {
  const event = payload.event;
  const rec = payload.recording || {};
  if (event !== 'poll' && !config.events.includes(event)) return { status: 'skipped', reason: `event ${event} not handled` };
  if (!rec.id) return { status: 'skipped', reason: 'no recording.id' };

  // At-least-once delivery + several events per recording -> dedupe by recording id.
  const existing = getCommand(rec.id);
  if (existing && existing.status !== 'ignored') return { status: 'duplicate', id: rec.id };

  let text = transcriptToText(payload.transcript);
  if (!text) text = await fetchTranscript(rec.id).catch((e) => (log('fetchTranscript failed', e.message), ''));

  // Pocket reports duration in seconds; guard against milliseconds just in case.
  const durationSec = rec.duration > 36000 ? rec.duration / 1000 : rec.duration;
  const { command, reason } = classify(text, durationSec);

  if (!command) {
    // Not addressed to the PMS: keep nothing of the recording's content – only the id, for de-duplication.
    saveCommand({ id: String(rec.id), kind: 'voice', source: 'pocket', status: 'ignored', ignoreReason: reason, text: '', createdAt: existing?.createdAt || new Date().toISOString() });
    log(`[${rec.id}] ignored (${reason})`);
    return { status: 'ignored', id: String(rec.id), reason };
  }

  const cmd = saveCommand({
    id: String(rec.id),
    kind: 'voice',
    source: 'pocket',
    event,
    status: command ? 'pending' : 'ignored',
    ignoreReason: reason || undefined,
    text: command || text,
    title: rec.title || '',
    recordingAt: rec.recordingAt || rec.recording_at || null,
    durationSec: durationSec || null,
    pocketSummary: summaryText(payload.summarizations),
    createdAt: existing?.createdAt || new Date().toISOString(),
    raw: payload,
  });
  log(`[${cmd.id}] ${cmd.status}${reason ? ` (${reason})` : ''}: "${cmd.text.slice(0, 120)}"`);
  if (cmd.status === 'pending') enqueue(cmd.id);
  return { status: cmd.status, id: cmd.id, reason };
}

// ---------- poller: for Pocket plans without webhooks ----------
// Every POLL_INTERVAL_SEC, list recent recordings via the Public API and ingest the new ones
// once their transcript is ready. Recordings made while the Mac was asleep are picked up on wake.

const pollStateFile = path.join(ROOT, 'data', 'poll-state.json');
let polling = false;

async function pocketGet(pathAndQuery) {
  const res = await fetch(`${config.pocketApiBase}${pathAndQuery}`, { headers: { Authorization: `Bearer ${config.pocketApiKey}` } });
  if (!res.ok) throw new Error(`Pocket API ${res.status} ${pathAndQuery} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const recDate = (r) => r.recording_at || r.recordingAt || r.created_at || r.createdAt;

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    // Only recordings made after the bridge was first enabled; never replay the whole history.
    let state = fs.existsSync(pollStateFile) ? JSON.parse(fs.readFileSync(pollStateFile, 'utf8')) : null;
    if (!state) {
      state = { since: new Date().toISOString() };
      fs.writeFileSync(pollStateFile, JSON.stringify(state));
      log(`poller: first run, handling recordings made after ${state.since}`);
    }
    const startDate = new Date(Date.parse(state.since) - 86400_000).toISOString().slice(0, 10);
    const list = await pocketGet(`/public/recordings?start_date=${startDate}&limit=100`);

    for (const rec of list.data || []) {
      if (!rec.id || getCommand(rec.id)) continue;
      if (Date.parse(recDate(rec)) < Date.parse(state.since)) continue;
      const details = (await pocketGet(`/public/recordings/${encodeURIComponent(rec.id)}?include_transcript=true&include_summarizations=true`)).data || {};
      const text = transcriptToText(details.transcript);
      if (!text) continue; // transcription still running – try again next poll
      await ingestWebhook({
        event: 'poll',
        recording: { ...rec, ...details },
        transcript: details.transcript,
        summarizations: details.summarizations,
      });
    }
  } catch (e) {
    log('poller error:', e.message);
  } finally {
    polling = false;
  }
}

// ---------- jobs: one headless Claude run per command, serially ----------
// kind: voice (Pocket), ask (typed on the front page), daily (morning brief), ingest (XTB e-mail import)

const JOBS = {
  voice: { prompt: 'voice.md', tools: ['WebSearch', 'WebFetch', 'mcp__pms'], report: true },
  ask: { prompt: 'voice.md', tools: ['WebSearch', 'WebFetch', 'mcp__pms'], report: true },
  daily: { prompt: 'daily.md', tools: ['WebSearch', 'WebFetch', 'mcp__pms'], report: true },
  ingest: { prompt: 'xtb-parse.md', tools: ['Read', 'mcp__pms__add_transactions', 'mcp__pms__set_portfolio_snapshot', 'mcp__pms__complete_command'], report: false },
  scan: { prompt: 'scan.md', tools: ['WebSearch', 'WebFetch', 'mcp__pms'], report: false },
  news: { prompt: 'news.md', tools: ['WebSearch', 'WebFetch', 'mcp__pms'], report: true },
};

// Two lanes so the user never waits behind background work: "live" = things a person is looking at
// (clicked news, typed/voice questions), "bg" = daily brief, news scans, XTB imports.
const LIVE_KINDS = new Set(['news', 'ask', 'voice']);
const lanes = { live: { q: [], busy: false, current: null }, bg: { q: [], busy: false, current: null } };
const laneOf = (id) => (LIVE_KINDS.has(getCommand(id)?.kind || 'voice') ? 'live' : 'bg');
const queued = () => [...lanes.live.q, ...lanes.bg.q];
const isBusy = () => lanes.live.busy || lanes.bg.busy;
const running = () => [lanes.live.current, lanes.bg.current].filter(Boolean);

function enqueue(id, { first = false } = {}) {
  if (!config.autoProcess || queued().includes(id)) return;
  const lane = laneOf(id);
  if (first) lanes[lane].q.unshift(id); else lanes[lane].q.push(id); // a clicked news jumps ahead in its lane
  drain(lane);
}

async function drain(name) {
  const lane = lanes[name];
  if (lane.busy) return;
  lane.busy = true;
  while (lane.q.length) {
    const id = lane.q.shift();
    lane.current = id;
    try { await runAgent(id); } catch (e) { log(`[${id}] worker error`, e); updateCommand(id, { status: 'failed', error: String(e) }); }
    lane.current = null;
  }
  lane.busy = false;
}

function mcpConfigPath() {
  const p = path.join(ROOT, 'data', 'mcp.generated.json');
  writeJson(p, { mcpServers: { pms: { command: process.execPath, args: [path.join(ROOT, 'mcp-server.mjs')] } } });
  return p;
}

const localDate = (d = new Date()) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

function buildPrompt(cmd, job) {
  const vars = {
    COMMAND_ID: cmd.id,
    COMMAND_TEXT: cmd.text || '',
    SOURCE: cmd.kind === 'ask' ? 'wpisane na stronie PMS' : 'notatka głosowa z Pocket',
    RECORDED_AT: cmd.recordingAt || cmd.createdAt,
    NOW: new Date().toISOString(),
    TODAY: localDate(),
    BASE: config.baseCurrency,
    EXTRA_CONTEXT: cmd.pocketSummary ? `\nPodsumowanie z Pocket (może być nieprecyzyjne):\n"""\n${cmd.pocketSummary}\n"""\n` : '',
    EMAIL_JSON: cmd.emailFile || '',
    ATTACHMENTS: (cmd.attachments || []).join(', ') || '(brak)',
    MESSAGE_ID: cmd.messageId || '',
    ORIGIN: cmd.source === 'upload' ? 'plik wrzucony przez stronę PMS' : 'mail XTB przekazany na konto PMS',
    UPLOAD_KIND: cmd.uploadKind === 'snapshot' ? 'snapshot (stan portfela, zastępuje pozycje)' : 'transakcje',
    LAST_SCAN: cmd.lastScan || 'brak (pierwszy skan, sprawdź ostatnie 24 h)',
    NEWS_TITLE: cmd.news?.title || '',
    NEWS_URL: cmd.news?.url || '',
    NEWS_SOURCE: cmd.news?.source || '',
    NEWS_DATE: cmd.news?.publishedAt || '',
    NEWS_TICKERS: (cmd.news?.tickers || []).join(', '),
  };
  return fs.readFileSync(path.join(ROOT, 'prompts', job.prompt), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

const dashboardUrl = (p = '/') => `http://127.0.0.1:${config.port}${p}`;

function runAgent(id) {
  const cmd = updateCommand(id, { status: 'running', startedAt: new Date().toISOString() });
  const job = JOBS[cmd.kind || 'voice'];
  const args = ['-p', buildPrompt(cmd, job), '--mcp-config', mcpConfigPath(), '--strict-mcp-config', '--output-format', 'text'];
  const allowed = [...job.tools];
  if (config.useChrome && job.report) { args.push('--chrome'); allowed.push('mcp__claude-in-chrome'); }
  args.push('--allowedTools', allowed.join(','));
  const model = cmd.kind === 'ingest' ? (config.ingestModel || config.claudeModel) : config.claudeModel;
  if (model) args.push('--model', model);

  const logFile = path.join(ROOT, 'logs', `${cmd.id}.log`);
  const out = fs.createWriteStream(logFile);
  log(`[${id}] running ${cmd.kind} job… (log: ${logFile})`);
  if (!['ingest', 'scan', 'news'].includes(cmd.kind)) notify('PMS', `${cmd.kind === 'daily' ? 'Przygotowuję poranny brief' : 'Analizuję: ' + cmd.text.slice(0, 80)}`);

  return new Promise((resolve) => {
    const cwd = cmd.kind === 'ingest' ? path.dirname(cmd.emailFile) : pmsPaths.reports;
    const child = spawn(config.claudeBin, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    const timer = setTimeout(() => { log(`[${id}] timeout, killing`); child.kill('SIGTERM'); }, config.jobTimeoutMin * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      out.end();
      const after = getCommand(id);
      const ok = job.report ? Boolean(after.reportId) : after.status === 'done';
      if (after.status === 'running') updateCommand(id, { status: ok ? 'done' : 'failed', exitCode: code, finishedAt: new Date().toISOString() });
      log(`[${id}] finished code=${code} ok=${ok}${after.reportId ? ' report=' + after.reportId : ''}`);
      if (cmd.kind === 'news') {
        // The user is waiting on the news page; it polls and renders the analysis itself.
        setNewsEntry(cmd.news.id, after.reportId ? { reportId: after.reportId } : { commandId: null, failed: true });
      } else if (cmd.kind === 'ingest') finishIngest(getCommand(id));
      else if (cmd.kind === 'scan') {
        const r = after.reportId && getReport(after.reportId);
        if (r) {
          notify(r.urgency === 'pilne' ? 'PILNE · PMS' : 'Nowy alert · PMS', r.title);
          if (r.urgency === 'pilne' && config.openReport) execFile('open', [dashboardUrl(`/r/${r.id}`)]);
        }
      } else if (ok) {
        const r = getReport(after.reportId);
        notify(cmd.kind === 'daily' ? 'Poranny brief gotowy' : 'Odpowiedź gotowa', r?.title || after.reportId);
        if (config.openReport) execFile('open', [dashboardUrl(`/r/${after.reportId}`)]);
      } else {
        notify('PMS: błąd', `Zadanie nie zakończyło się raportem (logs/${cmd.id}.log)`);
      }
      resolve();
    });
  });
}

// ---------- XTB e-mail import: <PMS_DIR>/inbox/xtb/<messageId>.json (+ attachments), written by Apps Script ----------

function scanInbox() {
  let files;
  try { files = fs.readdirSync(pmsPaths.inbox).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    const emailFile = path.join(pmsPaths.inbox, f);
    const meta = readJson(emailFile, null);
    if (!meta?.id) continue;
    const id = `xtb-${String(meta.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    if (getCommand(id)) continue;
    // Google Drive may still be syncing the attachments down – wait until all are present.
    const attachments = (meta.attachments || []).map((a) => path.join(pmsPaths.inbox, a.file || a));
    if (!attachments.every((a) => fs.existsSync(a))) continue;
    saveCommand({
      id, kind: 'ingest', status: 'pending', createdAt: new Date().toISOString(),
      text: meta.subject || 'XTB e-mail', messageId: meta.id, emailFile, attachments,
      source: meta.origin === 'upload' ? 'upload' : 'gmail', uploadKind: meta.uploadKind || 'transactions',
    });
    log(`[${id}] new XTB e-mail: ${meta.subject}`);
    enqueue(id);
  }
}

function finishIngest(cmd) {
  const dest = cmd.status === 'done' ? pmsPaths.processed : path.join(pmsPaths.inbox, '..', 'failed');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of [cmd.emailFile, ...(cmd.attachments || [])]) {
    try { fs.renameSync(f, path.join(dest, path.basename(f))); } catch (e) { log(`move ${f} failed: ${e.message}`); }
  }
  if (cmd.status === 'done') notify('PMS: import XTB', cmd.resultSummary || 'Zaimportowano transakcje');
  else notify('PMS: import XTB nieudany', cmd.resultSummary || cmd.text);
}

// ---------- daily brief scheduler ----------

const schedFile = path.join(ROOT, 'data', 'scheduler.json');

function createDaily({ force = false } = {}) {
  const today = localDate();
  const id = force ? `daily-${today}-${Date.now()}` : `daily-${today}`;
  if (getCommand(id)) return getCommand(id);
  const cmd = saveCommand({ id, kind: 'daily', source: 'scheduler', status: 'pending', text: `Poranny brief ${today}`, createdAt: new Date().toISOString() });
  enqueue(id);
  return cmd;
}

function checkSchedule() {
  if (!config.dailyBriefTime) return;
  const [h, m] = config.dailyBriefTime.split(':').map(Number);
  const now = new Date();
  if (!config.dailyBriefDays.includes(now.getDay())) return;
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
  const state = readJson(schedFile, {});
  if (state.lastDaily === localDate()) return; // also catches up after the Mac wakes up later that day
  writeJson(schedFile, { ...state, lastDaily: localDate() });
  log('scheduler: starting daily brief');
  createDaily();
}

function checkNewsScan() {
  if (!config.newsScanIntervalMin) return;
  const now = new Date();
  const [from, to] = config.newsScanHours;
  if (!config.newsScanDays.includes(now.getDay()) || now.getHours() < from || now.getHours() > to) return;
  const state = readJson(schedFile, {});
  if (state.lastScan && Date.now() - Date.parse(state.lastScan) < config.newsScanIntervalMin * 60_000) return;
  if (lanes.bg.q.length || lanes.bg.busy) return; // never pile up behind other background work
  if (!positions().some((p) => p.quantity > 1e-9)) return;
  writeJson(schedFile, { ...readJson(schedFile, {}), lastScan: now.toISOString() });
  const id = `scan-${Date.now()}`;
  saveCommand({ id, kind: 'scan', source: 'scheduler', status: 'pending', text: 'Skan newsów portfela', lastScan: state.lastScan || null, createdAt: now.toISOString() });
  log('scheduler: news scan');
  enqueue(id);
}

async function currentNews() {
  const v = await valuation();
  return newsFeed(v.positions.filter((p) => !p.error));
}

async function analyzeNews(newsId) {
  const entry = getNewsEntry(newsId);
  if (entry?.reportId && getReport(entry.reportId)) return entry;
  const prev = entry?.commandId && getCommand(entry.commandId);
  // The agent links the report before the process exits; never start a second run in that window.
  if (prev?.reportId) return setNewsEntry(newsId, { reportId: prev.reportId });
  if (prev && ['pending', 'running', 'done'].includes(prev.status)) return entry;
  const item = entry?.item || (await currentNews()).find((n) => n.id === newsId);
  if (!item) throw new Error('news not found');
  const id = `news-${newsId}-${Date.now()}`;
  saveCommand({ id, kind: 'news', source: 'dashboard', status: 'pending', text: item.title, news: item, createdAt: new Date().toISOString() });
  enqueue(id, { first: true });
  return setNewsEntry(newsId, { item, commandId: id, reportId: null, failed: false });
}

// Files dropped on the "Dodaj operacje" panel land in the same inbox as Gmail imports.
const UPLOAD_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.csv', '.txt', '.html', '.htm', '.eml', '.json']);
function saveUpload(name, kind, buf) {
  const ext = path.extname(name).toLowerCase();
  if (!UPLOAD_EXT.has(ext)) throw new Error(`Nieobsługiwany typ pliku ${ext || '(brak)'}. Użyj PDF, PNG/JPG, CSV, EML, HTML lub TXT.`);
  const id = `upload-${Date.now()}`;
  const file = `${id}__${path.basename(name).replace(/[^\w.\-]+/g, '_')}`;
  fs.writeFileSync(path.join(pmsPaths.inbox, file), buf);
  writeJson(path.join(pmsPaths.inbox, `${id}.json`), {
    id, origin: 'upload', uploadKind: kind === 'snapshot' ? 'snapshot' : 'transactions',
    subject: `${kind === 'snapshot' ? 'Stan portfela' : 'Operacje'}: ${name}`, date: new Date().toISOString(), body: '', attachments: [{ file }],
  });
  scanInbox();
  return `xtb-${id}`;
}

// ---------- HTTP ----------

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

// Only the webhook is reachable through the tunnel. Everything else (dashboard, portfolio data, ask)
// must come from this Mac: local socket, no proxy headers, and a localhost Host header (DNS rebinding).
function isLocal(req) {
  const proxied = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['cf-ray'];
  const sock = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const host = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '');
  return sock && host && !proxied;
}

const STATIC = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
function serveStatic(res, file) {
  const p = path.join(ROOT, 'web', file);
  if (!p.startsWith(path.join(ROOT, 'web') + path.sep) || !fs.existsSync(p)) return send(res, 404, { error: 'not found' });
  res.writeHead(200, {
    'content-type': STATIC[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache',
    // Report bodies come from web research: no inline scripts/handlers can run on the dashboard.
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'",
  });
  fs.createReadStream(p).pipe(res);
}

// State-changing local calls need a custom header: a plain cross-site form/fetch can't add it without a CORS preflight.
const csrfOk = (req) => req.headers['x-pms'] === '1';
const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y']);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'POST' && p === config.webhookPath) {
      const raw = await readBody(req);
      // If Pocket doesn't expose its signing secret, the unguessable WEBHOOK_PATH is the protection.
      const v = config.requireSignature ? verifySignature(raw, req.headers) : { ok: true };
      if (!v.ok) {
        log('rejected webhook:', v.reason);
        return send(res, 401, { error: v.reason });
      }
      const payload = JSON.parse(raw.toString('utf8'));
      log(`webhook received: event=${payload.event} recording=${payload.recording?.id} transcript=${Array.isArray(payload.transcript) ? payload.transcript.length + ' segs' : typeof payload.transcript}`);
      // Answer fast (Pocket times out after 30s); work happens in the background queue.
      return send(res, 200, await ingestWebhook(payload));
    }

    // Token-protected entry point (e.g. iOS Shortcuts): POST /command {"text": "..."}
    if (req.method === 'POST' && p === '/command') {
      if (!bridgeToken || req.headers.authorization !== `Bearer ${bridgeToken}`) return send(res, 401, { error: 'unauthorized' });
      const { text } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!text) return send(res, 400, { error: 'text required' });
      const cmd = saveCommand({ id: `ask-${Date.now()}`, kind: 'ask', source: 'shortcut', status: 'pending', text, createdAt: new Date().toISOString() });
      enqueue(cmd.id);
      return send(res, 200, { status: 'pending', id: cmd.id });
    }

    if (!isLocal(req)) return send(res, 404, { error: 'not found' });

    if (req.method === 'GET') {
      if (p === '/' || /^\/(r|p|n)\//.test(p)) return serveStatic(res, 'index.html');
      if (p.startsWith('/assets/')) return serveStatic(res, p.slice('/assets/'.length));
      if (p === '/health') return send(res, 200, { ok: true, queue: queued().length, busy: isBusy() });
      if (p === '/api/portfolio') return send(res, 200, await valuation({ includeClosed: true }));
      if (p === '/api/portfolio/history') return send(res, 200, await portfolioHistory(RANGES.has(url.searchParams.get('range')) ? url.searchParams.get('range') : '1d'));
      if (p === '/api/news') {
        const sym = url.searchParams.get('symbol');
        const items = await currentNews();
        return send(res, 200, sym ? items.filter((n) => n.tickers.includes(sym)) : items);
      }
      if (p.startsWith('/api/news/')) {
        const nid = p.split('/').pop();
        if (!/^[a-f0-9]{16}$/.test(nid)) return send(res, 400, { error: 'bad id' });
        const entry = getNewsEntry(nid);
        const item = entry?.item || (await currentNews()).find((n) => n.id === nid);
        if (!item) return send(res, 404, { error: 'not found' });
        const cmd = entry?.commandId ? getCommand(entry.commandId) : null;
        return send(res, 200, { item, reportId: entry?.reportId || cmd?.reportId || null, status: cmd?.status || (entry?.failed ? 'failed' : null), queuePosition: cmd ? lanes.live.q.indexOf(cmd.id) : -1, busyWith: lanes.live.current && lanes.live.current !== cmd?.id ? getCommand(lanes.live.current)?.text : null });
      }
      if (p === '/api/transactions') return send(res, 200, { snapshot: loadSnapshot(), transactions: loadTransactions().slice(-200).reverse() });
      if (p === '/api/spark') {
        const syms = (url.searchParams.get('symbols') || '').split(',').filter(Boolean).slice(0, 40);
        const range = RANGES.has(url.searchParams.get('range')) ? url.searchParams.get('range') : '1mo';
        const out = await Promise.all(syms.map(async (sym) => {
          try { const s = await series(sym, range); return [sym, { prevClose: s.prevClose, price: s.price, closes: s.points.map((x) => x.close) }]; } catch { return [sym, null]; }
        }));
        return send(res, 200, Object.fromEntries(out));
      }
      if (p.startsWith('/api/symbol/')) {
        const sym = decodeURIComponent(p.slice('/api/symbol/'.length)).toUpperCase();
        if (!/^[\w.^=-]{1,20}$/.test(sym)) return send(res, 400, { error: 'bad symbol' });
        const range = RANGES.has(url.searchParams.get('range')) ? url.searchParams.get('range') : '1mo';
        const [s, q, v] = await Promise.all([series(sym, range), quote(sym), valuation()]);
        const reports = listReports({ limit: 200 }).filter((r) => r.tickers?.includes(sym) || r.impacts?.some((i) => i.ticker === sym)).slice(0, 20).map(({ bodyHtml, ...r }) => r);
        return send(res, 200, { quote: q, series: s, position: v.positions.find((x) => x.symbol === sym) || null, reports });
      }
      if (p === '/api/market') return send(res, 200, (await quotes(BENCHMARKS.map((b) => b.symbol))).map((q, i) => ({ ...q, label: BENCHMARKS[i].name })));
      if (p === '/api/reports') return send(res, 200, listReports({ limit: Number(url.searchParams.get('limit') || 40) }).map(({ bodyHtml, ...r }) => r));
      if (p.startsWith('/api/reports/')) { const r = getReport(p.split('/').pop()); return r ? send(res, 200, r) : send(res, 404, { error: 'not found' }); }
      if (p === '/api/status' || p === '/commands') {
        return send(res, 200, {
          busy: isBusy(), current: running()[0] || null, running: running(), queue: queued(), pmsDir: config.pmsDir, dailyBriefTime: config.dailyBriefTime,
          lastDaily: readJson(schedFile, {}).lastDaily || null,
          commands: listCommands({ limit: 30 }).map(({ raw, ...c }) => c),
        });
      }
    }

    if (req.method === 'POST' && csrfOk(req)) {
      if (p === '/api/ask') {
        const { text } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        if (!text?.trim()) return send(res, 400, { error: 'text required' });
        const cmd = saveCommand({ id: `ask-${Date.now()}`, kind: 'ask', source: 'dashboard', status: 'pending', text: text.trim().slice(0, 2000), createdAt: new Date().toISOString() });
        enqueue(cmd.id);
        return send(res, 200, { status: 'pending', id: cmd.id });
      }
      if (p === '/api/daily') return send(res, 200, { status: 'pending', id: createDaily({ force: true }).id });
      if (p === '/api/ingest') { scanInbox(); return send(res, 200, { ok: true }); }
      if (/^\/api\/news\/[a-f0-9]{16}\/analyze$/.test(p)) {
        try { return send(res, 200, await analyzeNews(p.split('/')[3])); } catch (e) { return send(res, 404, { error: e.message }); }
      }
      if (p === '/api/operations/upload') {
        const name = decodeURIComponent(req.headers['x-filename'] || 'plik');
        const buf = await readBody(req, 20 * 1024 * 1024);
        try { return send(res, 200, { status: 'pending', id: saveUpload(name, req.headers['x-kind'], buf) }); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (p === '/api/operations/manual') {
        const { transactions } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const added = addTransactions(Array.isArray(transactions) ? transactions : [], { type: 'manual', ref: 'dashboard' });
        return send(res, 200, { added: added.length, transactions: added });
      }
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    log('request error', e);
    send(res, 500, { error: 'internal error' });
  }
});

server.listen(config.port, config.host, () => {
  log(`PMS listening on ${dashboardUrl()} | webhook ${config.webhookPath.replace(/[^/]{12}$/, '…')}`);
  log(`PMS dir: ${config.pmsDir} | reports: ${pmsPaths.reports}`);
  // Commands interrupted by a restart go back to the queue.
  for (const c of listCommands({ limit: 200 }).reverse()) {
    if (c.status === 'running') updateCommand(c.id, { status: 'pending' });
    if (c.status === 'running' || c.status === 'pending') enqueue(c.id);
  }
  if (config.pollIntervalSec > 0) {
    if (!config.pocketApiKey) log('WARNING: POLL enabled but POCKET_API_KEY is empty – set it in .env');
    else { log(`poller: checking Pocket every ${config.pollIntervalSec}s`); pollOnce(); setInterval(pollOnce, config.pollIntervalSec * 1000); }
  }
  if (config.ingestIntervalSec > 0) { scanInbox(); setInterval(scanInbox, config.ingestIntervalSec * 1000); }
  if (config.newsScanIntervalMin) { log(`scheduler: news scan every ${config.newsScanIntervalMin} min, ${config.newsScanHours.join('-')}h`); setInterval(checkNewsScan, 60_000); }
  if (config.dailyBriefTime) { log(`scheduler: daily brief at ${config.dailyBriefTime} on days ${config.dailyBriefDays}`); checkSchedule(); setInterval(checkSchedule, 60_000); }
});

function notify(title, text) {
  if (!config.notify || process.platform !== 'darwin') return;
  const q = (s) => JSON.stringify(String(s).slice(0, 200));
  execFile('osascript', ['-e', `display notification ${q(text)} with title ${q(title)}`], () => {});
}
