// Shared config + file-based command store used by both the webhook server and the MCP server.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependency). Existing process.env values win.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadEnv(path.join(ROOT, '.env'));

const expandHome = (p) => p.replace(/^~(?=$|\/)/, os.homedir());
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '127.0.0.1',
  webhookPath: process.env.WEBHOOK_PATH || '/pocket/webhook',
  webhookSecret: process.env.POCKET_WEBHOOK_SECRET || '',
  // false = don't check HMAC (Pocket UI doesn't show the secret); keep WEBHOOK_PATH secret instead.
  requireSignature: bool(process.env.REQUIRE_SIGNATURE, true),
  pocketApiKey: process.env.POCKET_API_KEY || '',
  pocketApiBase: process.env.POCKET_API_BASE || 'https://public.heypocketai.com/api/v1',
  // Poll the Public API for new recordings (for plans without webhooks). 0 = off.
  pollIntervalSec: Number(process.env.POLL_INTERVAL_SEC ?? 60),
  // Which events create commands. transcription.completed is the earliest point with text.
  events: (process.env.POCKET_EVENTS || 'transcription.completed,summary.completed')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // Only treat a recording as a command if it is short (voice note, not a meeting)...
  maxDurationSec: Number(process.env.MAX_DURATION_SEC || 180),
  // A recording reaches the PMS only if its FIRST SENTENCE contains one of these phrases (fuzzy, see lib/trigger.mjs).
  // Empty = built-in variants of "XTB news". REQUIRE_TRIGGER=false accepts every short recording (old behaviour).
  requireTrigger: bool(process.env.REQUIRE_TRIGGER, true),
  triggerPhrases: (process.env.TRIGGER_PHRASES || process.env.TRIGGER_KEYWORDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // Root of the PMS workspace. Point it at the Google Drive for desktop folder, e.g.
  // ~/Library/CloudStorage/GoogleDrive-you@gmail.com/My Drive/PMS
  pmsDir: expandHome(process.env.PMS_DIR || path.join(ROOT, 'pms')),
  outputDir: '', // set below: OUTPUT_DIR or <PMS_DIR>/xtb-news
  baseCurrency: (process.env.BASE_CURRENCY || 'PLN').toUpperCase(),
  // Daily portfolio brief, local time. Empty = off.
  dailyBriefTime: process.env.DAILY_BRIEF_TIME ?? '07:30',
  dailyBriefDays: (process.env.DAILY_BRIEF_DAYS || '1,2,3,4,5').split(',').map(Number), // 0=Sun
  // Scan <PMS_DIR>/inbox/xtb for new XTB confirmation e-mails every N seconds. 0 = off.
  ingestIntervalSec: Number(process.env.INGEST_INTERVAL_SEC ?? 60),
  ingestModel: process.env.INGEST_MODEL || '',
  // Periodic news scan over holdings -> "alert" reports (only when something material happened). 0 = off.
  newsScanIntervalMin: Number(process.env.NEWS_SCAN_INTERVAL_MIN ?? 120),
  newsScanHours: (process.env.NEWS_SCAN_HOURS || '8-21').split('-').map(Number),
  newsScanDays: (process.env.NEWS_SCAN_DAYS || '1,2,3,4,5').split(',').map(Number),
  dataDir: path.join(ROOT, 'data', 'commands'),
  autoProcess: bool(process.env.AUTO_PROCESS, true),
  claudeBin: expandHome(process.env.CLAUDE_BIN || '~/.local/bin/claude'),
  claudeModel: process.env.CLAUDE_MODEL || '',
  useChrome: bool(process.env.USE_CHROME, false),
  openReport: bool(process.env.OPEN_REPORT, true),
  notify: bool(process.env.NOTIFY, true),
  jobTimeoutMin: Number(process.env.JOB_TIMEOUT_MIN || 15),
};

config.outputDir = expandHome(process.env.OUTPUT_DIR || path.join(config.pmsDir, 'xtb-news'));
export const pmsPaths = {
  inbox: path.join(config.pmsDir, 'inbox', 'xtb'),
  processed: path.join(config.pmsDir, 'inbox', 'processed'),
  notes: path.join(config.pmsDir, 'notes'),
  data: path.join(config.pmsDir, 'data'),
  reports: config.outputDir,
};
for (const d of [config.dataDir, ...Object.values(pmsPaths)]) fs.mkdirSync(d, { recursive: true });

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJson(file, obj) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2));
  fs.renameSync(file + '.tmp', file);
}

// ---- command store: one JSON file per command, keyed by Pocket recording id ----

const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
const fileFor = (id) => path.join(config.dataDir, `${safeId(id)}.json`);

export function getCommand(id) {
  const f = fileFor(id);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

export function saveCommand(cmd) {
  cmd.updatedAt = new Date().toISOString();
  const f = fileFor(cmd.id);
  fs.writeFileSync(f + '.tmp', JSON.stringify(cmd, null, 2));
  fs.renameSync(f + '.tmp', f);
  return cmd;
}

export function updateCommand(id, patch) {
  const cmd = getCommand(id);
  if (!cmd) throw new Error(`Unknown command: ${id}`);
  return saveCommand({ ...cmd, ...patch });
}

export function listCommands({ status, limit = 20 } = {}) {
  return fs.readdirSync(config.dataDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(config.dataDir, f), 'utf8')))
    .filter((c) => !status || c.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}
