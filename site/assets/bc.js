// Business Central, straight from the Admin page. You sign in with your Microsoft account in a
// pop-up (OAuth for a single-page app, with PKCE), and the page reads and adds lines in a
// Job G/L Journal batch through the journal page published as an OData web service. Business
// Central online accepts requests from other websites, so nothing goes through GitHub or any
// server of ours, and what you can do is what your Business Central user can do. The Microsoft
// tokens are kept in this page's memory only: reloading the page signs you out of Microsoft.

const LOGIN = 'https://login.microsoftonline.com';
const API = 'https://api.businesscentral.dynamics.com';
const SCOPE = `${API}/Financials.ReadWrite.All offline_access openid profile`;
const CHANNEL = 'etjm-microsoft';
const MAX_BATCH = 100; // Business Central's limit on requests in one $batch

export class BcError extends Error {
  constructor(message, { status = 0, signIn = false } = {}) {
    super(message);
    this.status = status;
    this.signIn = signIn; // signing in again may fix it
  }
}

let session = null; // { key, access, refresh, expires, tenantId, user }

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (size) => b64url(crypto.getRandomValues(new Uint8Array(size)));
const sessionKey = (cfg) => `${cfg.tenant}|${cfg.clientId}`.toLowerCase();

// Where Microsoft sends the pop-up back to: the app registration's redirect URI.
export const redirectUri = () => new URL('microsoft.html', location.href).href;

function claims(jwt) {
  try {
    const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(part + '='.repeat((4 - (part.length % 4)) % 4)), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
}

export const signedInAs = (cfg) => (session && session.key === sessionKey(cfg) ? session.user : '');
export const tenantId = () => session?.tenantId || '';

export function signOut() {
  session = null;
}

// Microsoft's errors, with what to do about the usual ones.
const HINTS = {
  AADSTS50011: 'The app registration needs this website’s sign-in address as a “Single-page application” redirect URI (see Setting up).',
  AADSTS9002326: 'The app registration’s redirect URI must be the “Single-page application” type, not “Web” (see Setting up).',
  AADSTS9002325: 'The app registration’s redirect URI must be the “Single-page application” type (see Setting up).',
  AADSTS700016: 'Your organisation has no app with that App (client) ID. Check the Business Central settings.',
  AADSTS700054: 'The app registration’s redirect URI must be the “Single-page application” type (see Setting up).',
  AADSTS90002: 'Microsoft doesn’t know that tenant. Check the Business Central settings.',
  AADSTS900023: 'Microsoft doesn’t know that tenant. Check the Business Central settings.',
  AADSTS65001: 'Your organisation hasn’t approved the app yet: an administrator needs to press “Grant admin consent” on its API permissions (see Setting up).',
  AADSTS90094: 'Your organisation hasn’t approved the app yet: an administrator needs to press “Grant admin consent” on its API permissions (see Setting up).',
  AADSTS65004: 'Signing in to Microsoft was cancelled.',
  AADSTS50020: 'That Microsoft account isn’t in your organisation. Sign in with your work account.',
  AADSTS700084: 'Your Microsoft sign-in has expired. Sign in again.',
  AADSTS70008: 'Your Microsoft sign-in has expired. Sign in again.',
};

function microsoftError(data) {
  const text = String(data?.error_description || data?.error || 'Microsoft didn’t sign you in.');
  const code = (text.match(/AADSTS\d+/) || [])[0];
  if (HINTS[code]) return HINTS[code];
  if (data?.error === 'access_denied') return 'Signing in to Microsoft was cancelled.';
  return text.split(/\r?\n/)[0].replace(/^AADSTS\d+:\s*/, '');
}

// The pop-up's page (microsoft.html) hands back the one-time code, on a BroadcastChannel and
// with postMessage. A window that closes without one means signing in was given up.
function waitForReply(expected, popup) {
  return new Promise((resolve, reject) => {
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null;
    let closedAt = 0;
    const started = Date.now();
    const finish = (settle, value) => {
      channel?.close();
      window.removeEventListener('message', onMessage);
      clearInterval(timer);
      settle(value);
    };
    const handle = (data) => {
      if (!data || data.type !== CHANNEL || data.state !== expected) return;
      if (data.code) finish(resolve, data);
      else finish(reject, new BcError(microsoftError({ error: data.error, error_description: data.description })));
    };
    const onMessage = (event) => { if (event.origin === location.origin) handle(event.data); };
    if (channel) channel.onmessage = (event) => handle(event.data);
    window.addEventListener('message', onMessage);
    const timer = setInterval(() => {
      if (popup.closed) {
        closedAt ||= Date.now();
        if (Date.now() - closedAt > 2500) finish(reject, new BcError('The Microsoft sign-in window closed before signing in finished.'));
      }
      if (Date.now() - started > 10 * 60 * 1000) finish(reject, new BcError('Signing in to Microsoft took too long. Try again.'));
    }, 400);
  });
}

async function getTokens(cfg, params) {
  let response;
  try {
    response = await fetch(`${LOGIN}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, scope: SCOPE, ...params }),
    });
  } catch {
    throw new BcError('Couldn’t reach Microsoft. Check your internet connection.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new BcError(microsoftError(data), { signIn: true });
  const who = claims(data.access_token);
  session = {
    key: sessionKey(cfg),
    access: data.access_token,
    refresh: data.refresh_token || '',
    expires: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    tenantId: who.tid || cfg.tenant,
    user: who.upn || who.preferred_username || who.unique_name || who.email || who.name || 'your Microsoft account',
  };
}

// Sign in with a pop-up. Call it straight from a click, or the browser blocks the pop-up.
export async function signIn(cfg) {
  const popup = window.open('', 'etjm-microsoft', 'popup,width=520,height=700');
  if (!popup) throw new BcError('Your browser blocked the Microsoft sign-in window. Allow pop-ups for this website, then try again.');
  try {
    const verifier = random(48);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const state = random(16);
    const url = new URL(`${LOGIN}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/authorize`);
    url.search = new URLSearchParams({
      client_id: cfg.clientId,
      response_type: 'code',
      response_mode: 'fragment',
      redirect_uri: redirectUri(),
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const reply = waitForReply(state, popup);
    popup.location.href = url.href;
    const { code } = await reply;
    await getTokens(cfg, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier });
    return session.user;
  } finally {
    try {
      popup.close();
    } catch { /* already closed */ }
  }
}

async function accessToken(cfg) {
  if (!session || session.key !== sessionKey(cfg)) throw new BcError('Sign in to Microsoft first.', { signIn: true });
  if (Date.now() < session.expires - 120000) return session.access;
  if (!session.refresh) throw new BcError('Your Microsoft sign-in has expired. Sign in again.', { signIn: true });
  try {
    await getTokens(cfg, { grant_type: 'refresh_token', refresh_token: session.refresh });
  } catch {
    session = null;
    throw new BcError('Your Microsoft sign-in has expired. Sign in again.', { signIn: true });
  }
  return session.access;
}

// One request to Business Central. `path` is under https://api.businesscentral.dynamics.com/v2.0/{tenant}/{environment}/.
async function request(cfg, path, { method = 'GET', body, headers = {} } = {}) {
  const token = await accessToken(cfg);
  const url = path.startsWith('https://') ? path
    : `${API}/v2.0/${encodeURIComponent(session.tenantId)}/${encodeURIComponent(cfg.environment)}/${path}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new BcError('Couldn’t reach Business Central. Check your internet connection.');
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (response.status === 401) {
    throw new BcError('Business Central didn’t accept your sign-in. Check the environment name, and that your Microsoft account can use Business Central, then sign in again.', { status: 401, signIn: true });
  }
  if (!response.ok) throw new BcError(bcMessage(data) || `Business Central answered ${response.status}.`, { status: response.status });
  return data;
}

const bcMessage = (data) => String(data?.error?.message || '').replace(/\s*CorrelationId:[\s\S]*$/, '').trim();

// OData bits: text in quotes (with quotes doubled), and the journal page's address.
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const query = (params) => Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
const linesPath = (cfg) => `Company(${encodeURIComponent(quote(cfg.company))})/${encodeURIComponent(cfg.service)}`;
const lineKey = (cfg, lineNo) => `${linesPath(cfg)}(Journal_Template_Name=${encodeURIComponent(quote(cfg.template))},`
  + `Journal_Batch_Name=${encodeURIComponent(quote(cfg.batch))},Line_No=${lineNo})`;

// The companies this sign-in can use: [{ id, name, displayName }].
export async function companies(cfg) {
  return (await request(cfg, `api/v2.0/companies?${query({ $select: 'id,name,displayName' })}`)).value || [];
}

// The lines waiting in the batch (not posted yet).
export async function batchLines(cfg) {
  const lines = [];
  let path = `ODataV4/${linesPath(cfg)}?${query({
    $filter: `Journal_Template_Name eq ${quote(cfg.template)} and Journal_Batch_Name eq ${quote(cfg.batch)}`,
    $select: 'Line_No,Document_No,Account_No,Job_No,Amount',
  })}`;
  while (path) {
    const data = await request(cfg, path);
    lines.push(...(data.value || []));
    path = data['@odata.nextLink'] || '';
  }
  return lines;
}

// The template a batch belongs to, from a line already in it ('' when it's empty).
export async function findTemplate(cfg) {
  const data = await request(cfg, `ODataV4/${linesPath(cfg)}?${query({
    $filter: `Journal_Batch_Name eq ${quote(cfg.batch)}`, $select: 'Journal_Template_Name', $top: '1',
  })}`);
  return data.value?.[0]?.Journal_Template_Name || '';
}

// G/L entries already posted with this document number (at most one is fetched). Business
// Central keeps codes like document numbers in capitals.
export async function postedEntries(cfg, companyId, documentNo) {
  return (await request(cfg, `api/v2.0/companies(${companyId})/generalLedgerEntries?${query({
    $filter: `documentNumber eq ${quote(documentNo.toUpperCase())}`, $select: 'entryNumber,postingDate', $top: '1',
  })}`)).value || [];
}

// A G/L account by number: { number, displayName, directPosting, blocked }, or null.
export async function glAccount(cfg, companyId, number) {
  return (await request(cfg, `api/v2.0/companies(${companyId})/accounts?${query({
    $filter: `number eq ${quote(number)}`, $select: 'number,displayName,directPosting,blocked',
  })}`)).value?.[0] || null;
}

// Requests in Business Central's JSON $batch format. With Isolation: snapshot they're one
// transaction: if one fails, the others are undone too.
async function batch(cfg, requests, { together = false } = {}) {
  const data = await request(cfg, 'ODataV4/$batch', {
    method: 'POST',
    headers: together ? { Isolation: 'snapshot' } : {},
    body: { requests: requests.map((r, i) => ({ id: String(i + 1), headers: { 'Content-Type': 'application/json' }, ...r })) },
  });
  const responses = data?.responses || [];
  // Answers carry the request's id; fall back to their order if they don't.
  return requests.map((r, i) => responses.find((a) => String(a.id) === String(i + 1)) || responses[i] || { status: 0 });
}

// Lines in groups of at most `size`, keeping each group's lines (an engineer's) together.
function chunks(lines, size) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let end = i;
    while (end < lines.length && lines[end].group === lines[i].group) end += 1;
    const group = lines.slice(i, end);
    for (let at = 0; at < group.length; at += size) {
      const part = group.slice(at, at + size);
      const last = out[out.length - 1];
      if (at === 0 && last && last.length + part.length <= size) last.push(...part);
      else out.push(part);
    }
    i = end;
  }
  return out;
}

// Add lines to the batch: [{ group, label, fields }] where fields are the journal page's
// (Posting_Date, Document_No, Account_No, Amount, Job_No, …). Each chunk of up to 100 lines is
// one transaction: if Business Central refuses a line, nothing in that chunk is kept, chunks
// already sent are taken back out, and the error names the line. Returns { lineNos, saved }:
// the line numbers added, and what Business Central made of each line.
export async function addLines(cfg, lines) {
  const waiting = await batchLines(cfg);
  let lineNo = waiting.reduce((max, line) => Math.max(max, Number(line.Line_No) || 0), 0);
  const numbered = lines.map((line) => { lineNo += 10000; return { ...line, lineNo }; });
  const added = [];
  const saved = [];
  try {
    for (const part of chunks(numbered, MAX_BATCH)) {
      const answers = await batch(cfg, part.map((line) => ({
        method: 'POST',
        url: linesPath(cfg),
        body: { Journal_Template_Name: cfg.template, Journal_Batch_Name: cfg.batch, Line_No: line.lineNo, ...line.fields },
      })), { together: true });
      const failed = answers.findIndex((a) => !(a.status >= 200 && a.status < 300));
      if (failed >= 0) {
        throw new BcError(`${part[failed].label}: ${bcMessage(answers[failed].body) || `Business Central answered ${answers[failed].status}.`}`,
          { status: answers[failed].status });
      }
      added.push(...answers.map((a, i) => Number(a.body?.Line_No) || part[i].lineNo));
      part.forEach((line, i) => saved.push({ ...line, bc: answers[i].body || {} }));
    }
  } catch (error) {
    if (added.length) await removeLines(cfg, added).catch(() => {});
    throw error;
  }
  return { lineNos: added, saved };
}

// Take lines back out of the batch (lines that are already gone, say posted, are skipped).
// Returns how many were removed.
export async function removeLines(cfg, lineNos) {
  let removed = 0;
  for (let at = 0; at < lineNos.length; at += MAX_BATCH) {
    const answers = await batch(cfg, lineNos.slice(at, at + MAX_BATCH).map((n) => ({
      method: 'DELETE', url: lineKey(cfg, n), headers: { 'If-Match': '*' },
    })));
    const failed = answers.find((a) => a.status !== 404 && !(a.status >= 200 && a.status < 300));
    if (failed) throw new BcError(bcMessage(failed.body) || `Business Central answered ${failed.status}.`, { status: failed.status });
    removed += answers.filter((a) => a.status >= 200 && a.status < 300).length;
  }
  return removed;
}

// The Job G/L Journal in Business Central's own website, showing the batch.
export function journalLink(cfg) {
  const filter = `'Journal Template Name' IS ${quote(cfg.template)} AND 'Journal Batch Name' IS ${quote(cfg.batch)}`;
  return `https://businesscentral.dynamics.com/${encodeURIComponent(tenantId() || cfg.tenant)}/${encodeURIComponent(cfg.environment)}/`
    + `?${query({ company: cfg.company, page: '1020', filter })}`;
}
