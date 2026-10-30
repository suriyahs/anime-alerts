/**
 * anime alerts - google apps script
 *
 * for every confirmed subscriber it reads their public anilist lists
 * (watching/planning/cmpleted) and sends an email and/or discord webhook
 * message when:
 *   - a new episode of something they are watching has aired
 *   - something on their planning list starts airing
 *   - a sequel/spin-off/side story/future prequel/parent
 *     of anything on their lists is announced or starts airing
 *     (follows anilist relations, so renamed seasons still count)
 */


const CFG = {
  MAX_SUBSCRIBERS: 30,            // signups stop when the sheet has this many rows
  MAX_PER_EMAIL: 3,               // anilist accounts per email address
  MAX_CONFIRM_EMAILS_PER_DAY: 25, // protects gmail quota from signup spam
  REL_TTL_HOURS: 12,              // how long franchise relations are cached
  REL_TYPES: ['SEQUEL', 'SPIN_OFF', 'SIDE_STORY', 'PREQUEL', 'PARENT'],
  REL_FORMATS: ['TV', 'TV_SHORT', 'MOVIE', 'ONA', 'OVA', 'SPECIAL'],
  DEPTH: 15,                       // follow relations
  SENDER_NAME: 'Anime Alerts',
  RUN_BUDGET_MS: 4.5 * 60 * 1000  // stop a run before googles 6 minute limit
};

const COL = { EMAIL: 1, USER: 2, HOOK: 3, MAIL: 4, TOKEN: 5, OK: 6, CREATED: 7, CHECKED: 8, SEEN: 9 };

const REL_LABEL = {
  SEQUEL: 'sequel',
  SPIN_OFF: 'spin-off',
  SIDE_STORY: 'side story',
  PREQUEL: 'prequel',
  PARENT: 'parent work'
};

/* ---------- setup ---------- */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  props_().setProperty('SHEET_ID', ss.getId());
  if (!ss.getSheetByName('Subscribers')) {
    const sh = ss.insertSheet('Subscribers');
    sh.appendRow(['email', 'anilist', 'discord_webhook', 'email_alerts', 'token', 'confirmed', 'created', 'last_checked', 'seen']);
    sh.setFrozenRows(1);
  }
  if (!ss.getSheetByName('RelCache')) {
    ss.insertSheet('RelCache').appendRow(['id', 'json', 'ts']);
  }
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('checkAll').timeBased().everyHours(2).create();
  ScriptApp.newTrigger('cleanup').timeBased().everyDays(1).atHour(4).create();
  Logger.log('setup ok');
}


/* ---------- helpers ---------- */

function props_() { return PropertiesService.getScriptProperties(); }
function ss_() { return SpreadsheetApp.openById(props_().getProperty('SHEET_ID')); }
function sheet_() { return ss_().getSheetByName('Subscribers'); }
function baseUrl_() { return props_().getProperty('BASE_URL') || ScriptApp.getService().getUrl(); }
function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function safeParse_(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) {
    return {};
  }
}

function findRow_(token) {
  if (!token || String(token).length < 20) return 0;
  const f = sheet_().createTextFinder(String(token)).matchEntireCell(true).findNext();
  return f && f.getColumn() === COL.TOKEN ? f.getRow() : 0;
}

/* ---------- webapp ---------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'confirm') {
    return msg_(confirm_(p.token)
      ? 'you are subscribed. your first alerts will arrive within a couple of hours. have a good day son'
      : 'this confirmation link is invalid or has expired');
  }
  if (p.action === 'unsub') {
    return msg_(unsub_(p.token)
      ? 'you have been unsubscribed and your details were deleted'
      : 'this link is invalid, or you were already removed');
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('anime alerts')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function msg_(text) {
  return HtmlService.createHtmlOutput(
    '<style>body{background:#000;color:#fff;font-family:sans-serif;max-width:480px;margin:60px auto;padding:0 16px}</style>' +
    '<h2>Anime Alerts</h2><p>' + esc_(text) + '</p>')
    .setTitle('anime alerts')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function confirm_(token) {
  const r = findRow_(token);
  if (!r) return false;
  sheet_().getRange(r, COL.OK).setValue(true);
  return true;
}

function unsub_(token) {
  const r = findRow_(token);
  if (!r) return false;
  sheet_().deleteRow(r);
  return true;
}

/* ---------- signup ---------- */

function subscribe(email, user, hook, emailAlerts) {
  email = String(email || '').trim().toLowerCase();
  user = String(user || '').trim().replace(/^@/, '');
  hook = String(hook || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return { ok: false, error: 'please enter a valid email address' };
  }
  if (!/^[A-Za-z0-9_]{2,30}$/.test(user)) {
    return { ok: false, error: 'thats not an anilist username' };
  }
  if (hook && !/^https:\/\/(\w+\.)?discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(hook)) {
    return { ok: false, error: 'that is not a discord webhook url' };
  }
  if (!hook) emailAlerts = true;

  const problem = checkUser_(user);
  if (problem) return { ok: false, error: problem };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy right now, please try again in a minute' };
  try {
    const sh = sheet_();
    const n = sh.getLastRow() - 1;
    const rows = n > 0 ? sh.getRange(2, 1, n, COL.OK).getValues() : [];
    const same = rows.filter(function (r) { return String(r[0]).toLowerCase() === email; });
    const dup = same.filter(function (r) { return String(r[1]).toLowerCase() === user.toLowerCase(); })[0];

    if (dup) {
      if (dup[COL.OK - 1] === true) {
        return { ok: true, message: 'you are already subscribed. use the unsubscribe link in any alert email to leave' };
      }
      if (!confirmQuota_()) return { ok: false, error: 'too many signups today, please try again tomorrow' };
      sendConfirm_(email, dup[COL.TOKEN - 1]);
      return { ok: true, message: 'confirmation email sent again. check your inbox and spam folder' };
    }
    if (rows.length >= CFG.MAX_SUBSCRIBERS) return { ok: false, error: 'sorry, signups are full' };
    if (same.length >= CFG.MAX_PER_EMAIL) return { ok: false, error: 'too many accounts for this email address' };
    if (!confirmQuota_()) return { ok: false, error: 'too many signups today, please try again tomorrow' };

    const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    sendConfirm_(email, token);
    sh.appendRow([email, user, hook, !!emailAlerts, token, false, new Date(), 0, '{}']);
    return { ok: true, message: 'almost done. check your inbox (and spam folder) for a confirmation link' };
  } finally {
    lock.releaseLock();
  }
}

function confirmQuota_() {
  const key = 'cq_' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd');
  const n = Number(props_().getProperty(key) || 0);
  if (n >= CFG.MAX_CONFIRM_EMAILS_PER_DAY) return false;
  props_().setProperty(key, String(n + 1));
  return true;
}

function sendConfirm_(email, token) {
  const url = baseUrl_() + '?action=confirm&token=' + token;
  MailApp.sendEmail({
    to: email,
    name: CFG.SENDER_NAME,
    subject: 'confirm your anime alerts subscription',
    htmlBody: '<p>someone (hopefully you) signed up for anime alerts with this email address.</p>' +
      '<p><a href="' + url + '">Click here to confirm</a></p>' +
      '<p>if this was not you, ignore this email and nothing will happen.</p>'
  });
}

/* ---------- anilist ---------- */

function anilist_(query, variables) {
  for (let i = 0; i < 4; i++) {
    const res = UrlFetchApp.fetch('https://graphql.anilist.co', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ query: query, variables: variables }),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code === 429) {
      const wait = Math.min(60, Number(res.getHeaders()['Retry-After']) || 30);
      Utilities.sleep((wait + 1) * 1000);
      continue;
    }
    if (code >= 500) { Utilities.sleep(2000 * (i + 1)); continue; }
    let body = null;
    try { body = JSON.parse(res.getContentText()); } catch (e) { body = null; }
    Utilities.sleep(800); // stay well under anilist rate limit
    return { code: code, body: body };
  }
  return { code: 0, body: null };
}

function checkUser_(user) {
  const q = 'query($u:String){MediaListCollection(userName:$u,type:ANIME,chunk:1,perChunk:1){lists{name}}}';
  const r = anilist_(q, { u: user });
  if (r.body && r.body.errors) {
    const m = JSON.stringify(r.body.errors);
    if (/private/i.test(m)) return 'that anilist is private. make it public in anilist settings, then try again';
    if (/not found/i.test(m)) return 'anilist user not found, check the spelling';
    return 'anilist returned an error, please try again later';
  }
  return r.body && r.body.data ? null : 'could not reach anilist, please try again later';
}

function fetchList_(user) {
  const q = 'query($u:String,$c:Int){MediaListCollection(userName:$u,type:ANIME,chunk:$c,perChunk:500){' +
    'hasNextChunk lists{isCustomList entries{status media{id status episodes siteUrl ' +
    'title{romaji english} startDate{year month day} nextAiringEpisode{episode}}}}}}';
  const out = {};
  for (let c = 1; c <= 10; c++) {
    const r = anilist_(q, { u: user, c: c });
    const d = r.body && r.body.data && r.body.data.MediaListCollection;
    if (!d) return null;
    d.lists.forEach(function (l) {
      if (l.isCustomList) return;
      l.entries.forEach(function (e) {
        const m = e.media;
        out[m.id] = {
          id: m.id,
          title: m.title.english || m.title.romaji,
          url: m.siteUrl,
          lstatus: e.status,
          mstatus: m.status,
          episodes: m.episodes,
          next: m.nextAiringEpisode ? m.nextAiringEpisode.episode : null,
          date: m.startDate
        };
      });
    });
    if (!d.hasNextChunk) break;
  }
  return out;
}

// fils cache[id] = {edges, ts} for any ids that are missing or older than the ttl
function relationsFor_(ids, cache) {
  const now = Date.now();
  const ttl = CFG.REL_TTL_HOURS * 3600 * 1000;
  const need = ids.filter(function (id) { return !cache[id] || now - cache[id].ts > ttl; });
  const q = 'query($ids:[Int]){Page(perPage:25){media(id_in:$ids,type:ANIME){id relations{edges{relationType ' +
    'node{id type format status siteUrl title{romaji english} startDate{year month day}}}}}}}';
  for (let i = 0; i < need.length; i += 25) {
    const chunk = need.slice(i, i + 25);
    const r = anilist_(q, { ids: chunk });
    const media = r.body && r.body.data && r.body.data.Page && r.body.data.Page.media;
    if (!media) continue;
    media.forEach(function (m) {
      const edges = m.relations.edges
        .filter(function (e) {
          return CFG.REL_TYPES.indexOf(e.relationType) >= 0 && e.node.type === 'ANIME' &&
            CFG.REL_FORMATS.indexOf(e.node.format) >= 0;
        })
        .map(function (e) {
          return { rt: e.relationType, id: e.node.id, st: e.node.status, u: e.node.siteUrl,
                   t: e.node.title.english || e.node.title.romaji, d: e.node.startDate };
        });
      cache[m.id] = { edges: edges, ts: now };
    });
  }
}

function loadCache_() {
  const sh = ss_().getSheetByName('RelCache');
  const n = sh.getLastRow() - 1;
  const v = n > 0 ? sh.getRange(2, 1, n, 3).getValues() : [];
  const c = {};
  v.forEach(function (r) {
    try { c[r[0]] = { edges: JSON.parse(r[1]), ts: Number(r[2]) }; } catch (e) { /* skip bad row */ }
  });
  return c;
}

function saveCache_(c) {
  const now = Date.now();
  const rows = [];
  Object.keys(c).forEach(function (id) {
    if (now - c[id].ts < 7 * 864e5) rows.push([Number(id), JSON.stringify(c[id].edges), c[id].ts]);
  });
  const sh = ss_().getSheetByName('RelCache');
  sh.clearContents();
  sh.getRange(1, 1, 1, 3).setValues([['id', 'json', 'ts']]);
  if (rows.length) sh.getRange(2, 1, rows.length, 3).setValues(rows);
}

/* ---------- checking ---------- */

function processUser_(row, cache) {
  const list = fetchList_(row.user);
  if (!list) return { error: true };
  const seen = row.seen;
  const events = [];
  const ACTIVE = ['CURRENT', 'PLANNING', 'COMPLETED', 'REPEATING'];
  const ids = Object.keys(list).map(Number).filter(function (id) { return ACTIVE.indexOf(list[id].lstatus) >= 0; });

  // 1) new episodes (watching) and planning shows that started airing
  ids.forEach(function (id) {
    const m = list[id];
    if (m.lstatus === 'CURRENT') {
      const k = 'e' + id;
      const latest = m.next ? m.next - 1 : (m.mstatus === 'FINISHED' ? m.episodes : null);
      if (latest === null || latest === undefined) {
        if (m.mstatus === 'NOT_YET_RELEASED' && seen[k] === undefined) seen[k] = 0;
      } else if (seen[k] === undefined) {
        seen[k] = latest; // first run: remember where things stand, dont spam
      } else if (latest > seen[k]) {
        events.push({ type: 'ep', title: m.title, url: m.url, from: seen[k], to: latest });
        seen[k] = latest;
      }
    } else if (m.lstatus === 'PLANNING') {
      const k = 'a' + id;
      const airing = m.mstatus === 'RELEASING';
      if (airing && seen[k] !== 1) {
        events.push({ type: 'airing', title: m.title, url: m.url });
        seen[k] = 1;
      } else if (!airing && seen[k] === undefined) {
        seen[k] = 0;
      }
      // upcoming planning show: alert when its release date gets confirmed or changes
      if (m.mstatus === 'NOT_YET_RELEASED') {
        const dk = 'd' + id;
        const ds = fmtDate_(m.date);
        if (seen[dk] !== undefined && seen[dk] !== ds) {
          events.push({ type: 'date', title: m.title, url: m.url, oldDate: seen[dk], newDate: ds });
        }
        seen[dk] = ds;
      }
    }
  });

  // 2) sequels/spin-offs/side stories, following relations up to DEPTH steps
  const inList = {};
  const names = {};
  Object.keys(list).forEach(function (id) { inList[id] = true; names[id] = list[id].title; });
  const visited = {};
  ids.forEach(function (id) { visited[id] = true; });
  const found = {};
  let frontier = ids.slice();
  for (let depth = 0; depth < CFG.DEPTH && frontier.length; depth++) {
    relationsFor_(frontier, cache);
    const next = [];
    frontier.forEach(function (id) {
      const rec = cache[id];
      if (!rec) return;
      rec.edges.forEach(function (e) {
        // dont announce titles already on users anilist, but DO continue through them so PAUSED/DROPPED entries cannot break a chain
        if (!inList[e.id] && !found[e.id]) {
          found[e.id] = {
            rt: e.rt, id: e.id, st: e.st,
            u: e.u, t: e.t, d: e.d, parent: names[id]
          };
        }
        if (!names[e.id]) names[e.id] = e.t;
        if (!visited[e.id]) {
          visited[e.id] = true;
          next.push(e.id);
        }
      });
    });

    frontier = next;
  }
  Object.keys(found).forEach(function (id) {
    const f = found[id];
    const k = 'r' + id;
    const dk = 'd' + id; // last known release date, like "date TBA", "2027", "2027-01"
    const dateStr = fmtDate_(f.d);
    const live = f.st === 'NOT_YET_RELEASED' || f.st === 'RELEASING';
    const prev = seen[k];
    if (prev === undefined) {
      seen[k] = f.st;
      seen[dk] = dateStr;
      if (live) events.push({ type: 'new', rt: f.rt, title: f.t, url: f.u, parent: f.parent, status: f.st, date: f.d });
    

    } else {
      const statusChanged = prev !== f.st;

      if (statusChanged) {
        seen[k] = f.st;

        if (f.st === 'RELEASING') {
          events.push({
            type: 'now', rt: f.rt, title: f.t,
            url: f.u, parent: f.parent
          });
        } else if (f.st === 'NOT_YET_RELEASED') {
          events.push({
            type: 'new', rt: f.rt, title: f.t,
            url: f.u, parent: f.parent,
            status: f.st, date: f.d
          });
        }
      }
      //alert on date changes when the status itself did not just change
      if (!statusChanged &&
          f.st === 'NOT_YET_RELEASED' &&
          seen[dk] !== undefined &&
          seen[dk] !== dateStr) {
        events.push({
          type: 'date', rt: f.rt, title: f.t,
          url: f.u, parent: f.parent,
          oldDate: seen[dk], newDate: dateStr
        });
      }
      seen[dk] = dateStr;
    }

  });

  return { events: events, seen: prune_(seen) };
}

function prune_(seen) {
  if (JSON.stringify(seen).length > 45000) {
    Object.keys(seen).forEach(function (k) {
      if (seen[k] === 'FINISHED' || seen[k] === 'CANCELLED' || seen[k] === 'HIATUS') {
        delete seen[k];
        delete seen['d' + k.slice(1)];
      }
    });
  }

  return seen;
}

function checkAll() {
  const p = props_();
  if (Date.now() - Number(p.getProperty('RUNNING') || 0) < 10 * 60 * 1000) return; // already running
  p.setProperty('RUNNING', String(Date.now()));
  const start = Date.now();
  try {
    const sh = sheet_();
    const n = sh.getLastRow() - 1;
    if (n < 1) return;
    const data = sh.getRange(2, 1, n, COL.SEEN).getValues();
    const rows = data.map(function (r) {
      return { email: r[0], user: r[1], hook: r[2], mail: r[3] === true, token: r[4],
               ok: r[5] === true, checked: Number(r[7]) || 0, seen: safeParse_(r[8]) };
    }).filter(function (r) { return r.ok; });
    rows.sort(function (a, b) { return a.checked - b.checked; }); // least recently checked first
    const cache = loadCache_();
    for (let i = 0; i < rows.length; i++) {
      if (Date.now() - start > CFG.RUN_BUDGET_MS) break;
      const row = rows[i];
      try {
        const res = processUser_(row, cache);
        if (res.error) { updateRow_(row.token, null); continue; }
        if (res.events.length && !notify_(row, res.events)) {
          // preserve the old seen state so events retry next run, but advance last_checked so one failing subscriber does not monopolize the queue
          updateRow_(row.token, null);
          continue;
        }
        updateRow_(row.token, res.seen);
      } catch (err) {
        console.error(row.user + ': ' + err);
        // keep seen unchanged (so uncommitted events can retry) but remain fair to other subscribers on the next run
        updateRow_(row.token, null);
      }
    }
    saveCache_(cache);
  } finally {
    p.deleteProperty('RUNNING');
  }
}


function updateRow_(token, seen) {
  const r = findRow_(token);
  if (!r) return; // they unsubscribed mid run
  const sh = sheet_();
  sh.getRange(r, COL.CHECKED).setValue(Date.now());
  if (seen) sh.getRange(r, COL.SEEN).setValue(JSON.stringify(seen));
}

/* ---------- notifications ---------- */

function fmtDate_(d) {
  if (!d || !d.year) return 'date TBA';
  return d.year + (d.month ? '-' + ('0' + d.month).slice(-2) : '') + (d.day ? '-' + ('0' + d.day).slice(-2) : '');
}


function render_(e, T, E) {
  const t = T(e.title, e.url);
  switch (e.type) {
    case 'ep':
      return '\uD83D\uDCFA ' + t + ' \u2014 ' +
        (e.to - e.from > 1 ? 'episodes ' + (e.from + 1) + '\u2013' + e.to + ' are' : 'episode ' + e.to + ' is') + ' out';
    case 'airing':
      return '\u25B6\uFE0F ' + t + ' (on your Planning list) is now airing';
    case 'new':
      return '\uD83C\uDD95 ' + t + ' \u2014 ' + REL_LABEL[e.rt] + ' of ' + E(e.parent) + ', ' +
        (e.status === 'RELEASING' ? 'airing now' : 'announced (' + fmtDate_(e.date) + ')');
    case 'now':
      return '\u25B6\uFE0F ' + t + ' \u2014 ' + REL_LABEL[e.rt] + ' of ' + E(e.parent) + ' just started airing';
    case 'date':
      return '\uD83D\uDCC5 ' + t + ' \u2014 ' + (e.rt ? REL_LABEL[e.rt] + ' of ' + E(e.parent) + ', ' : '') + 'release date updated (' +
        e.oldDate + ' \u2192 ' + e.newDate + ')';
  }
  return '';
}

function notify_(row, events) {
  const unsub = baseUrl_() + '?action=unsub&token=' + row.token;
  if (row.mail) {
    if (MailApp.getRemainingDailyQuota() < 1) return false;
    const items = events.map(function (e) {
      return '<li>' + render_(e, function (t, u) { return '<a href="' + esc_(u) + '">' + esc_(t) + '</a>'; }, esc_) + '</li>';
    }).join('');
    MailApp.sendEmail({
      to: row.email,
      name: CFG.SENDER_NAME,
      subject: 'anime alerts: ' + (events.length === 1 ? events[0].title : events.length + ' updates'),
      htmlBody: '<div style="font-family:sans-serif"><h3>anime updates</h3><ul>' + items + '</ul>' +
        '<p style="color:#888;font-size:12px"><a href="' + unsub + '">unsubscribe</a></p></div>'
      
    });
  }
  const hookOk = row.hook ? postDiscord_(row.hook, events, unsub) : true;
  return row.mail ? true : hookOk;
}

// true = delivered or permanently failed (deleted webhook); false = try again later
function postDiscord_(hook, events, unsub) {
  const lines = events.map(function (e) {
    return render_(e, function (t, u) { return '[' + t + '](' + u + ')'; }, function (s) { return s; });
  });
  lines.push('-# [Unsubscribe](<' + unsub + '>)');
  const chunks = [];
  let cur = '';
  lines.forEach(function (l) {
    if ((cur + '\n' + l).length > 1800) { chunks.push(cur); cur = l; } else { cur = cur ? cur + '\n' + l : l; }
  });

  if (cur) chunks.push(cur);
  for (let i = 0; i < chunks.length; i++) {
    let delivered = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = UrlFetchApp.fetch(hook, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({ content: chunks[i], flags: 4, username: CFG.SENDER_NAME })
      });
      const c = res.getResponseCode();

      // a deleted/unauthorized webhook cannot be repaired by retrying
      if (c === 404 || c === 401) return true;
      if (c >= 200 && c < 300) {
        delivered = true;
        break;
      }
      if (c === 429) {
        Utilities.sleep(3000);

        continue;
      }
      if (attempt === 1) return false;
    }
    // important: repeated 429 responses must not be treated as delivery
    if (!delivered) return false;
    Utilities.sleep(500);
  }
  return true;
}



function cleanup() {
  const sh = sheet_();
  const n = sh.getLastRow() - 1;
  if (n > 0) {
    const d = sh.getRange(2, 1, n, COL.CREATED).getValues();
    for (let i = d.length - 1; i >= 0; i--) {
      const age = Date.now() - new Date(d[i][COL.CREATED - 1]).getTime();
      if (d[i][COL.OK - 1] !== true && age > 3 * 864e5) sh.deleteRow(i + 2); // drop unconfirmed signups
    }
  }
  const all = props_().getProperties();
  const today = 'cq_' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd');
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('cq_') === 0 && k !== today) props_().deleteProperty(k);
  });
}