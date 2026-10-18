// "My timesheets": the signed-in person's months, saved to the office or kept on
// this computer. Open one to change it, or reuse one to start another month.
// With ?as=<username>, an admin sees that engineer's page instead, read-only (see
// openViewAs in app.js).

import {
  $, el, loadSession, clearSession, openSession, listSaved, drafts, sheetTotals, monthInfo, shiftMonth, thisMonth,
  fmtHours, fmtDateTime, viewAsParam, openViewAs,
} from './app.js';

const session = loadSession();
if (!session?.uk) location.replace('index.html');

const viewing = viewAsParam();
const state = { bundle: null, canSave: false, sheets: new Map(), loadError: null, viewAs: null };
const open = (month, copyFrom) => `timesheet.html?month=${month}${copyFrom ? `&copyFrom=${copyFrom}` : ''}${
  state.viewAs ? `&as=${encodeURIComponent(state.viewAs.person.username)}` : ''}`;

function hasRows(data) {
  return Boolean(data?.jobs?.length || data?.other?.length);
}

// A copy on this computer that was saved, has no changes since, and is no longer in the
// office's list was removed by the office (or the store was started again): forget it.
// Recent saves are kept in case GitHub's search hasn't caught up yet.
const STALE_MS = 15 * 60 * 1000;
const removedByOffice = (record, savedMonths, month) => savedMonths && record?.meta?.savedAt && !record.meta.dirty
  && !savedMonths.has(month) && Date.now() - Date.parse(record.meta.savedAt) > STALE_MS;

// One entry per month: what's on this computer, merged with what's saved. `complete` means
// `saved` is the office's full list (it was fetched without errors).
function collect(saved, { complete = false } = {}) {
  const sheets = new Map();
  const savedMonths = complete ? new Set(saved.map((item) => item.month)) : null;
  for (const month of drafts.months(session.username)) {
    const record = drafts.get(session.username, month);
    if (removedByOffice(record, savedMonths, month)) {
      drafts.remove(session.username, month);
      continue;
    }
    if (!record || (!hasRows(record.data) && !record.meta?.savedAt)) continue;
    sheets.set(month, { month, local: record });
  }
  for (const item of saved) sheets.set(item.month, { ...(sheets.get(item.month) || { month: item.month }), saved: item });
  for (const sheet of sheets.values()) {
    const { local, saved: remote } = sheet;
    const localNewer = local?.meta?.dirty && (!remote || (local.meta.localUpdatedAt || '') > (remote.savedAt || ''));
    sheet.data = localNewer || !remote ? local.data : remote.data;
    sheet.totals = sheetTotals(sheet.data);
    if (localNewer && state.canSave) sheet.status = { tone: 'warn', text: 'Unsaved changes on this computer' };
    else if (remote || local?.meta?.savedAt) sheet.status = { tone: 'ok', text: `Saved ${fmtDateTime(remote?.savedAt || local?.meta?.savedAt)}` };
    else sheet.status = { tone: 'muted', text: state.canSave ? 'Not saved yet' : 'On this computer' };
    if ((state.bundle?.closedMonths || []).includes(sheet.month)) sheet.status = { tone: 'muted', text: 'Closed by the office' };
  }
  return sheets;
}

// Viewing as someone: only the months they've saved (the office can't see their computer).
function collectViewed() {
  const sheets = new Map();
  for (const [month, item] of state.viewAs.months) {
    const closed = (state.bundle?.closedMonths || []).includes(month);
    sheets.set(month, {
      month, data: item.data, totals: sheetTotals(item.data),
      status: closed ? { tone: 'muted', text: 'Closed by the office' } : { tone: 'ok', text: `Saved ${fmtDateTime(item.savedAt)}` },
    });
  }
  return sheets;
}

function showViewing() {
  const { person } = state.viewAs;
  const first = person.name.split(' ')[0];
  document.title = `${person.name}’s timesheets (view only) · Engineer Timewriting`;
  document.body.classList.add('viewing-as');
  $('#all-sheets').textContent = `${first}’s timesheets`;
  $('#all-sheets').nextElementSibling.textContent = `What ${first} sees on My timesheets. Open a month to see their hours. Nothing here can be changed.`;
  $('#notices').replaceChildren(el('div', { class: 'notice notice-view' },
    el('div', { class: 'notice-text' }, el('strong', {}, `Viewing ${person.name}’s timesheets, read-only. `),
      `This is what they see, from the months they’ve saved${person.active ? '' : ' (they’ve left, so they can’t sign in)'}. `
      + 'Hours they haven’t saved yet are only on their own computer.'),
    el('a', { class: 'btn btn-sm', href: 'admin.html' }, 'Back to Admin')));
}

function render() {
  const current = thisMonth();
  const info = monthInfo(current);
  const sheet = state.sheets.get(current);
  const months = [...state.sheets.keys()].sort().reverse();
  const before = months.find((m) => m < current);

  $('#this-month').textContent = info.label;
  $('#this-status').replaceChildren(sheet
    ? el('span', {}, el('span', { class: `chip chip-${sheet.status.tone}` }, sheet.status.text),
      ` Jobs ${fmtHours(sheet.totals.jobs)} h · Other ${fmtHours(sheet.totals.other)} h`)
    : el('span', {}, 'Not started yet.'));
  $('#hero-actions').replaceChildren(...(state.viewAs
    ? [sheet && el('a', { class: 'btn btn-primary', href: open(current) }, `View ${info.label}`)]
    : [
      el('a', { class: 'btn btn-primary', href: open(current) }, sheet ? `Open ${info.label}` : `Start ${info.label}`),
      !sheet && before && el('a', { class: 'btn', href: open(current, before) }, `Start from ${monthInfo(before).label}`),
    ]).filter(Boolean));

  const body = $('#sheets');
  if (!months.length) {
    body.replaceChildren(el('p', { class: 'muted pad' }, state.viewAs ? 'They haven’t saved any timesheets yet.'
      : state.loadError ? 'Nothing on this computer yet.' : 'No timesheets yet. Start this month above.'));
    return;
  }
  const rows = months.map((month) => {
    const item = state.sheets.get(month);
    return el('tr', { dataset: { month } },
      el('th', { scope: 'row' }, el('a', { href: open(month) }, monthInfo(month).label),
        el('span', { class: `status-inline chip chip-${item.status.tone}` }, item.status.text)),
      el('td', {}, el('span', { class: `chip chip-${item.status.tone}` }, item.status.text)),
      el('td', { class: 'num' }, fmtHours(item.totals.jobs)),
      el('td', { class: 'num' }, fmtHours(item.totals.other)),
      el('td', { class: 'row-actions' }, ...(state.viewAs
        ? [el('a', { class: 'btn btn-sm', href: open(month) }, 'View')]
        : [el('a', { class: 'btn btn-sm', href: open(month) }, 'Open'),
          el('button', { class: 'btn btn-sm', type: 'button', onclick: (e) => showReuse(e.currentTarget, month) }, 'Reuse…')])));
  });
  body.replaceChildren(el('table', { class: 'sheets' },
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col' }, 'Month'), el('th', { scope: 'col' }, 'Status'),
      el('th', { scope: 'col', class: 'num' }, 'Job hours'), el('th', { scope: 'col', class: 'num' }, 'Other'),
      el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Actions')))),
    el('tbody', {}, rows)));
}

// Pick which month to start from this sheet; the hours themselves aren't copied.
function showReuse(button, source) {
  document.querySelector('tr.reuse-row')?.remove();
  const row = button.closest('tr');
  const current = thisMonth();
  const last = shiftMonth(current, 2);
  const options = [];
  for (let m = shiftMonth(source, 1); m <= last; m = shiftMonth(m, 1)) options.push(m);
  if (!options.length) options.push(shiftMonth(source, 1));
  const select = el('select', { class: 'reuse-select', 'aria-label': 'Month to start' },
    options.map((m) => el('option', { value: m, selected: m === shiftMonth(source, 1) },
      `${monthInfo(m).label}${state.sheets.has(m) ? ' (add to it)' : ''}`)));
  const panel = el('tr', { class: 'reuse-row' }, el('td', { colspan: 5 },
    el('div', { class: 'reuse-panel' },
      el('span', {}, `Start `), select,
      el('span', {}, ` with the jobs and other-time rows from ${monthInfo(source).label}.`),
      el('a', { class: 'btn btn-primary btn-sm', href: open(options[0], source), id: 'reuse-go' }, 'Start'),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => panel.remove() }, 'Cancel'))));
  select.addEventListener('change', () => { $('#reuse-go').href = open(select.value, source); });
  row.after(panel);
  select.focus();
}

function notice(tone, text) {
  $('#notices').replaceChildren(el('div', { class: `notice notice-${tone}` }, el('div', { class: 'notice-text' }, text)));
}

async function start() {
  $('#user-name').textContent = session.name;
  try {
    const opened = await openSession(session);
    if (viewing) {
      if (!opened.profile.admin) {
        location.replace('home.html');
        return;
      }
      state.bundle = opened.bundle;
      $('#user-name').textContent = opened.profile.name;
      $('#admin-link').hidden = false;
      state.viewAs = await openViewAs(opened.bundle, opened.profile, viewing);
      showViewing();
      state.sheets = collectViewed();
      render();
      return;
    }
    if (!opened.profile.timesheets) {
      location.replace('admin.html');
      return;
    }
    state.bundle = opened.bundle;
    state.profile = opened.profile;
    session.name = opened.profile.name;
    $('#user-name').textContent = opened.profile.name;
    $('#admin-link').hidden = !opened.profile.admin;
  } catch (error) {
    if (error.code === 'signin') {
      clearSession();
      location.replace(`index.html?why=${error.reason || 'again'}`);
      return;
    }
    notice('error', error.message);
    return;
  }
  state.canSave = Boolean(state.bundle.saveToken && state.bundle.dataRepo);
  const updated = state.bundle.jobsUpdated
    ? new Date(`${state.bundle.jobsUpdated}T12:00:00`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';
  $('#meta').textContent = `${state.bundle.jobs.length} open jobs from “${state.bundle.jobsSource}”${updated ? `, updated ${updated}` : ''}.`;
  state.sheets = collect([]);
  render();
  if (!state.canSave) {
    notice('warn', 'Saving to the office isn’t switched on yet, so only the timesheets on this computer are shown.');
    return;
  }
  try {
    state.sheets = collect(await listSaved(state.bundle, state.profile, session.username), { complete: true });
  } catch (error) {
    state.loadError = error;
    notice('error', `${error.message} Showing the timesheets on this computer.`);
  }
  render();
}

if (session?.uk) start();
