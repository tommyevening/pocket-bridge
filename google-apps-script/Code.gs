/**
 * PMS – Google Apps Script for the SECOND Gmail account (the one XTB e-mails are forwarded to).
 *
 * What it does (every 5 minutes):
 *  1. Finds XTB "Potwierdzenie wykonania zleceń" e-mails (also forwarded "Fwd:" ones),
 *     saves each as  My Drive/PMS/inbox/xtb/<messageId>.json  plus its PDF/CSV attachments,
 *     and labels the thread "pms-saved" so it is processed once.
 *  2. Exports Google Docs / Sheets from  My Drive/PMS/notes  to  PMS/notes/_text/*.txt|csv
 *     (native Google files are not readable from the Mac, plain text is).
 * Google Drive for desktop then syncs the PMS folder to the Mac, where pocket-bridge imports the trades.
 *
 * Setup: script.google.com → New project → paste this file → Save → select "setup" → Run → allow access.
 */

const CONFIG = {
  ROOT: 'PMS',
  // Gmail search. Forwarded mails keep the subject (with "Fwd:"), so subject matching works for both.
  QUERY: '(subject:"Potwierdzenie wykonania" OR subject:"Potwierdzenie zleceń" OR subject:"Potwierdzenie zlecen") -label:pms-saved newer_than:90d',
  LABEL: 'pms-saved',
  ATTACHMENT_TYPES: ['application/pdf', 'text/csv', 'text/html', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'],
};

function setup() {
  folder_(['inbox', 'xtb']);
  folder_(['notes', '_text']);
  folder_(['xtb-news']);
  folder_(['data']);
  GmailApp.getUserLabelByName(CONFIG.LABEL) || GmailApp.createLabel(CONFIG.LABEL);
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncXtbMails').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('exportNotes').timeBased().everyMinutes(15).create();
  syncXtbMails();
  exportNotes();
  Logger.log('PMS ready. Folder: My Drive/' + CONFIG.ROOT);
}

function syncXtbMails() {
  const inbox = folder_(['inbox', 'xtb']);
  const label = GmailApp.getUserLabelByName(CONFIG.LABEL) || GmailApp.createLabel(CONFIG.LABEL);
  const threads = GmailApp.search(CONFIG.QUERY, 0, 50);
  threads.forEach((thread) => {
    thread.getMessages().forEach((m) => {
      const id = m.getId();
      if (inbox.getFilesByName(id + '.json').hasNext()) return;
      const attachments = [];
      m.getAttachments({ includeInlineImages: false }).forEach((a, i) => {
        const type = a.getContentType();
        const name = a.getName() || 'attachment-' + i;
        if (CONFIG.ATTACHMENT_TYPES.indexOf(type) === -1 && !/\.(pdf|csv|xlsx|html?)$/i.test(name)) return;
        const file = id + '__' + name.replace(/[^\w.\-]+/g, '_');
        inbox.createFile(a.copyBlob().setName(file));
        attachments.push({ file: file, type: type, size: a.getSize() });
      });
      const meta = {
        id: id,
        date: m.getDate().toISOString(),
        from: m.getFrom(),
        subject: m.getSubject(),
        body: m.getPlainBody().slice(0, 200000),
        attachments: attachments,
        savedAt: new Date().toISOString(),
      };
      // JSON last: the Mac waits for it (and for all listed attachments) before importing.
      inbox.createFile(id + '.json', JSON.stringify(meta, null, 2), 'application/json');
    });
    thread.addLabel(label);
  });
}

function exportNotes() {
  const notes = folder_(['notes']);
  const out = folder_(['notes', '_text']);
  const files = notes.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    const type = f.getMimeType();
    let name, content;
    if (type === MimeType.GOOGLE_DOCS) {
      name = f.getName() + '.txt';
      if (!changed_(out, name, f)) continue;
      content = DocumentApp.openById(f.getId()).getBody().getText();
    } else if (type === MimeType.GOOGLE_SHEETS) {
      name = f.getName() + '.csv';
      if (!changed_(out, name, f)) continue;
      content = SpreadsheetApp.openById(f.getId()).getSheets().map((s) =>
        '# ' + s.getName() + '\n' + s.getDataRange().getDisplayValues().map((r) => r.map(csv_).join(',')).join('\n')).join('\n\n');
    } else continue;
    const existing = out.getFilesByName(name);
    if (existing.hasNext()) existing.next().setContent(content); else out.createFile(name, content, 'text/plain');
  }
}

function changed_(folder, name, source) {
  const it = folder.getFilesByName(name);
  return !it.hasNext() || it.next().getLastUpdated() < source.getLastUpdated();
}

function csv_(v) {
  v = String(v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function folder_(parts) {
  let f = getOrCreate_(DriveApp.getRootFolder(), CONFIG.ROOT);
  parts.forEach((p) => { f = getOrCreate_(f, p); });
  return f;
}

function getOrCreate_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
