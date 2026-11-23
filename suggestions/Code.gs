/**
 * Review queue for reader-suggested lyric corrections.
 *
 * GitHub Pages is static, so it cannot receive a form. This script is the one moving
 * part behind it: bound to a private Google Sheet, deployed as a web app.
 *
 *   reader  --POST-->  doPost      append a "pending" row, email the admin
 *   admin   --GET--->  doGet       review page: every pending suggestion for the song,
 *                                  checked against what was accepted since it was sent
 *   admin   --POST-->  doPost      accept: commit the ticked changes to corrections.json
 *                                  reject: mark the row, publish nothing
 *
 * Nothing a reader sends is public until the admin accepts it. Accepting commits to
 * web/public/data/corrections.json on main, which triggers the normal Pages deploy.
 *
 * Several readers may correct one song at the same time. Rebase.gs holds the rules for
 * that; this file never publishes a change that would no longer apply.
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

// Everything from 'phone' on was added after the queue was in use. New columns go at
// the end, which keeps every existing row lined up with its header.
//   base       how many accepted corrections the song had when the reader opened it
//   decisions  what happened to each change on accept, in the order of `changes`
const COLUMNS = ['id', 'received', 'status', 'songId', 'title', 'script', 'changes',
  'name', 'note', 'decided', 'commit', 'phone', 'country', 'base', 'decisions'];
const COL = {};
COLUMNS.forEach(function (name, index) { COL[name] = index + 1; });

/* ------------------------------------------------------------------ entry points -- */

function doPost(e) {
  // The review page posts a form (action=accept|reject); readers post a JSON string.
  if (e && e.parameter && e.parameter.action) return decide_(e.parameter, e.parameters || {});
  try {
    return json_(receive_(JSON.parse(e.postData.contents)));
  } catch (error) {
    console.error('doPost failed: ' + (error && error.stack || error));
    return json_({ ok: false, error: 'Could not read the suggestion.' });
  }
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  const invalid = function () { return page_('Link not valid', '<p>This link is not valid.</p>'); };

  // A GET never acts. Mail clients and link scanners fetch every URL in a message, and
  // one of them must not be able to publish a change. It only shows the review page.
  if (p.song) {
    if (!validSig_('song:' + p.song, 'review', p.sig)) return invalid();
    return songPage_(Number(p.song), '');
  }

  // Links in emails sent before the review page existed: one suggestion, one action.
  if (!p.id || !p.action) return page_('Madhurageetam corrections', '<p>Nothing to do here.</p>');
  if (!isDecision_(p.action) || !validSig_(p.id, p.action, p.sig)) return invalid();
  const found = find_(p.id);
  if (!found) return page_('Not found', '<p>No such suggestion.</p>');
  const status = found.values[COL.status - 1];
  return songPage_(Number(found.values[COL.songId - 1]),
    status === 'pending' ? '' : 'That suggestion was already <b>' + esc_(status) + '</b>.');
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
  // Optional, and free text: where the reader lives need not match their dialling code.
  body.country = text_(body.country, 60);

  // How many accepted corrections the song had when the reader opened it. Absent from
  // a browser still running an older copy of the site; such a suggestion is published
  // unchecked, as all of them used to be.
  body.base = Number.isInteger(body.base) && body.base >= 0 && body.base < 100000 ? body.base : '';

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
      plain_(body.contact), plain_(body.country), body.base, '',
    ]);
  } finally {
    lock.releaseLock();
  }
  return id;
}

function notify_(id) {
  const props = PropertiesService.getScriptProperties();
  const row = find_(id).values;
  const songId = Number(row[COL.songId - 1]);
  const others = pending_(songId).length - 1;
  const html = summary_(row) +
    '<p style="font-size:16px"><a href="' + esc_(reviewUrl_(songId)) + '"><b>Review and decide</b></a></p>' +
    (others > 0 ? '<p>' + others + ' other suggestion' + (others === 1 ? ' is' : 's are') +
      ' waiting for this song. The review page shows them together.</p>' : '') +
    '<p style="color:#777;font-size:12px">The link opens the review page; nothing ' +
    'happens until you press a button there.</p>';
  MailApp.sendEmail({
    to: props.getProperty('ADMIN_EMAIL') || Session.getEffectiveUser().getEmail(),
    subject: 'Lyric correction: ' + row[COL.title - 1] + ' (' + row[COL.script - 1] + ')',
    htmlBody: html,
  });
}

function reviewUrl_(songId) {
  return webAppUrl_() + '?song=' + encodeURIComponent(songId) + '&sig=' + sig_('song:' + songId, 'review');
}

/* ------------------------------------------------------------------ review page --- */

/**
 * One suggestion against the song's accepted entries: see Rebase.gs for the statuses.
 *
 *   unchecked  the suggestion carries no base, so nothing can be said about it
 *   stale      its base is past the end of the list: entries were deleted by hand
 */
function evaluate_(values, list, picked) {
  const changes = JSON.parse(values[COL.changes - 1]);
  const script = String(values[COL.script - 1]);
  const raw = values[COL.base - 1];
  const known = raw !== '' && raw !== null && raw !== undefined && Number.isInteger(Number(raw));
  if (known && Number(raw) > list.length) {
    return {
      stale: true, unchecked: false,
      results: changes.map(function (c) { return { status: 'stale', change: c }; }),
    };
  }
  const landed = known
    ? list.slice(Number(raw)).filter(function (entry) { return entry && entry.s === script; })
    : [];
  return { stale: false, unchecked: !known, results: rebase_(changes, landed, picked) };
}

/** Every pending suggestion for one song, with what can still be published of each. */
function songPage_(songId, banner) {
  const rows = pending_(songId);
  let html = banner
    ? '<p style="background:#f4f1e8;border:1px solid #d9d2bd;padding:10px 12px">' + banner + '</p>'
    : '';
  if (rows.length === 0) {
    return page_('Song ' + songId, html + '<p>Nothing is waiting for review on this song.</p>');
  }

  let list;
  try {
    list = readCorrections_().doc.songs[String(songId)] || [];
  } catch (error) {
    return page_('Could not read the corrections', html + '<pre>' +
      esc_(String(error && error.message || error)) + '</pre>');
  }
  const evaluated = rows.map(function (row) { return evaluate_(row.values, list); });

  html += '<p><b>' + esc_(rows[0].values[COL.title - 1]) + '</b> · song ' + esc_(songId) +
    ' · <a href="' + SITE_URL + '#/song/' + encodeURIComponent(songId) +
    '" target="_blank">open on the site</a></p>';
  if (rows.length > 1) {
    html += '<p>' + rows.length + ' suggestions are waiting, oldest first. Each is checked ' +
      'against what is on the site now, and checked again after every decision.</p>';
  }

  const cell = 'style="border:1px solid #ccc;padding:6px 9px;vertical-align:top;font-size:15px"';
  const soft = function (text) { return '<i style="color:#888">' + text + '</i>'; };
  const quote = function (text) { return text === null ? soft('removed') : esc_(text); };

  rows.forEach(function (row, index) {
    const values = row.values;
    const mine = evaluated[index];
    const id = String(values[COL.id - 1]);

    // The other readers' version of each line this suggestion changes.
    const rivals = mine.results.map(function () { return null; });
    rows.forEach(function (other, otherIndex) {
      if (otherIndex === index || other.values[COL.script - 1] !== values[COL.script - 1]) return;
      if (mine.stale || evaluated[otherIndex].stale) return;
      competing_(mine.results, evaluated[otherIndex].results).forEach(function (text, k) {
        if (text !== undefined && !rivals[k]) {
          rivals[k] = { name: other.values[COL.name - 1], text: text };
        }
      });
    });

    html += '<form method="post" action="' + esc_(webAppUrl_()) + '" target="_top" ' +
      'style="border-top:2px solid #ddd;margin-top:22px;padding-top:6px">' +
      hidden_('id', id) + hidden_('sig', sig_(id, 'decide')) +
      '<p><b>' + esc_(values[COL.script - 1]) + '</b> · ' + who_(values) + ' · ' +
      esc_(Utilities.formatDate(new Date(values[COL.received - 1]), 'UTC', 'yyyy-MM-dd HH:mm') + ' UTC') + '</p>';
    if (values[COL.note - 1]) html += '<p>Note: ' + esc_(values[COL.note - 1]) + '</p>';
    if (mine.stale) {
      html += '<p>' + soft('corrections.json was edited by hand after this was sent, so it ' +
        'cannot be checked. Reject it, or add what you want by hand.') + '</p>';
    } else if (mine.unchecked) {
      html += '<p>' + soft('Sent from an older copy of the site: it cannot be checked ' +
        'against corrections accepted since. Compare with the site before publishing.') + '</p>';
    }

    html += '<table style="border-collapse:collapse"><tr><th ' + cell + '></th><th ' + cell +
      '>Line</th><th ' + cell + '>Was</th><th ' + cell + '>Suggested</th><th ' + cell + '>Status</th></tr>';
    const stored = JSON.parse(values[COL.changes - 1]);
    let open = 0;
    mine.results.forEach(function (result, k) {
      const shown = cells_(stored[k], result.change);
      const publishable = result.status === 'clean';
      if (publishable) open += 1;
      let status;
      if (result.status === 'applied') {
        status = 'Already on the site';
      } else if (result.status === 'conflict') {
        status = '<b>Conflict.</b> The line now reads: ' + quote(result.current) +
          (result.at ? ' ' + soft('(accepted ' + esc_(result.at) + ')') : '');
      } else if (result.status === 'stale') {
        status = soft('not checked');
      } else {
        status = mine.unchecked ? soft('not checked') : 'Ready';
        if (result.samePlace) status += '<br>Other lines were added here since. Check the order afterwards.';
        if (rivals[k]) {
          status += '<br><b>Competes</b> with ' + esc_(rivals[k].name) + ': ' + quote(rivals[k].text);
        }
      }
      html += '<tr><td ' + cell + '><input type="checkbox" name="pick" value="' + k + '"' +
        (publishable ? ' checked' : ' disabled') + '></td><td ' + cell + '>' + shown.where +
        '</td><td ' + cell + '>' + shown.now + '</td><td ' + cell + '>' + shown.then +
        '</td><td ' + cell + '>' + status + '</td></tr>';
    });
    html += '</table><p>' +
      (open > 0 ? '<button type="submit" name="action" value="accept" ' +
        'style="font-size:16px;padding:10px 18px">Publish ticked changes</button> &nbsp; ' : '') +
      '<button type="submit" name="action" value="reject" style="font-size:16px;padding:10px 18px">' +
      (open > 0 ? 'Reject' : 'Close: nothing left to publish') + '</button></p></form>';
  });

  return page_('Review: song ' + songId, html);
}

/* --------------------------------------------------------------- admin decision --- */

function decide_(p, multi) {
  const invalid = function () { return page_('Link not valid', '<p>This link is not valid.</p>'); };
  if (!isDecision_(p.action)) return invalid();
  // 'decide' signs the review page's form; the action itself signed the older pages.
  if (!validSig_(p.id, 'decide', p.sig) && !validSig_(p.id, p.action, p.sig)) return invalid();

  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const found = find_(p.id);
    if (!found) return page_('Not found', '<p>No such suggestion.</p>');
    const row = found.values;
    const songId = Number(row[COL.songId - 1]);
    if (row[COL.status - 1] !== 'pending') {
      return songPage_(songId, 'That suggestion was already <b>' + esc_(row[COL.status - 1]) + '</b>.');
    }
    const sheet = sheet_();

    if (p.action === 'reject') {
      sheet.getRange(found.row, COL.status).setValue('rejected');
      sheet.getRange(found.row, COL.decided).setValue(new Date());
      return songPage_(songId, 'Rejected. Nothing was published.');
    }

    const count = JSON.parse(row[COL.changes - 1]).length;
    const picked = [];
    for (let k = 0; k < count; k++) picked.push(false);
    (multi.pick || []).forEach(function (value) {
      const k = Number(value);
      if (Number.isInteger(k) && k >= 0 && k < count) picked[k] = true;
    });
    if (picked.indexOf(true) < 0) {
      return songPage_(songId, 'No change was ticked, so nothing was published. Tick the ' +
        'changes to publish, or reject the suggestion.');
    }

    let done;
    try {
      done = publish_(songId, row, picked);
    } catch (error) {
      // Left pending on purpose, so it can be published from the same page once fixed.
      return songPage_(songId, 'GitHub refused the change, so the suggestion is still pending.' +
        '<pre>' + esc_(String(error && error.message || error)) + '</pre>');
    }
    if (done.refused) return songPage_(songId, esc_(done.refused));

    sheet.getRange(found.row, COL.status).setValue('accepted');
    sheet.getRange(found.row, COL.decided).setValue(new Date());
    sheet.getRange(found.row, COL.commit).setValue(done.commitUrl || 'already on the site');
    sheet.getRange(found.row, COL.decisions).setValue(JSON.stringify(done.decisions));
    return songPage_(songId, done.commitUrl
      ? 'Published. The site redeploys in a few minutes. <a href="' + esc_(done.commitUrl) +
        '" target="_blank">View the commit</a>'
      : 'Everything ticked was already on the site, so there was nothing to publish. ' +
        'The suggestion is closed as accepted.');
  } finally {
    lock.releaseLock();
  }
}

function githubHeaders_() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('GITHUB_TOKEN is not set in Script Properties.');
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** corrections.json as it is on the branch now, with the sha a write must quote. */
function readCorrections_() {
  const api = 'https://api.github.com/repos/' + REPO + '/contents/' + FILE_PATH;
  const got = UrlFetchApp.fetch(api + '?ref=' + BRANCH, { headers: githubHeaders_(), muteHttpExceptions: true });
  if (got.getResponseCode() !== 200) {
    throw new Error('Reading corrections.json failed (HTTP ' + got.getResponseCode() + '): ' +
      got.getContentText().slice(0, 300));
  }
  const meta = JSON.parse(got.getContentText());
  const text = Utilities.newBlob(Utilities.base64Decode(meta.content.replace(/\s/g, '')))
    .getDataAsString('UTF-8');
  const doc = JSON.parse(text);
  if (doc.version !== 1 || !doc.songs || typeof doc.songs !== 'object') {
    throw new Error('corrections.json has an unexpected shape.');
  }
  return { doc: doc, sha: meta.sha };
}

/**
 * Publish the ticked changes of one suggestion, brought up to date first.
 *
 * Returns { commitUrl, decisions }, with an empty commitUrl when every ticked change was
 * already on the site, or { refused } when a ticked change no longer applies. Nothing
 * is committed in either of those cases: an entry that would not apply is never written.
 */
function publish_(songId, row, picked) {
  const script = String(row[COL.script - 1]);
  const api = 'https://api.github.com/repos/' + REPO + '/contents/' + FILE_PATH;
  const today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');

  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = readCorrections_();
    const doc = file.doc;
    const key = String(songId);
    const list = doc.songs[key] || (doc.songs[key] = []);

    // Checked against the file as just read, inside the retry loop: if another accept
    // lands between the read and the write, the write fails and this runs again.
    const checked = evaluate_(row, list, picked);
    if (checked.stale) {
      return { refused: 'corrections.json was edited by hand after this suggestion was sent, ' +
        'so it cannot be checked. Nothing was published.' };
    }
    const decisions = [];
    const entries = [];
    for (let k = 0; k < checked.results.length; k++) {
      const result = checked.results[k];
      if (!picked[k]) {
        decisions.push('left out');
      } else if (result.status === 'conflict') {
        return { refused: 'A ticked line was changed by another accepted correction in the ' +
          'meantime. Nothing was published; the page below shows where things stand now.' };
      } else if (result.status === 'applied') {
        decisions.push('already on the site');
      } else {
        decisions.push('published');
        entries.push(result.change);
      }
    }
    if (entries.length === 0) return { commitUrl: '', decisions: decisions };

    entries.forEach(function (c) {
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
      headers: githubHeaders_(),
      muteHttpExceptions: true,
      payload: JSON.stringify({
        message: 'Correction: song ' + songId + ' (' + script + ')',
        content: Utilities.base64Encode(JSON.stringify(doc, null, 1) + '\n', Utilities.Charset.UTF_8),
        sha: file.sha,
        branch: BRANCH,
      }),
    });
    const code = put.getResponseCode();
    if (code === 200 || code === 201) {
      return { commitUrl: JSON.parse(put.getContentText()).commit.html_url, decisions: decisions };
    }
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

/** The pending suggestions for one song, oldest first, as { row, values }. */
function pending_(songId) {
  const sheet = sheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const all = sheet.getRange(2, 1, last - 1, COLUMNS.length).getValues();
  const out = [];
  all.forEach(function (values, index) {
    if (values[COL.status - 1] === 'pending' && Number(values[COL.songId - 1]) === Number(songId)) {
      out.push({ row: index + 2, values: values });
    }
  });
  return out;
}

/** HMAC secret for the review links, created on first use. */
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
  return typeof id === 'string' && typeof sig === 'string' && sig === sig_(id, action);
}

function isDecision_(action) {
  return action === 'accept' || action === 'reject';
}

function webAppUrl_() {
  return PropertiesService.getScriptProperties().getProperty('WEB_APP_URL') ||
    ScriptApp.getService().getUrl();
}

/** Who sent a suggestion: name, phone and country, for the reviewer only. */
function who_(row) {
  // The Sheet stores a leading apostrophe to keep "+91…" as text; drop it for display.
  return esc_(row[COL.name - 1]) + ' · ' + esc_(String(row[COL.phone - 1] || '').replace(/^'/, '')) +
    (row[COL.country - 1] ? ' · ' + esc_(row[COL.country - 1]) : '');
}

/**
 * One change as table cells. `at` is where it applies now, when that differs from where
 * it was written (see rebase_); the wording always comes from the change as sent.
 */
function cells_(c, at) {
  const soft = function (text) { return '<i style="color:#888">' + text + '</i>'; };
  const place = at || c;
  // Line numbers count the lines as shipped; "+2" is the second line added after one.
  const where = (place.i < 0 ? 'top' : String(place.i + 1)) + (place.n ? ' +' + place.n : '');
  if (c.add) {
    return {
      where: where,
      now: soft(c.old === null ? (c.i < 0 && !c.n ? 'at the very top' : 'after a removed line')
        : 'after: ') + (c.old === null ? '' : esc_(c.old)),
      then: soft('add ' + (c.add.length === 1 ? 'this line' : 'these lines') + ':') + '<br>' +
        c.add.map(esc_).join('<br>'),
    };
  }
  return { where: where, now: esc_(c.old), then: c.del ? soft('remove this line') : esc_(c.new) };
}

/** Was/suggested table for one suggestion as it was sent, used by the email. */
function summary_(row) {
  const songId = row[COL.songId - 1];
  const changes = JSON.parse(row[COL.changes - 1]);
  const cell = 'style="border:1px solid #ccc;padding:6px 9px;vertical-align:top;font-size:15px"';
  let html = '<p><b>' + esc_(row[COL.title - 1]) + '</b> · song ' + esc_(songId) + ' · ' +
    esc_(row[COL.script - 1]) + ' · <a href="' + SITE_URL + '#/song/' + encodeURIComponent(songId) +
    '" target="_blank">open on the site</a></p>';
  if (row[COL.name - 1] || row[COL.phone - 1]) html += '<p>From: ' + who_(row) + '</p>';
  if (row[COL.note - 1]) html += '<p>Note: ' + esc_(row[COL.note - 1]) + '</p>';
  html += '<table style="border-collapse:collapse"><tr><th ' + cell + '>Line</th><th ' + cell +
    '>Was</th><th ' + cell + '>Suggested</th></tr>';
  changes.forEach(function (c) {
    const shown = cells_(c);
    html += '<tr><td ' + cell + '>' + shown.where + '</td><td ' + cell + '>' + shown.now +
      '</td><td ' + cell + '>' + shown.then + '</td></tr>';
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
