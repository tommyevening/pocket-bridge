#!/usr/bin/env node
// Sends a correctly signed fake Pocket webhook to the local server.
// Usage: npm run test:webhook -- "Co Trump powiedział o ostatnich cłach"  [--url http://127.0.0.1:8787/pocket/webhook]
import crypto from 'node:crypto';
import { config } from '../lib/store.mjs';

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const url = urlIdx >= 0 ? args.splice(urlIdx, 2)[1] : `http://127.0.0.1:${config.port}${config.webhookPath}`;
const text = args.join(' ') || 'Co Trump powiedział o ostatnich cłach';

const payload = {
  event: 'transcription.completed',
  timestamp: new Date().toISOString(),
  user: { id: 'test-user', email: 'test@example.com' },
  recording: { id: `test-${Date.now()}`, title: 'Test voice note', duration: 6, recordingAt: new Date().toISOString(), createdAt: new Date().toISOString() },
  transcript: [{ speaker: 'Speaker 1', text, start: 0, end: 6 }],
};
const body = JSON.stringify(payload);
const ts = String(Date.now());
const sig = crypto.createHmac('sha256', config.webhookSecret).update(`${ts}.${body}`).digest('hex');

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': 'HeyPocket-Webhook/1.0', 'x-heypocket-signature': sig, 'x-heypocket-timestamp': ts },
  body,
});
console.log(res.status, await res.text());
