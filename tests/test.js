const fs = require('fs');
const vm = require('vm');
const dir = process.argv[2] || require('path').join(__dirname, '..', 'src');
const code = fs.readFileSync(dir + '/Code.gs', 'utf8');

// ---- mocks ----
let apiState;
const sent = [];
const ctx = {
  console, Date, JSON, Math, Object, Number, String, Array,
  Utilities: { sleep() {}, getUuid: () => 'x'.repeat(8) + '-' + 'y'.repeat(4) + '-' + 'z'.repeat(4) + '-' + 'w'.repeat(4) + '-' + 'v'.repeat(12), formatDate: () => '20261028' },
  UrlFetchApp: {
    fetch(url, opt) {
      if (url.indexOf('graphql.anilist.co') >= 0) {
        const p = JSON.parse(opt.payload);
        const body = apiState(p.query, p.variables);
        return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => JSON.stringify(body) };
      }
      sent.push({ url, payload: JSON.parse(opt.payload) });
      return { getResponseCode: () => 204 };
    }
  },
  MailApp: { sendEmail(o) { sent.push({ mail: o }); }, getRemainingDailyQuota: () => 100 },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'https://example/exec', setProperty() {}, deleteProperty() {}, getProperties: () => ({}) }) },
  ScriptApp: { getService: () => ({ getUrl: () => 'https://example/exec' }) },
};
vm.createContext(ctx);
vm.runInContext(code, ctx);

function listResp(entries) {
  return { data: { MediaListCollection: { hasNextChunk: false, lists: [{ isCustomList: false, entries }] } } };
}
const media = (id, title, status, episodes, next) => ({ id, status, episodes, siteUrl: 'https://anilist.co/anime/' + id, title: { romaji: title, english: null }, nextAiringEpisode: next ? { episode: next } : null });

let relations = {};
let list = [];
apiState = (q, v) => {
  if (q.indexOf('MediaListCollection') >= 0) return listResp(list);
  if (q.indexOf('relations') >= 0) {
    return { data: { Page: { media: v.ids.map(id => ({ id, relations: { edges: relations[id] || [] } })) } } };
  }
  return {};
};
const edge = (rt, id, title, status, fmt = 'TV', date = { year: 2027, month: 1, day: null }) =>
  ({ relationType: rt, node: { id, type: 'ANIME', format: fmt, status, siteUrl: 'https://anilist.co/anime/' + id, title: { romaji: title, english: null }, startDate: date } });

let fails = 0;
function check(name, cond) { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; }

// Scenario setup
list = [
  { status: 'CURRENT', media: media(1, 'Show A', 'RELEASING', 12, 6) },        // latest aired = 5
  { status: 'PLANNING', media: media(2, 'Show B', 'NOT_YET_RELEASED', null, null) },
  { status: 'COMPLETED', media: media(3, 'Show C', 'FINISHED', 12, null) },
  { status: 'DROPPED', media: media(4, 'Show D', 'FINISHED', 12, null) },
];
relations = { 3: [edge('SEQUEL', 30, 'Show C Season 2', 'NOT_YET_RELEASED'), edge('ADAPTATION', 99, 'Manga', 'FINISHED', 'MANGA'), edge('SIDE_STORY', 31, 'Show C Special', 'FINISHED', 'SPECIAL')],
              30: [edge('SEQUEL', 300, 'Show C Season 3', 'NOT_YET_RELEASED')], 4: [edge('SEQUEL', 40, 'Show D S2', 'RELEASING')] };

const row = { user: 'tester', seen: {} };
let cache = {};
let r = ctx.processUser_(row, cache);
check('first run: no episode spam', !r.events.some(e => e.type === 'ep'));
check('first run: announced sequel (S2) alerted', r.events.some(e => e.type === 'new' && e.title === 'Show C Season 2'));
check('first run: depth-2 sequel (S3) alerted', r.events.some(e => e.type === 'new' && e.title === 'Show C Season 3'));
check('special (non-listed format) ignored', !r.events.some(e => e.title === 'Show C Special'));
check('dropped show relations ignored', !r.events.some(e => e.title === 'Show D S2'));
console.log(JSON.stringify(r.events.map(e => e.type + ':' + e.title)));

// second run, nothing changed
r = ctx.processUser_({ user: 'tester', seen: r.seen }, cache);
check('second run: nothing new', r.events.length === 0);

// new episode + planning starts airing + S2 starts airing
list[0].media.nextAiringEpisode = { episode: 8 }; // latest=7 (was 5): eps 6-7
list[1].media.status = 'RELEASING';
relations[3][0].node.status = 'RELEASING';
cache = {};
let seen = r.seen;
r = ctx.processUser_({ user: 'tester', seen }, cache);
check('new episodes batched 6-7', r.events.some(e => e.type === 'ep' && e.from === 5 && e.to === 7));
check('planning show airing alert', r.events.some(e => e.type === 'airing' && e.title === 'Show B'));
check('sequel started airing alert', r.events.some(e => e.type === 'now' && e.title === 'Show C Season 2'));
console.log(JSON.stringify(r.events.map(e => e.type + ':' + e.title)));

// user later adds S2 to their list: should not alert as new sequel
list.push({ status: 'CURRENT', media: media(30, 'Show C Season 2', 'RELEASING', 12, 2) });
cache = {};
r = ctx.processUser_({ user: 'tester', seen: r.seen }, cache);
check('sequel added to list does not re-alert', !r.events.some(e => e.type === 'new' && e.title === 'Show C Season 2'));

// rendering
const html = ctx.render_({ type: 'new', rt: 'SEQUEL', title: 'X <b>', url: 'https://a', parent: 'P', status: 'NOT_YET_RELEASED', date: { year: 2027, month: 4, day: null } }, (t, u) => `<a href="${u}">${t}</a>`, s => s);
console.log(html);
check('render includes date', html.indexOf('2027-04') >= 0);

// notify via mail + discord
sent.length = 0;
ctx.notify_({ email: 'a@b.c', mail: true, hook: 'https://discord.com/api/webhooks/1/abc', token: 'tok', user: 'tester' },
  [{ type: 'ep', title: 'Show A', url: 'https://a', from: 5, to: 7 }]);
check('email sent', sent.some(s => s.mail && s.mail.to === 'a@b.c'));
check('discord posted', sent.some(s => s.url && s.payload.content.indexOf('episodes 6') >= 0));
check('unsubscribe link in email', sent.find(s => s.mail).mail.htmlBody.indexOf('action=unsub&token=tok') >= 0);

// ---- release date tracking ----
list = [{ status: 'COMPLETED', media: media(50, 'Show E', 'FINISHED', 12, null) }];
const setDate = (d) => { relations = { 50: [edge('SEQUEL', 500, 'Show E Season 2', 'NOT_YET_RELEASED', 'TV', d)] }; };
setDate({ year: null, month: null, day: null });
let d1 = ctx.processUser_({ user: 't', seen: {} }, {});
check('date: announced with TBA alerts once', d1.events.length === 1 && d1.events[0].type === 'new');
let d2 = ctx.processUser_({ user: 't', seen: d1.seen }, {});
check('date: unchanged TBA is silent', d2.events.length === 0);
setDate({ year: 2027, month: null, day: null });
let d3 = ctx.processUser_({ user: 't', seen: d2.seen }, {});
check('date: TBA -> 2027 alerts', d3.events.length === 1 && d3.events[0].type === 'date' && d3.events[0].oldDate === 'date TBA' && d3.events[0].newDate === '2027');
setDate({ year: 2027, month: 1, day: null });
let d4 = ctx.processUser_({ user: 't', seen: d3.seen }, {});
check('date: 2027 -> 2027-01 alerts', d4.events.length === 1 && d4.events[0].newDate === '2027-01');
let d5 = ctx.processUser_({ user: 't', seen: d4.seen }, {});
check('date: unchanged is silent again', d5.events.length === 0);
console.log(ctx.render_(d4.events[0], (t) => t, (s) => s));
// existing subscribers (state from before this feature, no date key): silent baseline
let legacy = ctx.processUser_({ user: 't', seen: { r500: 'NOT_YET_RELEASED' } }, {});
check('date: legacy state baselines silently', legacy.events.length === 0 && legacy.seen.d500 === '2027-01');


// ---- planning-list release date tracking ----
const planMedia = (d) => ({ id: 60, status: 'NOT_YET_RELEASED', episodes: null, siteUrl: 'https://anilist.co/anime/60', title: { romaji: 'Show P', english: null }, nextAiringEpisode: null, startDate: d });
list = [{ status: 'PLANNING', media: planMedia({ year: null, month: null, day: null }) }];
relations = {};
let p1 = ctx.processUser_({ user: 't', seen: {} }, {});
check('planning: first sighting is silent', p1.events.length === 0 && p1.seen.d60 === 'date TBA');
list[0].media = planMedia({ year: 2027, month: null, day: null });
let p2 = ctx.processUser_({ user: 't', seen: p1.seen }, {});
check('planning: TBA -> 2027 alerts', p2.events.length === 1 && p2.events[0].type === 'date' && p2.events[0].newDate === '2027');
console.log(ctx.render_(p2.events[0], (t) => t, (s) => s));
check('planning: render has no sequel wording', ctx.render_(p2.events[0], (t) => t, (s) => s).indexOf('undefined') < 0);
let p3 = ctx.processUser_({ user: 't', seen: p2.seen }, {});
check('planning: unchanged is silent', p3.events.length === 0);
// sequel was tracked as related entry first, then added to planning: no re-alert, date carries over
list = [{ status: 'COMPLETED', media: media(70, 'Parent', 'FINISHED', 12, null) }];
relations = { 70: [edge('SEQUEL', 71, 'Parent S2', 'NOT_YET_RELEASED', 'TV', { year: 2027, month: null, day: null })] };
let q1 = ctx.processUser_({ user: 't', seen: {} }, {});
list.push({ status: 'PLANNING', media: Object.assign(media(71, 'Parent S2', 'NOT_YET_RELEASED', null, null), { startDate: { year: 2027, month: null, day: null } }) });
let q2 = ctx.processUser_({ user: 't', seen: q1.seen }, {});
check('planning: adding tracked sequel to list does not re-alert', q2.events.length === 0);
list[1].media.startDate = { year: 2027, month: 4, day: null };
let q3 = ctx.processUser_({ user: 't', seen: q2.seen }, {});
check('planning: date change after adding to list alerts', q3.events.length === 1 && q3.events[0].oldDate === '2027' && q3.events[0].newDate === '2027-04');


// ---- long sequel chains (Season 1 -> ... -> movie) ----
list = [{ status: 'COMPLETED', media: media(100, 'Franchise S1', 'FINISHED', 12, null) }];
relations = {
  100: [edge('SEQUEL', 101, 'Franchise S2', 'FINISHED')],
  101: [edge('SEQUEL', 102, 'Franchise S3', 'FINISHED')],
  102: [edge('SEQUEL', 103, 'Franchise S4', 'FINISHED')],
  103: [edge('SEQUEL', 104, 'Franchise S4 Part 2', 'FINISHED'), edge('SIDE_STORY', 110, 'Far side story', 'NOT_YET_RELEASED')],
  104: [edge('SEQUEL', 105, 'Franchise Movie', 'NOT_YET_RELEASED', 'MOVIE', { year: 2028, month: null, day: null })],
  110: [],
};
// make the side story sit deeper than DEPTH via a sequel hop first
relations[102] = relations[102].concat([edge('SIDE_STORY', 111, 'Deep side story', 'NOT_YET_RELEASED')]);
relations[103] = relations[103].concat([edge('SIDE_STORY', 112, 'Deeper side story', 'NOT_YET_RELEASED')]);
let lc = ctx.processUser_({ user: 't', seen: {} }, {});
const lcTitles = lc.events.map((e) => e.title);
check('long chain: movie 5 sequels away is found', lcTitles.indexOf('Franchise Movie') >= 0);
check('long chain: movie says sequel of its direct prequel', lc.events.filter((e) => e.title === 'Franchise Movie')[0].parent === 'Franchise S4 Part 2');
check('long chain: side stories deep in the chain are followed too', lcTitles.indexOf('Deeper side story') >= 0);


// ---- prequel / parent, and chains through dropped entries ----
list = [{ status: 'COMPLETED', media: media(200, 'Main Show', 'FINISHED', 12, null) }];
relations = { 200: [edge('PREQUEL', 201, 'Main Show Prequel Movie', 'NOT_YET_RELEASED', 'MOVIE', { year: 2028, month: null, day: null }), edge('PARENT', 202, 'Parent Series', 'NOT_YET_RELEASED')] };
let pp = ctx.processUser_({ user: 't', seen: {} }, {});
const prq = pp.events.filter((e) => e.title === 'Main Show Prequel Movie')[0];
check('prequel: announced prequel alerts', !!prq && prq.rt === 'PREQUEL');
check('prequel: rendered as "prequel of"', ctx.render_(prq, (t) => t, (x) => x).indexOf('prequel of Main Show') >= 0);
check('parent: announced parent work alerts', pp.events.some((e) => e.title === 'Parent Series' && e.rt === 'PARENT'));

list = [
  { status: 'COMPLETED', media: media(300, 'Season One', 'FINISHED', 12, null) },
  { status: 'DROPPED', media: media(301, 'Season Two (dropped)', 'FINISHED', 12, null) },
];
relations = { 300: [edge('SEQUEL', 301, 'Season Two (dropped)', 'FINISHED')], 301: [edge('SEQUEL', 302, 'Season Three', 'NOT_YET_RELEASED')] };
let dc = ctx.processUser_({ user: 't', seen: {} }, {});
check('dropped entry does not break the chain: season 3 found', dc.events.some((e) => e.title === 'Season Three'));
check('dropped entry itself is never announced', !dc.events.some((e) => e.title === 'Season Two (dropped)'));

list = [{ status: 'COMPLETED', media: media(400, 'Old Show', 'FINISHED', 12, null) }];
relations = { 400: [edge('SEQUEL', 401, 'Old Show S2', 'CANCELLED')] };
let fl = ctx.processUser_({ user: 't', seen: {} }, {});
check('cancelled sequel is silent at first', fl.events.length === 0);
relations = { 400: [edge('SEQUEL', 401, 'Old Show S2', 'NOT_YET_RELEASED', 'TV', { year: 2029, month: null, day: null })] };
fl = ctx.processUser_({ user: 't', seen: fl.seen }, {});
check('cancelled -> upcoming alerts as new', fl.events.length === 1 && fl.events[0].type === 'new');

list = [{ status: 'COMPLETED', media: media(500, 'Show R', 'FINISHED', 12, null) }];
relations = { 500: [edge('SEQUEL', 501, 'Show R S2', 'NOT_YET_RELEASED', 'TV', { year: 2027, month: null, day: null })] };
let sd = ctx.processUser_({ user: 't', seen: {} }, {});
relations = { 500: [edge('SEQUEL', 501, 'Show R S2', 'RELEASING', 'TV', { year: 2027, month: 1, day: 9 })] };
sd = ctx.processUser_({ user: 't', seen: sd.seen }, {});
check('upcoming -> airing gives exactly one alert', sd.events.length === 1 && sd.events[0].type === 'now');

console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
