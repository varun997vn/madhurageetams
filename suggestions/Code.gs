/**
 * Review queue for reader-suggested lyric corrections.
 *
 * GitHub Pages is static, so it cannot receive a form. This script is the one moving
 * part behind it: bound to a private Google Sheet, deployed as a web app.
 *
 *   reader  --POST-->  doPost      append a "pending" row, email the admin
 *   admin   --GET--->  doGet       confirm page (shows the change, one button)
 *   admin   --POST-->  doPost      accept: commit to corrections.json on GitHub
 *                                  reject: mark the row, publish nothing
 *
 * Nothing a reader sends is public until the admin accepts it. Accepting commits to
 * web/public/data/corrections.json on main, which triggers the normal Pages deploy.
 *
 * Secrets live in Script Properties, never in this file — see README.md beside it.
 */

const REPO = 'varun997vn/madhurageetams';
const BRANCH = 'main';
const FILE_PATH = 'web/public/data/corrections.json';
const SITE_URL = 'https://varun997vn.github.io/madhurageetams/';
const SHEET_NAME = 'Suggestions';

const SCRIPTS = ['roman', 'devanagari', 'tamil', 'malayalam', 'kannada', 'telugu'];
const MAX_CHANGES = 40;
const MAX_LINE = 300;
const MAX_ADDED = 20;
const MAX_PER_DAY = 50;

// 'phone' is last on purpose: it was added after the queue was in use, and appending
// keeps every existing row lined up with its header.
const COLUMNS = ['id', 'received', 'status', 'songId', 'title', 'script', 'changes',
  'name', 'note', 'decided', 'commit', 'phone'];
const COL = {};
COLUMNS.forEach(function (name, index) { COL[name] = index + 1; });

/* ------------------------------------------------------------------ entry points -- */

function doPost(e) {
  // The confirm page posts a form (action=accept|reject); readers post a JSON string.
  if (e && e.parameter && e.parameter.action) return decide_(e.parameter);
  try {
    return json_(receive_(JSON.parse(e.postData.contents)));
  } catch (error) {
    console.error('doPost failed: ' + (error && error.stack || error));
    return json_({ ok: false, error: 'Could not read the suggestion.' });
  }
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.id || !p.action) return page_('Madhurageetam corrections', '<p>Nothing to do here.</p>');
  if (!validSig_(p.id, p.action, p.sig)) return page_('Link not valid', '<p>This link is not valid.</p>');

  const found = find_(p.id);
  if (!found) return page_('Not found', '<p>No such suggestion.</p>');
  const row = found.values;
  if (row[COL.status - 1] !== 'pending') {
    return page_('Already decided', '<p>This suggestion was already <b>' +
      esc_(row[COL.status - 1]) + '</b>.</p>');
  }

  // A GET never acts. Mail clients and link scanners fetch every URL in a message, and
  // one of them must not be able to publish a change.
  const verb = p.action === 'accept' ? 'Accept and publish' : 'Reject';
  const html = summary_(row) +
    '<form method="post" action="' + esc_(webAppUrl_()) + '" target="_top">' +
    hidden_('id', p.id) + hidden_('action', p.action) + hidden_('sig', p.sig) +
    '<button type="submit" style="font-size:16px;padding:10px 18px">' + verb + '</button>' +
    '</form>';
  return page_(verb + '?', html);
}

/* ---------------------------------------------------------------- reader intake --- */

function receive_(body) {
  const props = PropertiesService.getScriptProperties();

  // Honeypot: a person never sees this field. Answer "ok" so a bot learns nothing.
  if (body.website) return { ok: true };

  const expected = props.getProperty('UNLOCK_TOKEN');
  if (!expected || body.token !== expected) {
    return { ok: false, error: 'Please reload the site, unlock it again and resend.' };
  }

  const songId = Number(body.songId);
  if (!(Number.isInteger(songId) && songId > 0)) return { ok: false, error: 'Unknown song.' };
  if (SCRIPTS.indexOf(body.script) < 0) return { ok: false, error: 'Unknown script.' };

  // Who is suggesting this. Required, so the reviewer can ask about a doubtful change.
  // Kept in the private Sheet and the review email only; never published.
  const name = text_(body.name, 80);
  const code = text_(body.countryCode, 6);
  const phone = text_(body.phone, 24).replace(/[\s().-]/g, '');
  if (name.length < 2) return { ok: false, error: 'Please enter your name.' };
  if (!/^\+[1-9]\d{0,3}$/.test(code)) {
    return { ok: false, error: 'Please choose your country code. If the form has no such field, reload the page.' };
  }
  if (!/^\d{6,14}$/.test(phone)) return { ok: false, error: 'Please enter a valid phone number.' };
  body.name = name;
  body.contact = code + ' ' + phone;

  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (changes.length === 0) return { ok: false, error: 'No changed lines were sent.' };
  if (changes.length > MAX_CHANGES) {
    return { ok: false, error: 'Please send at most ' + MAX_CHANGES + ' lines at a time.' };
  }
  const clean = [];
  for (let n = 0; n < changes.length; n++) {
    const c = cleanChange_(changes[n]);
    if (!c) return { ok: false, error: 'One of the changes could not be read.' };
    clean.push(c);
  }

  // From here on a failure is ours, not the reader's: a missing Sheet, a permission that
  // was never granted. Say so plainly, so the admin testing the form can see what broke
  // instead of a message that blames the suggestion.
  let id;
  try {
    id = store_(props, songId, body, clean);
  } catch (error) {
    console.error('store failed: ' + (error && error.stack || error));
    return { ok: false, error: 'The review queue is not set up correctly (' +
      String(error && error.message || error).slice(0, 200) + ').' };
  }
  if (!id) return { ok: false, error: 'Too many suggestions today. Please try again tomorrow.' };

  try {
    notify_(id);
  } catch (error) {
    // The suggestion is safely in the Sheet; a failed email must not lose it or make the
    // reader send it twice.
    console.error('notify failed: ' + (error && error.stack || error));
    const found = find_(id);
    if (found) sheet_().getRange(found.row, COL.commit).setValue('EMAIL NOT SENT: ' +
      String(error && error.message || error).slice(0, 200));
  }
  return { ok: true };
}

/** One change, rebuilt field by field so nothing unexpected is stored. Null if invalid. */
function cleanChange_(c) {
  if (!c || !Number.isInteger(c.i) || c.i < -1) return null;
  const n = c.n === undefined ? 0 : c.n;
  if (!Number.isInteger(n) || n < 0 || n > 500) return null;
  const line = function (value) {
    return typeof value === 'string' && value.length <= MAX_LINE && !/[\r\n\u0000]/.test(value);
  };
  const out = { i: c.i };
  if (n) out.n = n;

  if (Array.isArray(c.add)) {
    // Add lines after the address. `old: null` anchors on a removed line or the top.
    if (c.old !== null && !line(c.old)) return null;
    if (c.add.length < 1 || c.add.length > MAX_ADDED) return null;
    if (!c.add.every(function (text) { return line(text) && text.trim() !== ''; })) return null;
    out.old = c.old;
    out.add = c.add.slice();
    return out;
  }

  // Only an insert may address the top anchor: there is no line there to change.
  if (c.i === -1 && n === 0) return null;
  if (!line(c.old)) return null;
  out.old = c.old;
  if (c.del === true) {
    out.del = true;
    return out;
  }
  if (!line(c.new) || c.new === c.old || c.new.trim() === '') return null;
  out.new = c.new;
  return out;
}

/** Append the pending row. Returns its id, or null when today's cap is reached. */
function store_(props, songId, body, clean) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let id;
  try {
    const today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
    const counter = 'count:' + today;
    const count = Number(props.getProperty(counter) || 0);
    if (count >= MAX_PER_DAY) return null;
    props.setProperty(counter, String(count + 1));

    id = Utilities.getUuid();
    sheet_().appendRow([
      id, new Date(), 'pending', songId, plain_(text_(body.title, 200)), body.script,
      JSON.stringify(clean), plain_(body.name), plain_(text_(body.note, 500)), '', '',
      plain_(body.contact),
    ]);
  } finally {
    lock.releaseLock();
  }
  return id;
}

function notify_(id) {
  const props = PropertiesService.getScriptProperties();
  const row = find_(id).values;
  const link = function (action) {
    return webAppUrl_() + '?id=' + encodeURIComponent(id) + '&action=' + action +
      '&sig=' + sig_(id, action);
  };
  const html = summary_(row) +
    '<p style="font-size:16px">' +
    '<a href="' + esc_(link('accept')) + '"><b>Accept and publish</b></a>' +
    ' &nbsp;·&nbsp; ' +
    '<a href="' + esc_(link('reject')) + '">Reject</a></p>' +
    '<p style="color:#777;font-size:12px">Each link opens a confirmation page; nothing ' +
    'happens until you press the button there.</p>';
  MailApp.sendEmail({
    to: props.getProperty('ADMIN_EMAIL') || Session.getEffectiveUser().getEmail(),
    subject: 'Lyric correction: ' + row[COL.title - 1] + ' (' + row[COL.script - 1] + ')',
    htmlBody: html,
  });
}

/* --------------------------------------------------------------- admin decision --- */

function decide_(p) {
  if (!validSig_(p.id, p.action, p.sig)) return page_('Link not valid', '<p>This link is not valid.</p>');

  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const found = find_(p.id);
    if (!found) return page_('Not found', '<p>No such suggestion.</p>');
    const row = found.values;
    if (row[COL.status - 1] !== 'pending') {
      return page_('Already decided', '<p>This suggestion was already <b>' +
        esc_(row[COL.status - 1]) + '</b>.</p>');
    }
    const sheet = sheet_();

    if (p.action === 'reject') {
      sheet.getRange(found.row, COL.status).setValue('rejected');
      sheet.getRange(found.row, COL.decided).setValue(new Date());
      return page_('Rejected', '<p>Rejected. Nothing was published.</p>');
    }

    let commitUrl;
    try {
      commitUrl = publish_(Number(row[COL.songId - 1]), String(row[COL.script - 1]),
        JSON.parse(row[COL.changes - 1]));
    } catch (error) {
      // Left pending on purpose, so the same link can be used again once fixed.
      return page_('Could not publish', '<p>GitHub refused the change, so the suggestion ' +
        'is still pending.</p><pre>' + esc_(String(error && error.message || error)) + '</pre>');
    }
    sheet.getRange(found.row, COL.status).setValue('accepted');
    sheet.getRange(found.row, COL.decided).setValue(new Date());
    sheet.getRange(found.row, COL.commit).setValue(commitUrl);
    return page_('Published', '<p>Accepted. The site redeploys in a few minutes.</p>' +
      '<p><a href="' + esc_(commitUrl) + '" target="_blank">View the commit</a></p>');
  } finally {
    lock.releaseLock();
  }
}

/** Append the accepted entries to corrections.json on GitHub. Returns the commit URL. */
function publish_(songId, script, changes) {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('GITHUB_TOKEN is not set in Script Properties.');
  const api = 'https://api.github.com/repos/' + REPO + '/contents/' + FILE_PATH;
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');

  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = UrlFetchApp.fetch(api + '?ref=' + BRANCH, { headers: headers, muteHttpExceptions: true });
    if (got.getResponseCode() !== 200) {
      throw new Error('Reading corrections.json failed (HTTP ' + got.getResponseCode() + '): ' +
        got.getContentText().slice(0, 300));
    }
    const meta = JSON.parse(got.getContentText());
    const text = Utilities.newBlob(Utilities.base64Decode(meta.content.replace(/\s/g, '')))
      .getDataAsString('UTF-8');
    const doc = JSON.parse(text);
    if (doc.version !== 1 || typeof doc.songs !== 'object') {
      throw new Error('corrections.json has an unexpected shape.');
    }

    const key = String(songId);
    const list = doc.songs[key] || (doc.songs[key] = []);
    changes.forEach(function (c) {
      const entry = { s: script, i: c.i };
      if (c.n) entry.n = c.n;
      entry.old = c.old;
      if (c.add) entry.add = c.add;
      else if (c.del) entry.del = true;
      else entry.new = c.new;
      entry.at = today;
      list.push(entry);
    });

    const put = UrlFetchApp.fetch(api, {
      method: 'put',
      contentType: 'application/json',
      headers: headers,
      muteHttpExceptions: true,
      payload: JSON.stringify({
        message: 'Correction: song ' + songId + ' (' + script + ')',
        content: Utilities.base64Encode(JSON.stringify(doc, null, 1) + '\n', Utilities.Charset.UTF_8),
        sha: meta.sha,
        branch: BRANCH,
      }),
    });
    const code = put.getResponseCode();
    if (code === 200 || code === 201) return JSON.parse(put.getContentText()).commit.html_url;
    last = 'HTTP ' + code + ': ' + put.getContentText().slice(0, 300);
    // 409: the file moved under us (another accept, or a push). Re-read and try again.
    if (code !== 409) break;
    Utilities.sleep(800);
  }
  throw new Error('Writing corrections.json failed (' + last + ')');
}

/* ----------------------------------------------------------------------- helpers -- */

/** Run once from the editor after setting the properties: authorises and checks them. */
function testSetup() {
  const props = PropertiesService.getScriptProperties();
  ['GITHUB_TOKEN', 'UNLOCK_TOKEN'].forEach(function (name) {
    if (!props.getProperty(name)) throw new Error('Script Property ' + name + ' is not set.');
  });
  const got = UrlFetchApp.fetch(
    'https://api.github.com/repos/' + REPO + '/contents/' + FILE_PATH + '?ref=' + BRANCH,
    { headers: { Authorization: 'Bearer ' + props.getProperty('GITHUB_TOKEN') }, muteHttpExceptions: true });
  if (got.getResponseCode() !== 200) {
    throw new Error('GitHub token cannot read ' + FILE_PATH + ' (HTTP ' + got.getResponseCode() + ').');
  }
  const sheet = sheet_();
  secret_();
  Logger.log('Queue sheet: ' + sheet.getParent().getUrl());
  const to = props.getProperty('ADMIN_EMAIL') || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(to, 'Madhurageetam corrections: setup OK',
    'The review queue can read the repository, write to its sheet and email you.');
  Logger.log('Setup OK. Test email sent to ' + to);
}

/**
 * The queue's spreadsheet.
 *
 * Normally the Sheet this script is bound to. A script created on its own at
 * script.google.com has no such Sheet, and `getActiveSpreadsheet()` then returns null —
 * so in that case one is created on first use and remembered in SHEET_ID.
 */
function book_() {
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('SHEET_ID');
  if (saved) return SpreadsheetApp.openById(saved);
  const bound = SpreadsheetApp.getActiveSpreadsheet();
  if (bound) return bound;
  const created = SpreadsheetApp.create('Madhurageetam corrections');
  props.setProperty('SHEET_ID', created.getId());
  return created;
}

function sheet_() {
  const book = book_();
  let sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(SHEET_NAME);
    sheet.appendRow(COLUMNS);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() >= 1 && sheet.getLastColumn() < COLUMNS.length) {
    // A queue created before a column was added: extend its header row to match.
    sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);
  }
  return sheet;
}

function find_(id) {
  const sheet = sheet_();
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let n = 0; n < ids.length; n++) {
    if (ids[n][0] === id) {
      return { row: n + 2, values: sheet.getRange(n + 2, 1, 1, COLUMNS.length).getValues()[0] };
    }
  }
  return null;
}

/** HMAC secret for the accept/reject links, created on first use. */
function secret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('HMAC_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('HMAC_SECRET', secret);
  }
  return secret;
}

function sig_(id, action) {
  return Utilities.computeHmacSha256Signature(id + '|' + action, secret_())
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
    .join('');
}

function validSig_(id, action, sig) {
  return (action === 'accept' || action === 'reject') &&
    typeof id === 'string' && typeof sig === 'string' && sig === sig_(id, action);
}

function webAppUrl_() {
  return PropertiesService.getScriptProperties().getProperty('WEB_APP_URL') ||
    ScriptApp.getService().getUrl();
}

/** Old/new table for one suggestion, used by both the email and the confirm page. */
function summary_(row) {
  const songId = row[COL.songId - 1];
  const changes = JSON.parse(row[COL.changes - 1]);
  const cell = 'style="border:1px solid #ccc;padding:6px 9px;vertical-align:top;font-size:15px"';
  let html = '<p><b>' + esc_(row[COL.title - 1]) + '</b> · song ' + esc_(songId) + ' · ' +
    esc_(row[COL.script - 1]) + ' · <a href="' + SITE_URL + '#/song/' + encodeURIComponent(songId) +
    '" target="_blank">open on the site</a></p>';
  if (row[COL.name - 1] || row[COL.phone - 1]) {
    // The Sheet stores a leading apostrophe to keep "+91…" as text; drop it for display.
    html += '<p>From: ' + esc_(row[COL.name - 1]) + ' · ' +
      esc_(String(row[COL.phone - 1] || '').replace(/^'/, '')) + '</p>';
  }
  if (row[COL.note - 1]) html += '<p>Note: ' + esc_(row[COL.note - 1]) + '</p>';
  html += '<table style="border-collapse:collapse"><tr><th ' + cell + '>Line</th><th ' + cell +
    '>Now</th><th ' + cell + '>Suggested</th></tr>';
  const soft = function (text) { return '<i style="color:#888">' + text + '</i>'; };
  changes.forEach(function (c) {
    // Line numbers count the lines as shipped; "+2" is the second line added after one.
    const where = (c.i < 0 ? 'top' : String(c.i + 1)) + (c.n ? ' +' + c.n : '');
    let now, then;
    if (c.add) {
      now = soft(c.old === null ? (c.i < 0 && !c.n ? 'at the very top' : 'after a removed line')
        : 'after: ') + (c.old === null ? '' : esc_(c.old));
      then = soft('add ' + (c.add.length === 1 ? 'this line' : 'these lines') + ':') + '<br>' +
        c.add.map(esc_).join('<br>');
    } else if (c.del) {
      now = esc_(c.old);
      then = soft('remove this line');
    } else {
      now = esc_(c.old);
      then = esc_(c.new);
    }
    html += '<tr><td ' + cell + '>' + where + '</td><td ' + cell + '>' + now +
      '</td><td ' + cell + '>' + then + '</td></tr>';
  });
  return html + '</table>';
}

function page_(title, body) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px">' +
    '<h2>' + esc_(title) + '</h2>' + body + '</div>').setTitle(title);
}

function hidden_(name, value) {
  return '<input type="hidden" name="' + esc_(name) + '" value="' + esc_(value) + '">';
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function esc_(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function text_(value, max) {
  return (typeof value === 'string' ? value : '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

/** Stop a cell that starts like a formula from being evaluated by Sheets. */
function plain_(value) {
  return /^[=+\-@]/.test(value) ? "'" + value : value;
}
