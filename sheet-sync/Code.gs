/**
 * Brandi Home Library: Google Sheet sync for the Android app.
 *
 * Add this as a new script file in your Home Library sheet:
 *   Extensions > Apps Script > + > Script > name it LibraryApp > paste > Save
 * (keep your existing Code.gs, which holds the OPENLIB_ lookup functions)
 * Then follow SETUP.md in the repository.
 *
 * Tabs this script manages (it never edits your existing tabs):
 *   "App Catalogue"  one row per book, the shared catalogue the app syncs with
 *   "App Rooms"      one row per room, with its shelves
 * Cover photos are stored in a Drive folder called "Brandi Library Covers".
 */

const CATALOGUE = 'App Catalogue';
const ROOMS = 'App Rooms';
const FOLDER = 'Brandi Library Covers';
const FIELDS = ['id', 'title', 'author', 'isbn', 'genre', 'collection', 'pages', 'room', 'shelf', 'status',
  'notes', 'subjects', 'storygraph', 'wishlist', 'synopsis', 'photo', 'added', 'updated', 'deleted'];

/* ---------- menu ---------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Library App')
    .addItem('1. Set up app tabs', 'setup')
    .addItem('2. Email me the connection code', 'emailConnectionCode')
    .addSeparator()
    .addItem('Show connection code', 'showConnectionCode')
    .addItem('Change web app URL', 'resetWebAppUrl')
    .addToUi();
}

/* ---------- one-time setup ---------- */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('KEY')) props.setProperty('KEY', Utilities.getUuid().replace(/-/g, ''));
  folder_();

  let cat = ss.getSheetByName(CATALOGUE);
  if (!cat) cat = ss.insertSheet(CATALOGUE);
  if (cat.getLastRow() === 0) {
    cat.getRange(1, 1, 1, FIELDS.length).setValues([FIELDS]).setFontWeight('bold');
    cat.setFrozenRows(1);
  }
  let rooms = ss.getSheetByName(ROOMS);
  if (!rooms) rooms = ss.insertSheet(ROOMS);
  if (rooms.getLastRow() === 0) {
    rooms.getRange(1, 1, 1, 3).setValues([['room', 'shelves', 'updated']]).setFontWeight('bold');
    rooms.setFrozenRows(1);
  }

  let seeded = 0;
  if (cat.getLastRow() <= 1) seeded = seedFromLibrary_(ss, cat, rooms);

  const msg = seeded
    ? `Copied ${seeded} books into "${CATALOGUE}". Next: Deploy > New deployment (see SETUP.md), then Library App > Email me the connection code.`
    : `"${CATALOGUE}" already has books, so nothing was copied. Next: Deploy, then Library App > Email me the connection code.`;
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

function clean_(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

function seedFromLibrary_(ss, cat, roomsSheet) {
  const lib = ss.getSheetByName('Library');
  if (!lib) return 0;
  const rows = lib.getDataRange().getValues().slice(1);
  const statusMap = { Y: 'read', N: 'unread', S: 'started' };
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const out = [], seen = {}, roomSet = {};
  rows.forEach(r => {
    let isbn = clean_(r[0]), title = clean_(r[2]);
    const author = clean_(r[3]);
    if (!title && !isbn) return;
    if (isbn === 'N/A') isbn = '';
    if (!title && isbn === '9780358439103') title = 'Punch Me Up to the Gods';
    let coll = clean_(r[4]); if (coll === 'Loading...') coll = '';
    const auto = clean_(r[8]);
    const genre = clean_(r[6]) || (auto !== 'Needs review' ? auto : '');
    const subs = [], low = {};
    String(r[5] || '').split(',').forEach(s => {
      s = clean_(s);
      if (s && !low[s.toLowerCase()] && !/^(nyt:|collection:)/.test(s)) { low[s.toLowerCase()] = 1; subs.push(s); }
    });
    let room = clean_(r[10]); if (room === 'Offce') room = 'Office';
    if (room) roomSet[room] = 1;
    const pages = parseInt(r[9], 10);
    out.push({ title, author, isbn, genre, collection: coll || 'General Library', pages: pages > 0 ? pages : '',
      room, shelf: '', status: statusMap[clean_(r[12]).toUpperCase()] || '', notes: clean_(r[11]),
      subjects: subs.slice(0, 15).join(' | '), storygraph: clean_(r[7]).toUpperCase() === 'Y', wishlist: false, synopsis: '' });
    seen[title.toLowerCase()] = 1;
  });
  const want = ss.getSheetByName('Books I want');
  if (want) {
    want.getDataRange().getValues().slice(1).forEach(r => {
      const title = clean_(r[2]);
      if (!title || seen[title.toLowerCase()]) return;
      out.push({ title, author: clean_(r[3]), isbn: '', genre: clean_(r[4]), collection: 'General Library', pages: '',
        room: '', shelf: '', status: '', notes: clean_(r[6]).toUpperCase() === 'Y' ? 'Ordered' : '', subjects: '',
        storygraph: false, wishlist: true, synopsis: clean_(r[5]).slice(0, 600) });
    });
  }
  const values = out.map((b, i) => FIELDS.map(f => {
    if (f === 'id') return 'b' + ('000' + (i + 1)).slice(-4);
    if (f === 'added') return today;
    if (f === 'updated') return now;
    if (f === 'deleted') return false;
    if (f === 'photo') return '';
    return b[f];
  }));
  if (values.length) {
    cat.getRange(2, 1, values.length, FIELDS.length).setNumberFormat('@').setValues(values.map(r => r.map(v => typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v))));
  }
  const rv = Object.keys(roomSet).sort().map(r => [r, '', now]);
  if (rv.length) roomsSheet.getRange(2, 1, rv.length, 3).setNumberFormat('@').setValues(rv);
  return values.length;
}

/* ---------- connection code ---------- */
function webAppUrl_() {
  const props = PropertiesService.getScriptProperties();
  let url = props.getProperty('WEBAPP_URL');
  if (url) return url;
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Web app URL', 'Paste the Web app URL from Deploy > Manage deployments (it ends in /exec):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) throw new Error('Cancelled.');
  url = r.getResponseText().trim();
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) throw new Error('That URL should start with https://script.google.com/ and end with /exec.');
  props.setProperty('WEBAPP_URL', url);
  return url;
}
function resetWebAppUrl() { PropertiesService.getScriptProperties().deleteProperty('WEBAPP_URL'); SpreadsheetApp.getUi().alert('Cleared. The next connection code will ask for the URL again.'); }
function connectionCode_() {
  const key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key) throw new Error('Run Library App > Set up app tabs first.');
  const url = webAppUrl_();
  return 'BLIB1:' + Utilities.base64EncodeWebSafe(url + '\n' + key);
}
function showConnectionCode() {
  const code = connectionCode_();
  const html = HtmlService.createHtmlOutput(
    '<p style="font-family:sans-serif">Paste this into the app under Settings &gt; Connect to Google Sheet:</p>' +
    '<textarea style="width:100%;height:120px" onclick="this.select()">' + code + '</textarea>').setWidth(460).setHeight(240);
  SpreadsheetApp.getUi().showModalDialog(html, 'Connection code');
}
function emailConnectionCode() {
  const code = connectionCode_();
  const me = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(me, 'Brandi Home Library connection code',
    'Open this email on each phone or tablet, copy the code below, and paste it into the app under Settings > Connect to Google Sheet.\n\n' +
    code + '\n\nKeep this code private: anyone with it can read and change your catalogue.');
  SpreadsheetApp.getUi().alert('Sent to ' + me + '. Open it on your phone and copy the code into the app.');
}

/* ---------- web app ---------- */
function doGet() { return json_({ ok: true, app: 'brandi-library' }); }

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_request' }); }
  if (req.key !== PropertiesService.getScriptProperties().getProperty('KEY')) return json_({ ok: false, error: 'bad_key' });
  try {
    switch (req.action) {
      case 'pull': return json_(pull_());
      case 'push': return json_(push_(req));
      case 'photoUp': return json_(photoUp_(req));
      case 'photoGet': return json_(photoGet_(req));
      default: return json_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return json_({ ok: false, error: 'server', message: String(err && err.message || err) });
  }
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '". Run Library App > Set up app tabs.');
  return sh;
}

function rowToBook_(r) {
  const b = {};
  FIELDS.forEach((f, i) => b[f] = r[i]);
  b.id = String(b.id);
  b.pages = parseInt(b.pages, 10) > 0 ? parseInt(b.pages, 10) : null;
  b.storygraph = String(b.storygraph).toUpperCase() === 'TRUE';
  b.wishlist = String(b.wishlist).toUpperCase() === 'TRUE';
  b.deleted = String(b.deleted).toUpperCase() === 'TRUE';
  b.subjects = String(b.subjects || '').split('|').map(s => s.trim()).filter(Boolean);
  ['title', 'author', 'isbn', 'genre', 'collection', 'room', 'shelf', 'status', 'notes', 'synopsis', 'photo', 'added', 'updated']
    .forEach(f => b[f] = b[f] instanceof Date ? b[f].toISOString() : String(b[f] == null ? '' : b[f]));
  return b;
}
function bookToRow_(b) {
  return FIELDS.map(f => {
    let v = b[f];
    if (f === 'subjects') v = (v || []).join(' | ');
    if (typeof v === 'boolean') v = v ? 'TRUE' : 'FALSE';
    return v == null ? '' : String(v);
  });
}

function pull_() {
  const cat = sheet_(CATALOGUE);
  const vals = cat.getLastRow() > 1 ? cat.getRange(2, 1, cat.getLastRow() - 1, FIELDS.length).getValues() : [];
  const books = vals.filter(r => r[0]).map(rowToBook_);
  const rs = sheet_(ROOMS);
  const rv = rs.getLastRow() > 1 ? rs.getRange(2, 1, rs.getLastRow() - 1, 3).getValues() : [];
  const rooms = rv.filter(r => r[0]).map(r => ({ name: String(r[0]), shelves: String(r[1] || '').split('|').map(s => s.trim()).filter(Boolean) }));
  return { ok: true, books, rooms, serverTime: new Date().toISOString() };
}

function push_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cat = sheet_(CATALOGUE);
    const last = cat.getLastRow();
    const ids = last > 1 ? cat.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0])) : [];
    const upd = last > 1 ? cat.getRange(2, FIELDS.indexOf('updated') + 1, last - 1, 1).getValues().map(r => r[0] instanceof Date ? r[0].toISOString() : String(r[0])) : [];
    const index = {}; ids.forEach((id, i) => index[id] = i);
    const accepted = [], appended = [];
    (req.books || []).forEach(b => {
      if (!b || !b.id) return;
      const i = index[b.id];
      if (i === undefined) { appended.push(bookToRow_(b)); accepted.push(b.id); return; }
      if (String(b.updated) >= upd[i]) {
        cat.getRange(i + 2, 1, 1, FIELDS.length).setNumberFormat('@').setValues([bookToRow_(b)]);
        accepted.push(b.id);
      }
    });
    if (appended.length) cat.getRange(last + 1, 1, appended.length, FIELDS.length).setNumberFormat('@').setValues(appended);
    if (Array.isArray(req.rooms)) {
      const rs = sheet_(ROOMS);
      if (rs.getLastRow() > 1) rs.getRange(2, 1, rs.getLastRow() - 1, 3).clearContent();
      const now = new Date().toISOString();
      const rows = req.rooms.filter(r => r && r.name).map(r => [r.name, (r.shelves || []).join(' | '), now]);
      if (rows.length) rs.getRange(2, 1, rows.length, 3).setNumberFormat('@').setValues(rows);
    }
    return { ok: true, accepted, serverTime: new Date().toISOString() };
  } finally { lock.releaseLock(); }
}

function folder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const it = DriveApp.getFoldersByName(FOLDER);
  const f = it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER);
  props.setProperty('FOLDER', f.getId());
  return f;
}

function photoUp_(req) {
  if (!req.data || !req.bookId) return { ok: false, error: 'bad_request' };
  const blob = Utilities.newBlob(Utilities.base64Decode(req.data), 'image/jpeg', req.bookId + '-' + Date.now() + '.jpg');
  const file = folder_().createFile(blob);
  if (req.replaces) { try { DriveApp.getFileById(req.replaces).setTrashed(true); } catch (e) {} }
  return { ok: true, photo: file.getId() };
}

function photoGet_(req) {
  const file = DriveApp.getFileById(req.photo);
  if (file.getParents().next().getId() !== folder_().getId()) return { ok: false, error: 'not_found' };
  return { ok: true, data: Utilities.base64Encode(file.getBlob().getBytes()) };
}
