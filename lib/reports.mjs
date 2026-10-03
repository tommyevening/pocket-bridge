// Structured reports: <reports>/<id>.json (data for the dashboard) + <id>.html (standalone, e.g. for Drive/phone).
import fs from 'node:fs';
import path from 'node:path';
import { pmsPaths, readJson, writeJson, getCommand, updateCommand } from './store.mjs';

export function slugify(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'raport';
}

export function saveReport(input) {
  const createdAt = new Date().toISOString();
  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString();
  const id = `${local.slice(0, 16).replace(/[:T]/g, '-')}_${slugify(input.title)}`;
  const report = {
    id, createdAt,
    kind: input.kind || 'answer',
    title: input.title,
    dek: input.dek || '',
    question: input.question || '',
    sentiment: input.sentiment || 'neutral',
    tickers: (input.tickers || []).map((t) => String(t).toUpperCase()),
    impacts: (input.impacts || []).map((i) => ({ ...i, ticker: i.ticker ? String(i.ticker).toUpperCase() : undefined })),
    bodyHtml: input.body_html || input.bodyHtml || '',
    sources: input.sources || [],
    commandId: input.command_id || input.commandId || undefined,
    news: input.news || undefined,
  };
  report.urgency = urgencyOf(input.urgency, report);
  report.primaryTicker = report.impacts.find((i) => i.ticker && /\./.test(i.ticker))?.ticker || report.tickers[0] || null;
  writeJson(path.join(pmsPaths.reports, `${id}.json`), report);
  const htmlPath = path.join(pmsPaths.reports, `${id}.html`);
  fs.writeFileSync(htmlPath, renderStandalone(report));
  if (report.commandId && getCommand(report.commandId)) updateCommand(report.commandId, { reportId: id, reportPath: htmlPath });
  return { id, htmlPath };
}

// PILNE = market-moving for the portfolio now. The agent decides; this rule is the fallback/upgrade:
// a high-magnitude, likely (>=65%) impact within a day or a week.
function urgencyOf(given, r) {
  const levels = ['normal', 'wazne', 'pilne'];
  let u = levels.includes(given) ? given : r.kind === 'alert' ? 'wazne' : 'normal';
  const hot = r.impacts.some((i) => i.magnitude === 'high' && Number(i.probability) >= 65 && ['1d', '1w'].includes(i.horizon));
  if (hot) u = 'pilne';
  return u;
}

export function listReports({ limit = 30, kind } = {}) {
  if (!fs.existsSync(pmsPaths.reports)) return [];
  return fs.readdirSync(pmsPaths.reports).filter((f) => f.endsWith('.json')).sort().reverse()
    .map((f) => readJson(path.join(pmsPaths.reports, f), null)).filter(Boolean)
    .filter((r) => !kind || r.kind === kind)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function getReport(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  return readJson(path.join(pmsPaths.reports, `${id}.json`), null);
}

// ---------- standalone HTML rendering (shares the visual language of the dashboard) ----------

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DIR = { up: ['▲', 'up'], down: ['▼', 'down'], flat: ['■', 'flat'], neutral: ['■', 'flat'] };

export function renderImpacts(impacts) {
  if (!impacts?.length) return '';
  const rows = impacts.map((i) => {
    const [arrow, cls] = DIR[i.direction] || DIR.flat;
    const p = Math.max(0, Math.min(100, Number(i.probability) || 0));
    return `<tr>
      <td class="tk">${esc(i.ticker || '—')}</td>
      <td>${esc(i.event)}</td>
      <td class="dir ${cls}">${arrow} ${esc(i.direction || '')}</td>
      <td class="prob"><span class="bar"><span style="width:${p}%"></span></span>${p}%</td>
      <td class="muted">${esc(i.horizon || '')}${i.magnitude ? ' · ' + esc(i.magnitude) : ''}</td>
    </tr>${i.rationale ? `<tr class="why"><td></td><td colspan="4">${esc(i.rationale)}</td></tr>` : ''}`;
  }).join('');
  return `<table class="impacts"><thead><tr><th>Walor</th><th>Zdarzenie</th><th>Kierunek</th><th>Szansa</th><th>Horyzont</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderSources(sources) {
  if (!sources?.length) return '';
  return `<ol class="sources">${sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>${s.date ? ` <span class="muted">· ${esc(s.date)}</span>` : ''}</li>`).join('')}</ol>`;
}

export const KIND_LABEL = { daily: 'Poranny brief', answer: 'Odpowiedź', alert: 'Alert', news: 'Analiza newsa', ingest: 'Import' };

function renderStandalone(r) {
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:">
<title>${esc(r.title)}</title><style>${STANDALONE_CSS}</style></head><body><main>
<div class="kicker">${r.urgency === 'pilne' ? '<span class="pilne">PILNE</span> ' : ''}${esc(KIND_LABEL[r.kind] || r.kind)} · ${new Date(r.createdAt).toLocaleString('pl-PL')} <span class="sent ${esc(r.sentiment)}">${esc(r.sentiment)}</span></div>
<h1>${esc(r.title)}</h1>
${r.dek ? `<p class="dek">${esc(r.dek)}</p>` : ''}
${r.question ? `<p class="q">Pytanie: „${esc(r.question)}”</p>` : ''}
${renderImpacts(r.impacts)}
<article>${r.bodyHtml}</article>
${r.sources?.length ? `<h2>Źródła</h2>${renderSources(r.sources)}` : ''}
<p class="disc">Analiza informacyjna wygenerowana automatycznie. Prawdopodobieństwa to subiektywne szacunki modelu, nie rekomendacja inwestycyjna.</p>
</main></body></html>`;
}

const STANDALONE_CSS = `
:root{--bg:#0b0e11;--panel:#12161b;--fg:#e6e8ea;--muted:#8a929b;--line:#232a31;--accent:#f0b90b;--up:#16c784;--down:#ea3943}
@media (prefers-color-scheme:light){:root{--bg:#f7f7f5;--panel:#fff;--fg:#111;--muted:#666;--line:#e4e4e0;--accent:#b7791f;--up:#0a8f5a;--down:#c62828}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 16px 64px}
.kicker{font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
h1{font:800 clamp(26px,5vw,38px)/1.15 Georgia,"Times New Roman",serif;margin:10px 0 8px}
.dek{font-size:19px;color:var(--muted);margin:0 0 16px}.q{font-style:italic;color:var(--muted)}
h2{font:700 13px/1 ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);border-top:1px solid var(--line);padding-top:16px;margin-top:28px}
a{color:var(--accent)} blockquote{border-left:3px solid var(--accent);margin:12px 0;padding:2px 14px;color:var(--muted)}
table{border-collapse:collapse;width:100%;font-size:14px;margin:16px 0} th{font:600 11px ui-monospace,Menlo,monospace;text-transform:uppercase;color:var(--muted);text-align:left;border-bottom:1px solid var(--line);padding:6px}
td{padding:6px;border-bottom:1px solid var(--line);vertical-align:top} tr.why td{border-bottom:1px solid var(--line);color:var(--muted);font-size:13px;padding-top:0}
.tk{font:700 13px ui-monospace,Menlo,monospace}.dir{font-weight:700;white-space:nowrap}.up{color:var(--up)}.down{color:var(--down)}.flat{color:var(--muted)}
.prob{white-space:nowrap;font-family:ui-monospace,Menlo,monospace}.bar{display:inline-block;width:48px;height:6px;background:var(--line);border-radius:3px;margin-right:6px;vertical-align:middle}.bar span{display:block;height:100%;background:var(--accent);border-radius:3px}
.sent{margin-left:8px;padding:2px 6px;border-radius:3px;border:1px solid var(--line)}.sent.bullish{color:var(--up)}.sent.bearish{color:var(--down)}
.pilne{background:var(--down);color:#fff;padding:2px 6px;border-radius:2px;margin-right:6px}.muted{color:var(--muted)}.sources{font-size:14px}.disc{margin-top:32px;font-size:12px;color:var(--muted)}
@media (max-width:600px){table{font-size:13px}td,th{padding:5px 4px}}
`;
