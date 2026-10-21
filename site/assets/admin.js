// Admin page: upload a new Job Task Overview report into the private data repo
// (which updates the website's job list), and view or download the journals.
// Everything here uses the admin token from the person's profile. Every file in the data
// repo is encrypted (see adminRepo in app.js), and commit messages name nobody.

import {
  $, el, toast, loadSession, clearSession, openSession, adminRepo, b64ToBytes, bytesToB64, journalTable, monthInfo,
  cleanText, nameProblem, nameKey, defaultUsername, issuedPassword, JOURNAL_HEADER,
} from './app.js';
import * as bc from './bc.js';
import { fireworks } from './fireworks.js';

const session = loadSession();
if (!session?.uk) location.replace('index.html?next=admin.html');

const REPORT_PATH = 'input/report.json';
const JOBS = 'generated/jobs.json';
const REQUIRED = ['Project No.', 'Job Description', 'Job Location', 'Owner', 'Project Task No.', 'Status'];
const state = { bundle: null, profile: null, repo: null, uploading: false, settings: null, settingsSha: null, users: {}, busy: false };
const SETTINGS = 'settings.json';
const USERS = 'users.json';

function notice(tone, text) {
  $('#notices').replaceChildren(el('div', { class: `notice notice-${tone}` }, el('div', { class: 'notice-text' }, text)));
}

// ------------------------------------------------------------- the report

// Read one file out of the .xlsx (a zip) so we can check it's the right report.
async function zipText(bytes, wanted) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const names = new TextDecoder();
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('not a zip');
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    if (names.decode(bytes.subarray(at + 46, at + 46 + nameLength)) === wanted) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      if (method === 0) return new TextDecoder().decode(data);
      if (method === 8) return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
      return null;
    }
    at += 46 + skip;
  }
  return null;
}

const unescapeXml = (text) => text.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (m, e) => (
  { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] ?? String.fromCharCode(Number(e.slice(1)))));

// The report's column headings that are missing, or null if this browser can't check.
async function missingColumns(bytes) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('not a zip');
  if (typeof DecompressionStream !== 'function') return null;
  const text = (await zipText(bytes, 'xl/sharedStrings.xml')) ?? (await zipText(bytes, 'xl/worksheets/sheet1.xml'));
  if (text == null) return null;
  const found = new Set([...text.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => unescapeXml(m[1]).replace(/\s+/g, ' ').trim().toLowerCase()));
  return REQUIRED.filter((name) => !found.has(name.toLowerCase()));
}

function step(id, text, tone = 'busy') {
  const list = $('#upload-steps');
  list.hidden = false;
  let item = list.querySelector(`[data-step="${id}"]`);
  if (!item) {
    item = el('li', { dataset: { step: id } });
    list.append(item);
  }
  item.dataset.tone = tone;
  item.replaceChildren(el('span', { class: 'step-icon', 'aria-hidden': 'true' }, { busy: '', ok: '✓', error: '!' }[tone]), el('span', {}, text));
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// To spot an upload of the same report again.
async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Wait for the "Update website and journals" run started by our commit.
async function waitForPublish(sha) {
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const { workflow_runs: runs = [] } = await state.repo.runs(sha);
    const run = runs.find((r) => (r.path || '').endsWith('update.yml'));
    if (run?.status === 'completed') return run;
  }
  return null;
}

async function jobsSummary() {
  try {
    const { data } = await state.repo.readJson(JOBS);
    const rows = data.stats?.rows ? ` (from ${data.stats.rows.toLocaleString('en-NZ')} job task rows in the report)` : '';
    return `The website now has ${data.jobs.length.toLocaleString('en-NZ')} open jobs${rows}. Engineers see them after reloading the page, within a couple of minutes.`;
  } catch {
    return 'The website’s job list has been updated. Engineers see it after reloading the page, within a couple of minutes.';
  }
}

async function upload(file) {
  if (state.uploading || !file) return;
  state.uploading = true;
  $('#dropzone').classList.add('disabled');
  $('#upload-steps').replaceChildren();
  let current = 'check';
  try {
    step('check', `Checking ${file.name}…`);
    if (!/\.xlsx$/i.test(file.name)) throw new Error('That isn’t an .xlsx file. Export the Job Task Overview report from Business Central to Excel.');
    if (file.size > 25 * 1024 * 1024) throw new Error('That file is over 25 MB, which is far too big for a Job Task Overview report.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let missing;
    try {
      missing = await missingColumns(bytes);
    } catch {
      throw new Error('That file can’t be opened as an Excel .xlsx file.');
    }
    if (missing?.length) {
      throw new Error(`This doesn’t look like the Job Task Overview report: it has no ${missing.map((m) => `“${m}”`).join(', ')} column${missing.length > 1 ? 's' : ''}.`);
    }
    step('check', `${file.name} looks like a Job Task Overview report.`, 'ok');

    current = 'upload';
    step('upload', 'Saving it in the private repo…');
    const sha256 = await sha256Hex(bytes);
    const known = await state.repo.readJson(JOBS).catch(() => null);
    if (known?.data?.sha256 === sha256) {
      step('upload', 'This is the same report as the current one, so the job list is already up to date.', 'ok');
      return;
    }
    const existing = await state.repo.file(REPORT_PATH);
    const report = { name: file.name, sha256, uploaded: new Date().toLocaleDateString('en-CA'), xlsx: bytesToB64(bytes) };
    const result = await state.repo.write(REPORT_PATH, new TextEncoder().encode(JSON.stringify(report)),
      'Upload a new job report (admin page)', existing?.sha);
    step('upload', 'Saved in the private repo.', 'ok');

    current = 'publish';
    step('publish', 'Updating the website’s job list. This takes about a minute…');
    const run = await waitForPublish(result.commit);
    if (!run) throw new Error('This is taking longer than usual. Check back in a few minutes; the job list updates on its own.');
    if (run.conclusion !== 'success') {
      throw new Error('The report was saved, but the website couldn’t read it. Check it’s the Job Task Overview export, or look at the “Update website and journals” run in the data repo’s Actions tab.');
    }
    step('publish', await jobsSummary(), 'ok');
    $('#jobs-current').textContent = `Current report: “${file.name}”, uploaded just now.`;
    toast('The job list has been updated.', { tone: 'ok' });
  } catch (error) {
    step(current, error.message, 'error');
  } finally {
    state.uploading = false;
    $('#dropzone').classList.remove('disabled');
    $('#report-file').value = '';
  }
}

function setUpUpload() {
  const zone = $('#dropzone');
  $('#report-file').addEventListener('change', (event) => upload(event.target.files[0]));
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('over');
    upload(event.dataTransfer.files[0]);
  });
}

// --------------------------------------------------------------- journals

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

const money = (text) => (text === '' ? '' : Number(text).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// A .zip holding several files (stored, not compressed: .xlsx files are compressed already).
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const { name, data } of files) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4],
      [18, data.length, 4], [22, data.length, 4], [26, nameBytes.length, 2], [28, 0, 2]]
      .forEach(([at, value, size]) => (size === 4 ? local.setUint32(at, value, true) : local.setUint16(at, value, true)));
    const entry = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4],
      [20, data.length, 4], [24, data.length, 4], [28, nameBytes.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2],
      [36, 0, 2], [38, 0, 4], [42, offset, 4]]
      .forEach(([at, value, size]) => (size === 4 ? entry.setUint32(at, value, true) : entry.setUint16(at, value, true)));
    parts.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, size, 4], [16, offset, 4], [20, 0, 2]]
    .forEach(([at, value, sz]) => (sz === 4 ? end.setUint32(at, value, true) : end.setUint16(at, value, true)));
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

function downloadAll(month, workbooks) {
  saveBlob(makeZip(workbooks), `Engineer timewriting - ${monthInfo(month).label}.zip`);
}

// Several months at once (the ticked ones, oldest first): one month's journal comes as its
// CSV; more come as one .zip, as do the engineer workbooks.
const monthsLabel = (chosen) => (chosen.length === 1 ? monthInfo(chosen[0].month).label
  : `${monthInfo(chosen[0].month).label} to ${monthInfo(chosen[chosen.length - 1].month).label}`);

function downloadJournals(chosen) {
  const csvs = chosen.map((m) => m.csv).filter(Boolean);
  if (csvs.length === 1) download(csvs[0]);
  else saveBlob(makeZip(csvs), `Timewriting journals - ${monthsLabel(chosen)}.zip`);
}

function downloadWorkbooks(chosen) {
  saveBlob(makeZip(chosen.flatMap((m) => m.workbooks.map(m.pick))), `Engineer timewriting - ${monthsLabel(chosen)}.zip`);
}

const TYPES = { csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', md: 'text/markdown' };
function download(file) {
  saveBlob(new Blob([file.data], { type: TYPES[file.name.split('.').pop()] || 'application/octet-stream' }), file.name);
}

async function showJournal(row, month, files) {
  const open = document.querySelector(`tr.journal-row[data-kind="view"][data-month="${month}"]`);
  document.querySelectorAll('tr.journal-row[data-kind="view"]').forEach((tr) => tr.remove());
  if (open) return;
  const cell = el('td', { colspan: 3 }, el('p', { class: 'muted' }, 'Loading the journal…'));
  row.after(el('tr', { class: 'journal-row', dataset: { kind: 'view', month } }, cell));
  try {
    const csv = files.find((f) => f.name.endsWith('.csv'));
    const text = (file) => new TextDecoder().decode(file.data);
    const [header, ...lines] = parseCsv(text(csv)).filter((r) => r.length > 1);
    const readme = files.find((f) => f.name === 'README.md');
    const checksText = readme ? text(readme).split('## Checks')[1] || '' : '';
    const checks = checksText.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
    cell.replaceChildren(
      header && lines.length
        ? journalTable(lines.map((cells) => ({
          cells: cells.map((value, i) => ([2, 3, 4].includes(i) ? money(value) : value)),
          balancing: cells[5] !== '' && cells[6] === '',
        })))
        : el('p', { class: 'muted' }, 'This month’s journal has no lines yet.'),
      el('div', { class: `checks ${checks.length ? 'checks-warn' : 'checks-ok'}` },
        el('strong', {}, checks.length ? 'Check before uploading to Business Central:' : 'No problems found.'),
        checks.length ? el('ul', {}, checks.map((c) => el('li', {}, c))) : null));
  } catch (error) {
    cell.replaceChildren(el('p', { class: 'form-message' }, error.message));
  }
}

// "Include jobs with no hours in the engineer workbooks": remembered on this computer.
const HOURS_ONLY = ' (only jobs with hours).xlsx';
const EMPTY_JOBS_KEY = 'etjm.admin.emptyJobs.v1';
const includeEmptyJobs = () => $('#include-empty')?.checked !== false;

function setUpEmptyJobsOption() {
  const box = $('#include-empty');
  try {
    box.checked = localStorage.getItem(EMPTY_JOBS_KEY) !== 'no';
  } catch { /* storage unavailable: keep the default */ }
  box.addEventListener('change', () => {
    try {
      localStorage.setItem(EMPTY_JOBS_KEY, box.checked ? 'yes' : 'no');
    } catch { /* not remembered */ }
  });
}

// The "Engineer workbooks" lists: one open at a time, closed by a click elsewhere or Escape.
function setUpWorkbookMenus() {
  const openMenus = () => [...document.querySelectorAll('details.workbooks[open]')];
  document.addEventListener('toggle', (e) => {
    if (!e.target.matches?.('details.workbooks') || !e.target.open) return;
    openMenus().forEach((menu) => { if (menu !== e.target) menu.open = false; });
  }, true);
  document.addEventListener('pointerdown', (e) => {
    openMenus().forEach((menu) => { if (!menu.contains(e.target)) menu.open = false; });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    openMenus().forEach((menu) => { menu.open = false; menu.querySelector('summary').focus(); });
  });
}

// The months' journal files from the last load, so the list can be redrawn (say, after signing
// in to Business Central) without fetching them again.
let journalMonths = null;

async function loadJournals() {
  const box = $('#journals');
  try {
    // One encrypted file per month, with a meaningless name: open them all to see which is which.
    const entries = (await state.repo.list('output')).filter((entry) => entry.type === 'file' && entry.name.endsWith('.json'));
    const opened = await Promise.all(entries.map(async (entry) => JSON.parse(new TextDecoder().decode(await state.repo.read(entry.path)))));
    const byMonth = new Map(opened.filter((m) => /^\d{4}-\d{2}$/.test(m?.month || ''))
      .map((m) => [m.month, Object.entries(m.files || {}).map(([name, b64]) => ({ name, data: b64ToBytes(b64) }))]));
    // What each month offers, newest first.
    journalMonths = [...byMonth.keys()].sort().reverse().map((month) => {
      const files = byMonth.get(month);
      // Each engineer's workbook, and (if they have jobs with no hours) a copy without those.
      const workbooks = files.filter((f) => f.name.startsWith('Engineer timewriting') && !f.name.endsWith(HOURS_ONLY));
      const pick = (f) => {
        const short = files.find((g) => g.name === f.name.replace(/\.xlsx$/, HOURS_ONLY));
        return includeEmptyJobs() || !short ? f : { name: f.name, data: short.data };
      };
      return { month, files, csv: files.find((f) => f.name.endsWith('.csv')), workbooks, pick,
        closed: (state.settings?.closedMonths || []).includes(month) };
    });
    renderJournals();
  } catch (error) {
    box.replaceChildren(el('p', { class: 'form-message' }, error.message));
  }
}

function renderJournals() {
  const box = $('#journals');
  const list = journalMonths;
  if (!list) return;
  if (!list.length) {
    box.replaceChildren(el('p', { class: 'muted' }, 'No journals yet. They appear here once engineers save their timesheets.'));
    return;
  }
  const sending = Boolean(bcState.target); // signed in to Business Central

  // Ticking months swaps each month's buttons for ones under the list that do all the ticked months.
  const selected = new Set();
  const ticks = new Map();
  const rows = new Map();
  const table = el('table', { class: 'sheets journals' });
  const bulk = el('div', { class: 'bulk-bar', role: 'region', 'aria-label': 'The ticked months', hidden: true });
  const allTick = el('input', { type: 'checkbox', class: 'pick', 'aria-label': 'Tick every month' });
  const refresh = () => {
    const chosen = list.filter((m) => selected.has(m.month)).reverse(); // oldest first
    table.classList.toggle('selecting', chosen.length > 0);
    if (chosen.length) table.querySelectorAll('details.workbooks[open]').forEach((menu) => { menu.open = false; });
    for (const [month, tick] of ticks) {
      tick.checked = selected.has(month);
      tick.closest('tr')?.classList.toggle('picked', tick.checked);
    }
    allTick.checked = chosen.length === list.length;
    allTick.indeterminate = chosen.length > 0 && chosen.length < list.length;
    bulk.hidden = !chosen.length;
    if (!chosen.length) return;
    const csvs = chosen.filter((m) => m.csv).length;
    const workbooks = chosen.reduce((sum, m) => sum + m.workbooks.length, 0);
    bulk.replaceChildren(
      el('span', { class: 'bulk-count' }, `${chosen.length} month${chosen.length === 1 ? '' : 's'} ticked`),
      sending ? el('button', { class: 'btn btn-primary', type: 'button', disabled: !csvs, onclick: (e) => sendMonths(chosen, rows, e.currentTarget) },
        'Send to Business Central') : null,
      el('button', { class: `btn${sending ? '' : ' btn-primary'}`, type: 'button', disabled: !csvs, onclick: () => downloadJournals(chosen) },
        'Download all journal CSVs'),
      el('button', { class: 'btn', type: 'button', disabled: !workbooks, onclick: () => downloadWorkbooks(chosen) },
        'Download all engineer workbooks'),
      el('button', { class: 'link-btn', type: 'button', onclick: () => { selected.clear(); refresh(); } }, 'Clear'));
  };
  allTick.addEventListener('change', () => {
    if (allTick.checked) list.forEach((m) => selected.add(m.month));
    else selected.clear();
    refresh();
  });

  const body = list.map((entry) => {
    const { month, files, csv, workbooks, pick, closed } = entry;
    const tick = el('input', { type: 'checkbox', class: 'pick', 'aria-label': `Tick ${monthInfo(month).label}`, onchange: (e) => {
      if (e.currentTarget.checked) selected.add(month); else selected.delete(month);
      refresh();
    } });
    ticks.set(month, tick);
    const row = el('tr', { dataset: { month } },
      el('th', { scope: 'row' }, el('label', { class: 'month-pick' }, tick,
        el('span', {}, monthInfo(month).label,
          closed ? el('span', { class: 'chip chip-muted chip-inline' }, 'Closed') : null,
          el('span', { class: 'row-note' }, `${workbooks.length} engineer${workbooks.length === 1 ? '' : 's'}`)))),
      el('td', { class: 'download-cell' },
        csv && (sending
          ? el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: (e) => sendMonth(entry, e.currentTarget.closest('tr'), { button: e.currentTarget }) }, 'Send to Business Central')
          : el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => download(csv) }, 'Journal CSV')),
        workbooks.length ? el('details', { class: 'workbooks', name: 'workbooks' }, el('summary', { class: 'btn btn-sm' }, 'Engineer workbooks'),
          el('div', { class: 'workbook-list' },
            workbooks.length > 1 ? el('button', { class: 'link-btn link-all', type: 'button', onclick: () => downloadAll(month, workbooks.map(pick)) }, `All (${workbooks.length}, as one .zip)`) : null,
            workbooks.map((f) => el('button', { class: 'link-btn', type: 'button', onclick: () => download(pick(f)) },
            f.name.replace(/^Engineer timewriting - /, '').replace(/ - [A-Za-z]+ \d{4}\.xlsx$/, ''))))) : null),
      el('td', { class: 'row-actions' },
        el('button', { class: 'btn btn-sm', type: 'button', onclick: (e) => showJournal(e.currentTarget.closest('tr'), month, files) }, 'View'),
        el('button', { class: 'btn btn-sm', type: 'button', title: closed ? 'Let engineers change this month again' : 'Freeze this month once its journal is in Business Central', onclick: (e) => setClosed(month, !closed, e.currentTarget) }, closed ? 'Reopen' : 'Close')));
    rows.set(month, row);
    return row;
  });
  table.replaceChildren(
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col' }, el('label', { class: 'month-pick' }, allTick, el('span', {}, 'Month'))),
      el('th', { scope: 'col' }, sending ? 'Journal' : 'Download'), el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Actions')))),
    el('tbody', {}, body));
  box.replaceChildren(table, bulk);
  refresh();
}

// --------------------------------------------------------- Business Central

// The settings (in settings.json, under "businessCentral"), filled in once.
const BC_FIELDS = [
  ['tenant', 'Directory (tenant) ID', 'From the app registration (see How to set it up), or your organisation’s domain.', true],
  ['clientId', 'Application (client) ID', 'From the app registration.', true],
  ['batch', 'Journal batch', 'The Job G/L Journal batch the lines go into.', true],
  ['capexAccount', 'G/L account for CAPEX job lines', 'The CSV’s job lines have no GL: this is where CAPEX hours go.', true],
  ['revexAccount', 'G/L account for REVEX job lines', 'And where REVEX hours go.', true],
  ['company', 'Company', 'Leave empty if you only have one.', false],
  ['template', 'Journal template', 'Leave empty: it’s found from the lines in the batch.', false],
  ['environment', 'Environment', 'Production, unless you try it in a sandbox first.', false],
  ['service', 'Web service name', 'What page 1020 is published as.', false],
];
const BC_DEFAULTS = { environment: 'Production', service: 'JobGLJournal' };
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BC_RULES = {
  tenant: [(v) => GUID_RE.test(v) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v), 'The Directory (tenant) ID looks like 1b2c3d4e-5f60-7a8b-9c0d-1e2f3a4b5c6d (or use a domain like example.co.nz).'],
  clientId: [(v) => GUID_RE.test(v), 'The Application (client) ID looks like 1b2c3d4e-5f60-7a8b-9c0d-1e2f3a4b5c6d.'],
  batch: [(v) => v.length <= 10, 'Journal batch names are at most 10 characters.'],
  capexAccount: [(v) => v.length <= 20, 'G/L account numbers are at most 20 characters.'],
  revexAccount: [(v) => v.length <= 20, 'G/L account numbers are at most 20 characters.'],
  company: [(v) => v.length <= 30, 'Company names are at most 30 characters.'],
  template: [(v) => v.length <= 10, 'Journal template names are at most 10 characters.'],
  environment: [(v) => /^[A-Za-z0-9_-]{1,30}$/.test(v), 'The environment name is letters, numbers, - and _ (like Production).'],
  service: [(v) => /^[A-Za-z0-9_]{1,240}$/.test(v), 'Web service names are letters, numbers and _.'],
};
const CODES = ['batch', 'template', 'capexAccount', 'revexAccount']; // Business Central keeps codes in capitals
const bcConfig = () => ({ ...BC_DEFAULTS, ...(state.settings?.businessCentral || {}) });
const bcConfigured = (cfg = bcConfig()) => BC_FIELDS.every(([key, , , required]) => !required || String(cfg[key] || '').trim());

// Signed in to Business Central (target: what sending uses), signing in, or what went wrong.
const bcState = { target: null, busy: false, problem: '' };

function bcProblem(cfg) {
  const missing = BC_FIELDS.filter(([key, , , required]) => required && !cfg[key]).map(([, label]) => label);
  if (missing.length) return `Fill in ${missing.join(', ')}.`;
  const broken = Object.entries(BC_RULES).find(([key, [ok]]) => cfg[key] && !ok(cfg[key]));
  return broken ? broken[1][1] : '';
}

const serviceProblem = (cfg, error) => (error.status === 404
  ? `Business Central has no web service called “${cfg.service}” in ${cfg.company}: publish page 1020 under that name (see How to set it up).`
  : error.message);

// After signing in: find the company, the batch's journal template and the G/L accounts, so
// sending needs nothing more. Returns what sending uses.
async function bcConnect(cfg) {
  const all = await bc.companies(cfg);
  const wanted = (cfg.company || '').toLowerCase();
  const company = wanted ? all.find((c) => [c.name, c.displayName].some((n) => String(n || '').toLowerCase() === wanted))
    : (all.length === 1 ? all[0] : null);
  if (!company) {
    const names = all.map((c) => `“${c.name}”`).join(', ');
    if (wanted) throw new Error(`Business Central has no company called “${cfg.company}”${names ? ` (yours: ${names})` : ''}. Fix it in Business Central settings.`);
    throw new Error(all.length ? `Your Business Central has ${all.length} companies (${names}): put the one to send to in Business Central settings.`
      : 'Your Microsoft account can’t use any Business Central company.');
  }
  const target = { ...cfg, company: company.name, companyId: company.id };
  try {
    if (!target.template) {
      target.template = await bc.findTemplate(target);
      if (!target.template) throw new Error(`${target.batch} is empty, so its journal template can’t be found: put it in Business Central settings.`);
      // Remember it, so it's known even once the batch is empty again.
      saveSettings({ ...state.settings, businessCentral: { ...state.settings.businessCentral, template: target.template } },
        { message: 'Business Central settings', wait: false }).then(renderBcSettings, () => {});
    }
    await bc.batchLines(target);
  } catch (error) {
    throw Object.assign(new Error(serviceProblem(target, error)), { signIn: error.signIn });
  }
  const accounts = [['CAPEX job lines', target.capexAccount], ['REVEX job lines', target.revexAccount],
    ['balancing lines', String(state.bundle.journal?.balancingGlAccount || '')]];
  for (const [what, number] of accounts) {
    const account = await bc.glAccount(target, target.companyId, number);
    if (!account) throw new Error(`Business Central has no G/L account ${number} (for ${what}). Fix it in Business Central settings.`);
    if (account.blocked) throw new Error(`G/L account ${number} (for ${what}) is blocked in Business Central.`);
    if (!account.directPosting) throw new Error(`G/L account ${number} (for ${what}) doesn’t allow direct posting in Business Central.`);
  }
  return target;
}

// "Sign in to Business Central": Microsoft's sign-in in a pop-up, then the checks above.
function bcSignIn() {
  const cfg = bcConfig();
  // The pop-up opens now, while it's still the click; it's not needed if Microsoft already signed you in here.
  const signing = bc.signedInAs(cfg) ? Promise.resolve() : bc.signIn(cfg);
  bcState.busy = true;
  bcState.problem = '';
  renderBcStrip();
  signing.then(() => bcConnect(cfg))
    .then((target) => { bcState.target = target; }, (error) => { bcState.target = null; bcState.problem = error.message; })
    .finally(() => { bcState.busy = false; renderBcStrip(); renderJournals(); });
}

function bcSignOut() {
  bc.signOut();
  bcState.target = null;
  bcState.problem = '';
  renderBcStrip();
  renderJournals();
}

// Above the Journals list: the sign-in button, or who's signed in.
function renderBcStrip() {
  const strip = $('#bc-strip');
  if (!strip) return;
  const cfg = bcConfig();
  if (!bcConfigured(cfg)) {
    strip.replaceChildren(el('span', { class: 'muted' }, 'To send journals straight to Business Central, fill in ',
      el('a', { href: '#bc-card' }, 'Business Central settings'), ' (once).'));
  } else if (bcState.busy) {
    strip.replaceChildren(el('span', { class: 'bc-line', dataset: { tone: 'busy' } },
      el('span', { class: 'step-icon', 'aria-hidden': 'true' }), 'Signing in to Business Central…'));
  } else if (bcState.target) {
    const t = bcState.target;
    strip.replaceChildren(el('span', { class: 'bc-line', dataset: { tone: 'ok' } },
      el('span', { class: 'step-icon', 'aria-hidden': 'true' }, '✓'),
      el('span', {}, 'Signed in to Business Central as ', el('strong', {}, bc.signedInAs(cfg)),
        `. Journals go to ${t.batch} in ${t.company}${t.environment === 'Production' ? '' : ` (${t.environment})`}.`)),
    el('button', { class: 'btn btn-sm', type: 'button', onclick: bcSignOut }, 'Sign out'));
  } else {
    strip.replaceChildren(
      el('button', { class: 'btn btn-primary', type: 'button', onclick: bcSignIn }, 'Sign in to Business Central'),
      bcState.problem ? el('p', { class: 'form-message bc-problem' }, bcState.problem) : null);
  }
}

// A month's journal (its CSV) as Job G/L Journal lines. Job lines go to the CAPEX or REVEX G/L
// account with their job, task and hours; each engineer's balancing line goes to its GL
// account. Lines are dated the month's last day, like the journal.
function journalLines(month, csv, cfg) {
  const [header = [], ...rows] = parseCsv(new TextDecoder().decode(csv.data)).filter((r) => r.length > 1);
  const at = new Map(JOURNAL_HEADER.map((name) => [name, header.indexOf(name)]));
  if ([...at.values()].some((i) => i < 0)) throw new Error('this month’s journal doesn’t have the usual columns.');
  const [EMPLOYEE, , AMOUNT, , , GL, PROJECT, DESCRIPTION, TASK, HOURS, , DOCUMENT] = JOURNAL_HEADER;
  const [year, number] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
  return rows.map((cells) => {
    const get = (name) => String(cells[at.get(name)] ?? '').trim();
    const employee = get(EMPLOYEE);
    const project = get(PROJECT);
    const task = get(TASK).toUpperCase();
    const fields = { Posting_Date: date, Document_No: get(DOCUMENT), Description: get(DESCRIPTION), Amount: Number(get(AMOUNT)), Bal_Account_No: '' };
    if (!project) return { group: employee, label: `${employee}, balancing line`, fields: { ...fields, Account_No: get(GL) } };
    const account = { CAPEX: cfg.capexAccount, REVEX: cfg.revexAccount }[task];
    if (!account) throw new Error(`${employee}, ${project}: only CAPEX and REVEX lines have a G/L account, not “${task}”.`);
    return {
      group: employee,
      label: `${employee}, ${project} ${task}`,
      fields: { ...fields, Account_No: account, Job_No: project, Job_Task_No: task, Job_Quantity: Number(get(HOURS)) },
    };
  });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The line under a month that says how sending it went.
function resultRow(row) {
  const month = row.dataset.month;
  let tr = document.querySelector(`tr.journal-row[data-kind="send"][data-month="${month}"]`);
  if (!tr) {
    tr = el('tr', { class: 'journal-row', dataset: { kind: 'send', month } });
    row.after(tr);
  }
  const close = () => tr.remove();
  const set = (tone, text, ...actions) => {
    tr.replaceChildren(el('td', { colspan: 3 }, el('div', { class: 'bc-result', dataset: { tone } },
      el('span', { class: 'step-icon', 'aria-hidden': 'true' }, { busy: '', ok: '✓', warn: '!', error: '!' }[tone]),
      el('span', { class: 'bc-result-text' }, text),
      actions.length ? el('span', { class: 'bc-result-actions' }, actions) : null)));
  };
  return { set, close };
}

const small = (label, onclick, primary = false) => el('button', { class: `btn btn-sm${primary ? ' btn-primary' : ''}`, type: 'button', onclick }, label);

// "Send to Business Central": the month's whole journal goes into the batch in one go. If
// Business Central refuses any line, none of them is kept. It only stops to ask when the month
// looks like it's been sent before. Returns whether it was sent.
async function sendMonth(entry, row, { again = false, button = null, quiet = false } = {}) {
  const result = resultRow(row);
  const target = bcState.target;
  if (!target) {
    result.set('error', 'Sign in to Business Central first (the button above the list).', small('Close', result.close));
    return false;
  }
  const label = monthInfo(entry.month).label;
  let lines;
  try {
    lines = journalLines(entry.month, entry.csv, target);
  } catch (error) {
    result.set('error', `Nothing was sent: ${error.message}`, small('Close', result.close));
    return false;
  }
  if (!lines.length) {
    result.set('error', `Nothing to send: ${label}’s journal has no lines.`, small('Close', result.close));
    return false;
  }
  if (button) button.disabled = true;
  result.set('busy', `Sending ${label} to Business Central…`);
  try {
    if (!again) {
      const documentNo = lines[0].fields.Document_No;
      const waiting = await bc.batchLines(target);
      const same = waiting.filter((l) => String(l.Document_No || '').toUpperCase() === documentNo.toUpperCase()).length;
      const posted = same ? [] : await bc.postedEntries(target, target.companyId, documentNo);
      if (same || posted.length) {
        result.set('warn', same ? `${target.batch} already has ${plural(same, 'line')} for ${documentNo}, so ${label} looks like it’s been sent. Send it again?`
          : `${documentNo} is already posted in Business Central, so ${label} looks like it’s been sent. Send it again?`,
        small('Send again', () => sendMonth(entry, row, { again: true }), true), small('Cancel', result.close));
        return false;
      }
    }
    const { lineNos, saved } = await bc.addLines(target, lines);
    const gst = saved.filter((line) => Number(line.bc.VAT_Amount)).length;
    result.set('ok', `Sent ${label}: ${plural(lineNos.length, 'line')} in ${target.batch}, ready to check and post in Business Central.`
      + (gst ? ` Business Central added GST to ${plural(gst, 'line')}, though the journal has none: check those.` : ''),
    el('a', { class: 'btn btn-sm btn-primary', href: bc.journalLink(target), target: '_blank', rel: 'noopener noreferrer' }, 'Open in Business Central'),
    small('Undo', () => undoSend(entry, row, lineNos)));
    if (!quiet) fireworks();
    return true;
  } catch (error) {
    if (error.signIn) {
      bcState.target = null;
      bcState.problem = error.message;
      renderBcStrip();
    }
    result.set('error', `Nothing was sent: ${error.message}`,
      error.signIn ? small('Close', result.close) : small('Try again', () => sendMonth(entry, row, { again }), true));
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

async function sendMonths(chosen, rows, button) {
  button.disabled = true;
  let sent = 0;
  for (const entry of chosen.filter((m) => m.csv)) {
    if (!bcState.target) break;
    if (await sendMonth(entry, rows.get(entry.month), { quiet: true })) sent += 1;
  }
  button.disabled = false;
  if (sent) fireworks();
}

async function undoSend(entry, row, lineNos) {
  const result = resultRow(row);
  const batch = bcState.target?.batch || 'the batch';
  result.set('busy', `Taking the ${plural(lineNos.length, 'line')} back out of ${batch}…`);
  try {
    if (!bcState.target) throw new Error('Sign in to Business Central first (the button above the list).');
    const removed = await bc.removeLines(bcState.target, lineNos);
    result.set('ok', removed === lineNos.length ? `Took the ${plural(removed, 'line')} back out of ${batch}.`
      : `Took ${removed} of the ${plural(lineNos.length, 'line')} back out of ${batch}; the rest were already gone (posted, or deleted in Business Central).`,
    small('Close', result.close));
  } catch (error) {
    result.set('error', error.message, small('Try again', () => undoSend(entry, row, lineNos), true), small('Close', result.close));
  }
}

// The settings card: open while something's missing, otherwise folded away.
function renderBcSettings() {
  const box = $('#bc');
  if (!box) return;
  const cfg = bcConfig();
  const inputs = {};
  const fields = BC_FIELDS.map(([key, label, hint, required]) => {
    inputs[key] = el('input', { id: `bc-${key}`, type: 'text', value: cfg[key] || '', autocomplete: 'off', spellcheck: false });
    return el('label', { class: 'field' }, el('span', {}, label, required ? null : el('span', { class: 'optional' }, ' (optional)')), inputs[key], el('small', {}, hint));
  });
  const read = () => Object.fromEntries(BC_FIELDS.map(([key]) => {
    const value = inputs[key].value.trim();
    return [key, CODES.includes(key) ? value.toUpperCase() : value];
  }));
  const status = el('p', { class: 'bc-status', role: 'status' });
  const show = (text, tone = '') => { status.textContent = text; status.dataset.tone = tone; };
  const save = el('button', { class: 'btn btn-primary', type: 'button' }, 'Save');
  save.addEventListener('click', async () => {
    const next = read();
    const problem = bcProblem(next);
    if (problem) { show(problem, 'error'); return; }
    save.disabled = true;
    show('Saving…');
    try {
      await saveSettings({ ...state.settings, businessCentral: Object.fromEntries(Object.entries(next).filter(([, v]) => v)) },
        { message: 'Business Central settings', wait: false });
      bcState.target = null; // sign in again with the new settings
      show('Saved. Now use Sign in to Business Central, above the Journals list.', 'ok');
      renderBcStrip();
      renderJournals();
    } catch (error) {
      show(error.message, 'error');
    } finally {
      save.disabled = false;
    }
  });
  const configured = bcConfigured(cfg);
  box.replaceChildren(
    configured ? el('p', { class: 'muted bc-summary' }, `Journals go to ${cfg.batch}${cfg.company ? ` in ${cfg.company}` : ''}`
      + `${cfg.environment === 'Production' ? '' : ` (${cfg.environment})`}: CAPEX job lines to G/L ${cfg.capexAccount}, REVEX to ${cfg.revexAccount}.`) : null,
    el('details', { class: 'bc-settings', open: !configured },
      el('summary', {}, configured ? 'Change the settings' : 'Settings'),
      el('div', { class: 'bc-grid' }, fields),
      el('div', { class: 'bc-actions' }, save),
      status),
    bcSetupHelp(),
  );
}

function bcSetupHelp() {
  const code = (text) => el('code', {}, text);
  return el('details', { class: 'bc-help' }, el('summary', {}, 'How to set it up'),
    el('p', { class: 'muted' }, 'Done once. Microsoft only lets a website sign people in once it’s registered with your organisation, and Business Central only takes journal lines from outside through a published page.'),
    el('ol', {},
      el('li', {}, el('strong', {}, 'Register the website with Microsoft. '),
        'In the Microsoft Entra admin center (entra.microsoft.com): ', el('em', {}, 'App registrations › New registration'),
        '. Name it Engineer Timewriting, choose ', el('em', {}, 'Accounts in this organizational directory only'),
        ', and under Redirect URI pick ', el('em', {}, 'Single-page application (SPA)'), ' with ', code(bc.redirectUri()),
        '. Register, then copy the Application (client) ID and Directory (tenant) ID into the settings above.'),
      el('li', {}, el('strong', {}, 'Let it use Business Central. '),
        'In the registration: ', el('em', {}, 'API permissions › Add a permission › Dynamics 365 Business Central › Delegated permissions'),
        ', tick ', code('Financials.ReadWrite.All'), ', add it, then press ', el('em', {}, 'Grant admin consent'),
        '. It only ever acts as the person signed in, with their Business Central permissions.'),
      el('li', {}, el('strong', {}, 'Publish the journal page. '),
        'In Business Central, search for ', el('em', {}, 'Web Services'), ', choose ', el('em', {}, 'New'), ': Object Type ', code('Page'),
        ', Object ID ', code('1020'), ', Service Name ', code('JobGLJournal'), ', and tick ', el('em', {}, 'Published'), '.'),
      el('li', {}, el('strong', {}, 'Fill in the settings above and Save. '),
        'Then ', el('em', {}, 'Sign in to Business Central'), ' above the Journals list, and ', el('em', {}, 'Send to Business Central'),
        ' on a month. ', el('em', {}, 'Undo'), ' takes a send back out until it’s posted.')));
}

// -------------------------------------------------------- engineers & rates

// Save settings.json (and users.json for new passwords), then wait for the website to update.
// With wait: false it returns as soon as the change is saved, with the commit to watch.
async function saveSettings(settings, { resetPasswords = [], message, status, wait = true }) {
  state.busy = true;
  try {
    let commit = null;
    if (resetPasswords.length) {
      const users = await state.repo.readJson(USERS);
      if (users) {
        for (const username of resetPasswords) if (users.data.users?.[username]) users.data.users[username].reset = true;
        ({ commit } = await state.repo.writeJson(USERS, users.data, 'Ask for new passwords (admin page)', users.sha));
      }
    }
    if (JSON.stringify(settings) !== JSON.stringify(state.settings)) {
      const saved = await state.repo.writeJson(SETTINGS, settings, `${message} (admin page)`, state.settingsSha);
      state.settings = settings;
      state.settingsSha = saved.sha;
      commit = saved.commit;
    }
    if (!commit || !wait) return commit;
    status('Saved. Updating the website and journals, about a minute…', 'busy');
    const run = await waitForPublish(commit);
    if (!run) throw new Error('This is taking longer than usual. Reload the page in a few minutes to check.');
    if (run.conclusion !== 'success') throw new Error('The change was saved, but updating the website failed. Look at the “Update website and journals” run in the data repo’s Actions tab.');
    await loadSettings();
    return true;
  } catch (error) {
    if (error.status === 409) {
      await loadSettings();
      throw new Error('Someone else changed the settings at the same time. Their changes are shown now; make yours again.');
    }
    throw error;
  } finally {
    state.busy = false;
  }
}

async function loadSettings() {
  const [settings, users] = await Promise.all([state.repo.readJson(SETTINGS), state.repo.readJson(USERS)]);
  if (!settings) throw new Error('settings.json is missing from the private repo.');
  state.settings = settings.data;
  state.settingsSha = settings.sha;
  state.users = users?.data?.users || {};
  renderStaff();
}

// The same rules as clean_email() in tools/etjm_core.py.
const EMAIL_RE = /^[^@\s<>"',;:()[\]]+@[^@\s<>"',;:()[\]]+\.[^@\s<>"',;:()[\]]+$/;
const cleanEmail = (value) => String(value || '').trim().toLowerCase();

function renderStaff(message) {
  const box = $('#staff');
  const employees = (state.settings.employees || []).map((e) => ({ ...e, username: e.username || defaultUsername(e.name) }));
  const current = employees.filter((e) => e.active !== false);
  const former = employees.filter((e) => e.active === false);
  const admins = (state.settings.admins || []).map((a) => ({ ...a, username: a.username || defaultUsername(a.name) }));
  const edits = { rates: new Map(), emails: new Map(), adminEmails: new Map(), reset: new Set(), remove: new Set(), restore: new Set(), added: [] };
  const status = el('div', { class: 'staff-status', role: 'status' });
  const saveButton = el('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Save changes');
  const setStatus = (text, tone = 'muted') => {
    status.dataset.tone = tone;
    status.replaceChildren(...[tone === 'busy' && el('span', { class: 'step-icon', 'aria-hidden': 'true' }), el('span', {}, text)].filter(Boolean));
  };
  const changed = () => {
    saveButton.disabled = state.busy || !(edits.rates.size || edits.emails.size || edits.adminEmails.size || edits.reset.size
      || edits.remove.size || edits.restore.size || edits.added.length);
  };

  const resetButton = (person) => el('button', { class: 'link-btn', type: 'button',
    title: 'Give them a new password when you save. This also signs them out everywhere.', onclick: (e) => {
      const on = !edits.reset.has(person.username);
      if (on) edits.reset.add(person.username); else edits.reset.delete(person.username);
      e.currentTarget.textContent = on ? 'Keep password' : 'New password';
      e.currentTarget.closest('tr').classList.toggle('pending', on || edits.remove.has(person.username));
      changed();
    } }, 'New password');

  const passwordCell = (person) => {
    const record = state.users[person.username];
    if (!record) return el('td', { class: 'muted' }, 'Made when saved');
    if (record.own || !record.password) {
      return el('td', { class: 'password-cell' }, el('span', { class: 'muted' }, 'Chosen by them'), resetButton(person));
    }
    const reveal = () => issuedPassword(state.profile, person.username, record.password);
    const shown = el('code', { class: 'password' }, '••••-••••-••••');
    return el('td', { class: 'password-cell' }, shown,
      el('button', { class: 'link-btn', type: 'button', onclick: async (e) => {
        const button = e.currentTarget;
        const show = shown.textContent.startsWith('•');
        shown.textContent = show ? await reveal() : '••••-••••-••••';
        button.textContent = show ? 'Hide' : 'Show';
      } }, 'Show'),
      el('button', { class: 'link-btn', type: 'button', onclick: async () => {
        try {
          await navigator.clipboard.writeText(await reveal());
          toast(`Copied ${person.name}’s password.`);
        } catch {
          toast('Couldn’t copy. Use Show and copy it by hand.', { tone: 'error' });
        }
      } }, 'Copy'),
      resetButton(person));
  };

  // Where this person's password-reset emails go (see "Forgot your password?").
  const emailInput = (person, map) => el('input', {
    class: 'email-input', type: 'email', inputmode: 'email', autocomplete: 'off', spellcheck: false, maxLength: 254,
    value: person.email || '', placeholder: 'name@company.co.nz', 'aria-label': `Email address for ${person.name}`,
    oninput: (e) => {
      const value = cleanEmail(e.currentTarget.value);
      e.currentTarget.classList.toggle('invalid', Boolean(value) && !EMAIL_RE.test(value));
      if (value === (person.email || '')) map.delete(person.username);
      else map.set(person.username, value);
      changed();
    },
  });

  // Shown as plain text; "Change" (or "Add email") opens a box for it, and "Cancel" puts it back.
  const emailField = (person, map) => {
    const box = el('div', { class: 'email-field' });
    const edit = () => {
      const input = emailInput(person, map);
      box.replaceChildren(input, el('button', { class: 'link-btn', type: 'button', onclick: show }, 'Cancel'));
      input.focus();
      input.select();
    };
    const show = () => {
      map.delete(person.username);
      box.replaceChildren(
        person.email ? el('span', { class: 'email-text' }, person.email) : el('span', { class: 'muted' }, 'No email yet'),
        el('button', { class: 'link-btn', type: 'button', onclick: edit, 'aria-label': `${person.email ? 'Change' : 'Add'} the email address for ${person.name}` },
          person.email ? 'Change' : 'Add email'));
      changed();
    };
    show();
    return box;
  };

  const rateInput = (person) => el('input', {
    class: 'rate-input', type: 'number', min: '1', step: '0.01', inputmode: 'decimal', required: true,
    value: person.rechargeRate ?? '', 'aria-label': `Recharge rate for ${person.name}`,
    oninput: (e) => {
      const value = e.currentTarget.value;
      if (String(person.rechargeRate ?? '') === value) edits.rates.delete(person.username);
      else edits.rates.set(person.username, value);
      changed();
    },
  });

  const rows = current.map((person) => el('tr', { dataset: { username: person.username } },
    el('th', { scope: 'row' }, person.name),
    el('td', { class: 'muted' }, person.username),
    el('td', {}, emailField(person, edits.emails)),
    el('td', {}, el('span', { class: 'rate-prefix' }, '$'), rateInput(person)),
    passwordCell(person),
    el('td', { class: 'row-actions' },
      el('a', { class: 'btn btn-sm', href: `home.html?as=${encodeURIComponent(person.username)}`, title: `See ${person.name}’s timesheets as they do (read-only)` }, 'View'),
      el('button', { class: 'btn btn-sm', type: 'button', onclick: (e) => {
      const on = !edits.remove.has(person.username);
      if (on) edits.remove.add(person.username); else edits.remove.delete(person.username);
      e.currentTarget.textContent = on ? 'Undo' : 'Remove';
      e.currentTarget.closest('tr').classList.toggle('removing', on);
      changed();
    } }, 'Remove'))));

  const addedBody = el('tbody', { class: 'added' });
  const newName = el('input', { class: 'add-input', placeholder: 'Full name, as in the journal', maxLength: 60, 'aria-label': 'New engineer’s name' });
  const newEmail = el('input', { class: 'email-input', type: 'email', inputmode: 'email', autocomplete: 'off', spellcheck: false, maxLength: 254,
    placeholder: 'Email (for password resets)', 'aria-label': 'New engineer’s email address' });
  const newRate = el('input', { class: 'rate-input', type: 'number', min: '1', step: '0.01', placeholder: '160', 'aria-label': 'New engineer’s recharge rate' });
  const addProblem = el('p', { class: 'form-message', hidden: true });
  const taken = () => new Set([...employees.map((e) => e.username), ...edits.added.map((e) => e.username)]);
  const add = () => {
    const name = cleanText(newName.value);
    const rate = Number(newRate.value);
    const email = cleanEmail(newEmail.value);
    const problem = nameProblem(name)
      || (employees.concat(edits.added).some((e) => nameKey(e.name) === nameKey(name)) ? `${name} is already on the list.` : null)
      || (email && !EMAIL_RE.test(email) ? 'That email address doesn’t look right.' : null)
      || (!(rate > 0) ? 'Enter their recharge rate, e.g. 160.' : null)
      || (!defaultUsername(name) || taken().has(defaultUsername(name)) ? 'Someone already has that username. Add them in settings.json with a different “username”.' : null);
    addProblem.hidden = !problem;
    addProblem.textContent = problem || '';
    if (problem) return;
    const person = { name, username: defaultUsername(name), rechargeRate: rate, ...(email ? { email } : {}) };
    edits.added.push(person);
    addedBody.append(el('tr', { class: 'pending' },
      el('th', { scope: 'row' }, name, el('span', { class: 'chip chip-ok chip-inline' }, 'New')),
      el('td', { class: 'muted' }, person.username), el('td', { class: 'muted' }, person.email || '—'), el('td', {}, `$${rate}`),
      el('td', { class: 'muted' }, 'Made when saved'),
      el('td', { class: 'row-actions' }, el('button', { class: 'btn btn-sm', type: 'button', onclick: (e) => {
        edits.added.splice(edits.added.indexOf(person), 1);
        e.currentTarget.closest('tr').remove();
        changed();
      } }, 'Undo'))));
    newName.value = '';
    newEmail.value = '';
    newRate.value = '';
    newName.focus();
    changed();
  };
  newName.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  newRate.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  newEmail.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  // The people who can use this page. Their own reset emails are set here.
  const officeTable = admins.length ? el('div', { class: 'office' },
    el('h3', {}, 'Office'),
    el('p', { class: 'muted' }, 'People who can use this Admin page. Add an email address so they can reset a forgotten password.'),
    el('table', { class: 'sheets staff office-table' },
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Name'), el('th', { scope: 'col' }, 'Username'), el('th', { scope: 'col' }, 'Email'))),
      el('tbody', {}, admins.map((person) => el('tr', {},
        el('th', { scope: 'row' }, person.name), el('td', { class: 'muted' }, person.username),
        el('td', {}, emailField(person, edits.adminEmails))))))) : null;

  const formerList = former.length ? el('details', { class: 'former' },
    el('summary', {}, `Former engineers (${former.length})`),
    el('p', { class: 'muted' }, 'They can’t sign in. Their past timesheets stay in the journals at their old rate.'),
    el('ul', {}, former.map((person) => el('li', {}, `${person.name} ($${person.rechargeRate ?? '?'})`,
      el('a', { class: 'link-btn', href: `home.html?as=${encodeURIComponent(person.username)}` }, 'View'),
      el('button', { class: 'link-btn', type: 'button', onclick: (e) => {
        const on = !edits.restore.has(person.username);
        if (on) edits.restore.add(person.username); else edits.restore.delete(person.username);
        e.currentTarget.textContent = on ? 'Undo' : 'Restore';
        changed();
      } }, 'Restore'))))) : null;

  saveButton.addEventListener('click', async () => {
    const bad = [...edits.rates].find(([, value]) => !(Number(value) > 0));
    if (bad) {
      setStatus('Every engineer needs a recharge rate above 0.', 'error');
      return;
    }
    const badEmail = [...edits.emails, ...edits.adminEmails].find(([, value]) => value && !EMAIL_RE.test(value));
    if (badEmail) {
      setStatus(`The email address for ${badEmail[0]} doesn’t look right.`, 'error');
      return;
    }
    const withEmail = (person, map, username) => {
      if (!map.has(username)) return person;
      const next = { ...person };
      if (map.get(username)) next.email = map.get(username); else delete next.email;
      return next;
    };
    const settings = structuredClone(state.settings);
    settings.employees = (settings.employees || []).map((e) => {
      const username = e.username || defaultUsername(e.name);
      const next = { ...e, username };
      if (edits.rates.has(username)) next.rechargeRate = Number(edits.rates.get(username));
      if (edits.remove.has(username)) next.active = false;
      if (edits.restore.has(username)) delete next.active;
      return withEmail(next, edits.emails, username);
    }).concat(edits.added);
    settings.admins = (settings.admins || []).map((a) => withEmail(a, edits.adminEmails, a.username || defaultUsername(a.name)));
    delete settings.defaultRechargeRate;
    saveButton.disabled = true;
    setStatus('Saving…', 'busy');
    try {
      const newPeople = edits.added.map((e) => e.username).concat([...edits.restore], [...edits.reset]);
      await saveSettings(settings, { resetPasswords: [...edits.reset], message: 'Change engineers', status: setStatus });
      const ready = newPeople.filter((u) => state.users[u]?.password);
      renderStaff(ready.length ? `Done. Passwords for ${ready.join(', ')} are in the list: use Show or Copy to hand them out.` : 'Done. The website and journals are up to date.');
      loadJournals();
    } catch (error) {
      setStatus(error.message, 'error');
      changed();
    }
  });

  // (replaceChildren would show a missing part as the word "null", so leave those out.)
  box.replaceChildren(...[
    el('table', { class: 'sheets staff' },
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, 'Name'), el('th', { scope: 'col' }, 'Username'), el('th', { scope: 'col' }, 'Email'),
        el('th', { scope: 'col' }, 'Rate / hour'),
        el('th', { scope: 'col' }, 'Password'), el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Actions')))),
      el('tbody', {}, rows), addedBody),
    el('div', { class: 'add-row' }, newName, newEmail, el('span', { class: 'rate-prefix' }, '$'), newRate,
      el('button', { class: 'btn', type: 'button', onclick: add }, 'Add engineer')),
    addProblem,
    formerList,
    officeTable,
    el('div', { class: 'staff-actions' }, saveButton, status),
  ].filter(Boolean));
  if (message) setStatus(message, 'ok');
  changed();
}

async function setClosed(month, close, button) {
  if (state.busy) {
    toast('Another change is still being saved. Try again in a minute.');
    return;
  }
  const label = monthInfo(month).label;
  const settings = structuredClone(state.settings);
  const months = new Set(settings.closedMonths || []);
  if (close) months.add(month); else months.delete(month);
  settings.closedMonths = [...months].sort();
  // Saving takes a second or two; the website and journals then update in the background
  // (about half a minute), so the button doesn't wait for that.
  const was = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = close ? 'Closing…' : 'Reopening…';
  }
  let commit;
  try {
    commit = await saveSettings(settings, { message: `${close ? 'Close' : 'Reopen'} a month`, status: () => {}, wait: false });
  } catch (error) {
    notice('error', error.message);
    if (button) {
      button.disabled = false;
      button.textContent = was;
    }
    return;
  }
  if (close) fireworks();
  toast(close
    ? `${label} is closed: its journal is frozen and engineers can no longer change it.`
    : `${label} is open again: engineers can change it, and its journal is rebuilt in about half a minute.`, { tone: 'ok', duration: 7000 });
  await loadJournals();
  if (!commit) return;
  const run = await waitForPublish(commit).catch(() => null);
  if (run && run.conclusion !== 'success') {
    notice('error', `${label} was ${close ? 'closed' : 'reopened'}, but updating the website failed. Look at the “Update website and journals” run in the data repo’s Actions tab.`);
  } else if (run && !close) {
    loadJournals(); // show the rebuilt journal
  }
}

// ------------------------------------------------------------------- start

async function start() {
  try {
    const opened = await openSession(session);
    state.bundle = opened.bundle;
    state.profile = opened.profile;
  } catch (error) {
    if (error.code === 'signin') {
      clearSession();
      location.replace(`index.html?why=${error.reason || 'again'}&next=admin.html`);
      return;
    }
    notice('error', error.message);
    return;
  }
  $('#user-name').textContent = state.profile.name;
  $('#timesheets-link').hidden = !state.profile.timesheets;
  if (!state.profile.admin) {
    $('#jobs-card').hidden = true;
    $('#staff-card').hidden = true;
    $('#journals-card').hidden = true;
    $('#bc-card').hidden = true;
    notice('info', 'This page is for the office. Use My timesheets to fill in your hours.');
    return;
  }
  const updated = state.bundle.jobsUpdated
    ? new Date(`${state.bundle.jobsUpdated}T12:00:00`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';
  $('#jobs-current').textContent = `The website lists ${state.bundle.jobs.length.toLocaleString('en-NZ')} open jobs from “${state.bundle.jobsSource}”${updated ? `, updated ${updated}` : ''}.`;
  if (!state.profile.adminToken) {
    notice('warn', 'Uploading and journals aren’t switched on yet: the admin key (ADMIN_TOKEN) still needs adding to the data repo.');
    $('#dropzone').classList.add('disabled');
    $('#report-file').disabled = true;
    $('#journals').replaceChildren(el('p', { class: 'muted' }, 'Available once the admin key is set up.'));
    $('#staff').replaceChildren(el('p', { class: 'muted' }, 'Available once the admin key is set up.'));
    $('#bc').replaceChildren(el('p', { class: 'muted' }, 'Available once the admin key is set up.'));
    return;
  }
  state.repo = adminRepo(state.bundle, state.profile);
  setUpUpload();
  setUpEmptyJobsOption();
  setUpWorkbookMenus();
  try {
    await loadSettings();
    renderBcSettings();
    renderBcStrip();
  } catch (error) {
    $('#staff').replaceChildren(el('p', { class: 'form-message' }, error.message));
    $('#bc').replaceChildren(el('p', { class: 'form-message' }, error.message));
  }
  loadJournals();
}

if (session?.uk) start();
