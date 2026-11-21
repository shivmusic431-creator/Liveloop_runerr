'use strict';
// LiveLoop web API: ek hi serverless function (Vercel Hobby ki 12-function limit se bachne ke liye)
const crypto = require('crypto');
const F = require('../lib/fs'), C = require('../lib/crypto'), A = require('../lib/auth'), G = require('../lib/gh'), Go = require('../lib/google');

const ACTIVE = ['queued', 'starting', 'preparing', 'live', 'stopping'];
const CLIP_ACTIVE = ['queued', 'downloading', 'transcribing', 'planning', 'rendering', 'uploading'];
const MAX_H = 5.5, NAME_RE = /^[A-Za-z0-9._-]{1,120}$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rid = () => crypto.randomBytes(5).toString('hex');
const esc = s => String(s).replace(/[<>&"']/g, '');
const fail = (code, msg) => Object.assign(new Error(msg), { code });

const json = (res, code, o, h = {}) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); for (const k in h) res.setHeader(k, h[k]); res.end(JSON.stringify(o)); };
const bodyOf = req => { const b = req.body; if (!b) return {}; if (typeof b === 'string') { try { return JSON.parse(b); } catch { return {}; } } return b; };
const origin = req => (process.env.APP_URL || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/+$/, '');
const route = req => {
  const u = new URL(req.url, 'http://x'), p = u.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  return (p && p !== 'index' ? p : String((req.query && req.query.p) || u.searchParams.get('p') || '')).replace(/^\/+/, '');
};

// ---------- run state ----------
const isActive = r => !!r && ACTIVE.includes(r.status) && Date.now() - (r.heartbeat || r.queuedAt || 0) < (r.status === 'queued' ? 300e3 : 90e3);
const runView = r => {
  if (!r) return { state: 'idle' };
  const act = isActive(r), lost = ACTIVE.includes(r.status) && !act;
  return { state: act ? r.status : lost ? 'lost' : r.status, msg: r.msg || '', err: r.err || null, speed: r.speed ?? null, fps: r.fps ?? null, reconnects: r.reconnects || 0, ytStatus: r.ytStatus || null, watch: r.watch || null, stopAt: r.stopAt || null, startedAt: r.startedAt || null, queuedAt: r.queuedAt || null, heartbeat: r.heartbeat || null, stopRequested: !!r.stopRequested, runUrl: r.runUrl || null };
};
const view = (c, run) => ({ id: c.id, name: c.name, mode: c.mode || 'api', account: c.account || '', title: c.title || '', description: c.description || '', tags: c.tags || [], privacy: c.privacy || 'unlisted', thumb: c.thumb || '', videos: c.videos || [], encoder: c.encoder || 'copy', quality: c.quality || 'hd', bitrate: c.bitrate || null, fit: c.fit || 'crop', orient: c.orient || 'v', hours: c.hours || 0, complete: c.complete !== false, url: c.url || '', hasKey: !!c.keyEnc, run: runView(run) });

// ---------- actions ----------
async function doStart(id, hours) {
  const c = await F.get('lives/' + id);
  if (!c) throw fail(404, 'Live nahi mila');
  const run = await F.get('runs/' + id);
  if (isActive(run)) throw fail(400, 'Yeh live pehle se chal raha hai');
  if (!(c.videos || []).length) throw fail(400, 'Pehle koi video chuno');
  if (c.mode === 'api') { if (!c.account || !(await F.get('accounts/' + c.account))) throw fail(400, 'YouTube channel connect/select karo'); }
  else if (!/^rtmps?:\/\//.test(c.url || '') || !c.keyEnc) throw fail(400, 'RTMP URL aur Stream Key daalo');
  let h = hours !== undefined && hours !== '' && hours !== null ? +hours : +c.hours || 0;
  if (!(h >= 0)) h = 0;
  if (h > MAX_H) throw fail(400, `Auto-stop ${MAX_H} ghante se zyada nahi ho sakta (GitHub job limit 6 ghante)`);
  await F.patch('lives/' + id, { hours: h });
  await F.set('runs/' + id, { status: 'queued', msg: 'Runner ka intezaar...', queuedAt: Date.now(), heartbeat: Date.now(), hours: h, stopRequested: false, logTail: [] });
  try { await G.dispatch('live.yml', { live_id: id }); }
  catch (e) { await F.patch('runs/' + id, { status: 'error', msg: 'GitHub workflow start nahi hua: ' + e.message }); throw fail(502, 'GitHub: ' + e.message); }
}
async function doStop(id) {
  const run = await F.get('runs/' + id);
  if (!run || !ACTIVE.includes(run.status)) return;
  if (run.status === 'queued') { await F.patch('runs/' + id, { status: 'stopped', msg: 'Start se pehle band kiya', stopRequested: true }); return; }
  await F.patch('runs/' + id, { stopRequested: true, msg: 'Band karne ka signal bheja...' });
}


// ---------- clips ----------
const clipActive = j => !!j && CLIP_ACTIVE.includes(j.status) && Date.now() - (j.heartbeat || j.queuedAt || j.created || 0) < (j.status === 'queued' ? 300e3 : 120e3);
const clipView = j => {
  const act = clipActive(j), lost = CLIP_ACTIVE.includes(j.status) && !act;
  return { id: j.id, url: String(j.url || '').slice(0, 90), account: j.account || '', state: act ? j.status : lost ? 'lost' : j.status, msg: j.msg || '', err: j.err || null, pct: j.pct || 0, plan: j.plan || [], pending: (j.pending || []).length, calls: j.calls || 0, runUrl: j.runUrl || null, created: j.created || 0, queuedAt: j.queuedAt || 0, opts: j.opts || {}, stopRequested: !!j.stopRequested, active: act };
};
const GKEY_RE = /^AIza[0-9A-Za-z_-]{30,60}$/;
function normCookies(t) {
  const out = [];
  for (let l of String(t || '').replace(/\r/g, '').split('\n')) {
    l = l.replace(/\s+$/, ''); if (!l) continue;
    if (l.includes('\t')) { out.push(l); continue; }
    if (/^#\s/.test(l) || l === '#') { out.push(l); continue; }
    const f = l.trim().split(/\s+/);                       // mobile paste me tab space ban jate hain
    if (f.length >= 7 && /^(TRUE|FALSE)$/i.test(f[1])) out.push([...f.slice(0, 6), f.slice(6).join(' ')].join('\t')); else out.push(l);
  }
  return out.join('\n') + '\n';
}
async function clipDispatch(id) {
  try { await G.dispatch('clip.yml', { clip_id: id }); }
  catch (e) { await F.patch('clipjobs/' + id, { status: 'error', msg: 'GitHub workflow start nahi hua: ' + e.message }); throw fail(502, 'GitHub: ' + e.message); }
}

// ---------- handlers ----------
async function login(req, res) {
  const rec = (await F.get('meta/login')) || {}, now = Date.now();
  const fails = (rec.fails || []).filter(t => now - t < 600e3);
  if (fails.length >= 5) return json(res, 429, { error: 'Bahut galat koshish. 10 minute ruko' });
  if (!A.pw(String(bodyOf(req).password || ''))) { fails.push(now); await F.set('meta/login', { fails }); await sleep(600); return json(res, 401, { error: 'Password galat hai' }); }
  if (fails.length) await F.set('meta/login', { fails: [] });
  return json(res, 200, { ok: 1 }, { 'Set-Cookie': `ll_sid=${A.mint()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800` });
}

async function health(req) {
  const out = [], add = (name, ok, msg) => out.push({ name, ok, msg });
  const envs = { ADMIN_PASSWORD: 'Dashboard password', FIREBASE_SERVICE_ACCOUNT: 'Firebase service account', GH_TOKEN: 'GitHub token', RUNNER_REPO: 'Runner repo', VIDEOS_REPO: 'Videos repo', GOOGLE_CLIENT_ID: 'Google Client ID', GOOGLE_CLIENT_SECRET: 'Google Client Secret' };
  for (const k in envs) add(envs[k], !!process.env[k], process.env[k] ? k + ' set hai' : `Vercel env me ${k} daalo`);
  try { await F.set('meta/ping', { t: Date.now() }); add('Firestore', true, 'Padh/likh paa raha hai'); } catch (e) { add('Firestore', false, e.message); }
  try { const n = (await F.list('gkeys')).filter(k => !k.dead).length; add('Gemini keys (Clips)', n > 0, n ? `${n} key chal rahi hai` : 'Clips tab me kam se kam ek Gemini API key jodo'); } catch (e) { add('Gemini keys (Clips)', false, e.message); }
  try { C.dec(C.enc('x')); add('Encryption', true, 'Theek hai'); } catch (e) { add('Encryption', false, e.message); }
  add('RUNNER_REPO (Vercel me jo likha hai)', !!process.env.RUNNER_REPO, process.env.RUNNER_REPO || 'khali');
  add('VIDEOS_REPO (Vercel me jo likha hai)', !!process.env.VIDEOS_REPO, process.env.VIDEOS_REPO || 'khali');
  if (process.env.GH_TOKEN) {
    try { const u = await G.gh('GET', '/user'); add('GitHub token', true, `account: ${u.login}`); }
    catch (e) { add('GitHub token', false, e.status === 401 ? 'token galat ya expire hai - naya banao' : e.message); }
  }
  if (process.env.GH_TOKEN && process.env.RUNNER_REPO) {
    let R = '', repoOk = false;
    try { R = await G.repo('RUNNER_REPO'); const r = await G.gh('GET', `/repos/${R}`); repoOk = true; add('Runner repo', true, `${r.full_name} mil gayi (${r.private ? 'private' : 'public'}, branch ${r.default_branch})`); }
    catch (e) { add('Runner repo', false, e.status === 404 ? `"${R || process.env.RUNNER_REPO}" nahi mili. Token ke Repository access me yeh repo chuni honi chahiye, aur token usi account ka ho jiski repo hai` : e.message); }
    if (repoOk) for (const f of ['live.yml', 'import.yml', 'clip.yml']) {
      try { await G.gh('GET', `/repos/${R}/actions/workflows/${f}`); add('Workflow ' + f, true, 'mil gaya'); }
      catch (e) { add('Workflow ' + f, false, e.status === 404 ? `${f} nahi mila. Repo ke sabse upar .github/workflows/${f} hona chahiye` : e.message); }
    }
    if (process.env.VIDEOS_REPO) { try { const a = await G.assets(); add('Videos repo', true, `Access theek hai (${a.length} file Release me)`); } catch (e) { add('Videos repo', false, e.status === 404 ? 'Videos repo nahi mili. Naam/token access check karo' : e.message); } }
  }
  add('OAuth redirect URI', true, origin(req) + '/api/oauth/callback  (Google Cloud me yahi daalo)');
  return out;
}

const routes = {
  'GET state': async req => {
    const [lives, runs, accts] = await Promise.all([F.list('lives'), F.list('runs'), F.list('accounts')]);
    const rm = Object.fromEntries(runs.map(r => [r.id, r]));
    return { now: Date.now(), lives: lives.sort((a, b) => (a.created || 0) - (b.created || 0)).map(c => view(c, rm[c.id])), accounts: accts.map(a => ({ id: a.id, title: a.title })), redirect: origin(req) + '/api/oauth/callback', googleReady: Go.ready(), actionsUrl: process.env.RUNNER_REPO && process.env.GH_TOKEN ? `https://github.com/${await G.repo('RUNNER_REPO').catch(() => process.env.RUNNER_REPO)}/actions` : '' };
  },
  'POST lives': async req => {
    const b = bodyOf(req); let c = b.id ? await F.get('lives/' + b.id) : null;
    const isNew = !c; if (isNew) c = { id: rid(), created: Date.now() };
    const names = a => [...new Set((Array.isArray(a) ? a : []).map(String).filter(x => NAME_RE.test(x)))];
    const tags = (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',')).map(x => String(x).trim()).filter(Boolean).slice(0, 30);
    const o = { name: String(b.name || 'Live').slice(0, 40), mode: b.mode === 'manual' ? 'manual' : 'api', account: String(b.account || ''), title: String(b.title || '').slice(0, 100), description: String(b.description || '').slice(0, 5000), tags, privacy: ['public', 'unlisted', 'private'].includes(b.privacy) ? b.privacy : 'unlisted', thumb: NAME_RE.test(b.thumb || '') ? b.thumb : '', videos: names(b.videos), encoder: b.encoder === 'sw' ? 'sw' : 'copy', quality: ['low', 'med', 'hd', 'fhd'].includes(b.quality) ? b.quality : 'hd', bitrate: +b.bitrate ? Math.min(9000, Math.max(300, +b.bitrate)) : null, fit: b.fit === 'pad' ? 'pad' : 'crop', orient: b.orient === 'h' ? 'h' : 'v', hours: Math.min(MAX_H, Math.max(0, +b.hours || 0)), complete: b.complete !== false, url: String(b.url || 'rtmp://a.rtmp.youtube.com/live2').trim() };
    if (b.key) o.keyEnc = C.enc(String(b.key).trim());
    if (!isNew && isActive(await F.get('runs/' + c.id))) throw fail(400, 'Chalte hue live ko edit nahi kar sakte. Pehle band karo');
    await F.set('lives/' + c.id, { ...c, ...o, id: undefined, bitrate: o.bitrate });
    return view({ ...c, ...o }, await F.get('runs/' + c.id));
  },
  'DELETE lives': async req => {
    const id = new URL(req.url, 'http://x').searchParams.get('id'); if (!id) throw fail(400, 'id chahiye');
    if (isActive(await F.get('runs/' + id))) throw fail(400, 'Chalte hue live ko delete nahi kar sakte');
    await F.del('lives/' + id); await F.del('runs/' + id).catch(() => { }); return { ok: 1 };
  },
  'POST start': async req => { const b = bodyOf(req); await doStart(b.id, b.hours); return { ok: 1 }; },
  'POST stop': async req => { await doStop(bodyOf(req).id); return { ok: 1 }; },
  'POST reset': async req => {
    const id = bodyOf(req).id, run = await F.get('runs/' + id);
    if (run && run.runId && run.runId !== 'local') await G.cancel(run.runId).catch(() => { });
    await F.set('runs/' + id, { status: 'stopped', msg: 'Zabardasti reset kiya', heartbeat: Date.now(), stopRequested: true, logTail: (run && run.logTail) || [] });
    return { ok: 1 };
  },
  'POST startall': async () => {
    const lives = await F.list('lives'), errors = [];
    await Promise.all(lives.map(c => doStart(c.id).catch(e => { if (!/pehle se chal/.test(e.message)) errors.push(c.name + ': ' + e.message); })));
    return { ok: 1, errors };
  },
  'POST stopall': async () => { const runs = await F.list('runs'); await Promise.all(runs.filter(isActive).map(r => doStop(r.id))); return { ok: 1 }; },
  'GET logs': async req => { const r = await F.get('runs/' + new URL(req.url, 'http://x').searchParams.get('id')); return { lines: (r && r.logTail) || [] }; },

  'GET videos': async () => {
    const [assets, lives] = await Promise.all([G.assets(), F.list('lives')]);
    return assets.sort((a, b) => b.created.localeCompare(a.created)).map(a => ({ ...a, usedBy: lives.filter(l => (l.videos || []).includes(a.name) || l.thumb === a.name).map(l => l.name) }));
  },
  'DELETE videos': async req => {
    const q = new URL(req.url, 'http://x').searchParams, name = q.get('name'), id = q.get('id');
    if (!id || !name) throw fail(400, 'id aur name chahiye');
    const lives = await F.list('lives'), users = lives.filter(l => (l.videos || []).includes(name) || l.thumb === name);
    if (users.length && q.get('force') !== '1') throw fail(409, 'Yeh file in lives me lagi hai: ' + users.map(l => l.name).join(', '));
    for (const l of users) await F.patch('lives/' + l.id, { videos: (l.videos || []).filter(v => v !== name), thumb: l.thumb === name ? '' : l.thumb || '' });
    await G.deleteAsset(id); return { ok: 1 };
  },
  'POST import': async req => {
    const b = bodyOf(req); let u;
    try { u = new URL(String(b.url || '').trim()); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { throw fail(400, 'Sahi http/https link daalo'); }
    const name = String(b.name || '').trim(); if (name && !/^[\w. -]{1,90}$/.test(name)) throw fail(400, 'Naam me sirf akshar, number, . _ - space');
    const id = rid() + rid();
    const doc = { url: u.toString(), host: u.hostname, name, convert: ['auto', 'none', 'force'].includes(b.convert) ? b.convert : 'auto', quality: ['low', 'med', 'hd', 'fhd'].includes(b.quality) ? b.quality : 'hd', fit: b.fit === 'pad' ? 'pad' : 'crop', orient: b.orient === 'h' ? 'h' : 'v', status: 'queued', pct: 0, msg: 'Runner ka intezaar...', created: Date.now() };
    await F.set('imports/' + id, doc);
    F.list('imports').then(l => Promise.all(l.filter(x => Date.now() - (x.created || 0) > 3 * 864e5).map(x => F.del('imports/' + x.id)))).catch(() => { });
    try { await G.dispatch('import.yml', { import_id: id }); }
    catch (e) { await F.patch('imports/' + id, { status: 'error', msg: 'GitHub workflow start nahi hua: ' + e.message, url: '' }); throw fail(502, 'GitHub: ' + e.message); }
    return { ok: 1, id };
  },
  'GET imports': async () => (await F.list('imports')).sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 12).map(x => ({ id: x.id, name: x.asset || x.name || '', host: x.host || '', status: x.status, pct: x.pct || 0, msg: x.msg || '', size: x.size || 0, created: x.created || 0 })),
  'DELETE imports': async req => { await F.del('imports/' + new URL(req.url, 'http://x').searchParams.get('id')); return { ok: 1 }; },

  'GET google/url': async req => ({ url: Go.authUrl(origin(req) + '/api/oauth/callback', A.mintState()) }),
  'DELETE accounts': async req => {
    const id = new URL(req.url, 'http://x').searchParams.get('id'), users = (await F.list('lives')).filter(l => l.account === id);
    if (users.length) throw fail(409, 'Yeh channel in lives me lagaa hai: ' + users.map(l => l.name).join(', '));
    await F.del('accounts/' + id); return { ok: 1 };
  },
  // ---- Clips ----
  'GET clips': async () => {
    const [jobs, keys, vids, ckm] = await Promise.all([F.list('clipjobs'), F.list('gkeys'), F.list('clipvids'), F.get('meta/ytcookies')]);
    const now = Date.now(); jobs.sort((a, b) => (b.created || 0) - (a.created || 0));
    const views = jobs.slice(0, 12).map(clipView);
    return {
      now, active: views.some(v => v.active), jobs: views,
      keys: keys.sort((a, b) => (a.added || 0) - (b.added || 0)).map(k => ({ id: k.id, label: k.label || k.id, hint: k.hint || '', dead: !!k.dead, deadReason: k.deadReason || '', cool: Object.entries(k.cool || {}).filter(([, t]) => t > now).map(([m, t]) => ({ model: m, until: t })), today: k.today && k.today.n || 0, lastErr: k.lastErr || '' })),
      vids: vids.sort((a, b) => Date.parse(b.publishAt || 0) - Date.parse(a.publishAt || 0)).slice(0, 20).map(v => ({ id: v.id, title: v.title || '', publishAt: v.publishAt || '' })),
      cookies: !!(ckm && ckm.enc)
    };
  },
  'POST clipstart': async req => {
    const b = bodyOf(req); let u;
    try { u = new URL(String(b.url || '').trim()); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { throw fail(400, 'Sahi http/https link daalo'); }
    const acct = await F.get('accounts/' + String(b.account || '')); if (!acct) throw fail(400, 'YouTube channel chuno (Channels tab me jodo)');
    if (!(await F.list('gkeys')).some(k => !k.dead)) throw fail(400, 'Pehle kam se kam ek Gemini API key jodo');
    if ((await F.list('clipjobs')).some(clipActive)) throw fail(400, 'Ek clip job pehle se chal raha hai. Khatam hone do ya band karo');
    const tz = String(b.tz || 'Asia/Kolkata').trim(); try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw fail(400, 'Time zone galat hai (jaise Asia/Kolkata)'); }
    const n = (v, lo, hi, d) => { if (v === '' || v === null || v === undefined) return d; v = Math.round(+v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
    let minSec = n(b.minSec, 10, 120, 25), maxSec = n(b.maxSec, 15, 170, 60); if (maxSec < minSec + 5) maxSec = Math.min(170, minSec + 5);
    const sd = String(b.startDate || '').trim();
    const opts = { clips: n(b.clips, 0, 30, 0), minSec, maxSec, perDay: n(b.perDay, 1, 3, 1), tz, orient: b.orient === 'crop' ? 'crop' : 'blur', captions: b.captions !== false && b.captions !== 'false', whisper: b.whisper === 'base' ? 'base' : 'small', budget: n(b.budget, 5, 20, 15), maxVideoMin: n(b.maxVideoMin, 5, 300, 240), lang: /^[a-z]{2}$/.test(b.lang || '') ? b.lang : '', category: '22', ...(/^\d{4}-\d{2}-\d{2}$/.test(sd) ? { startDate: sd } : {}) };
    const id = rid() + rid();
    await F.set('clipjobs/' + id, { url: u.toString(), host: u.hostname, account: String(b.account), opts, status: 'queued', step: 'queued', msg: 'Runner ka intezaar...', pct: 0, created: Date.now(), queuedAt: Date.now(), heartbeat: Date.now(), stopRequested: false, logTail: [], plan: [], pending: [], ck: {} });
    await clipDispatch(id);
    return { ok: 1, id };
  },
  'POST clipstop': async req => {
    const id = bodyOf(req).id, j = await F.get('clipjobs/' + id);
    if (!j || !CLIP_ACTIVE.includes(j.status)) return { ok: 1 };
    if (j.status === 'queued') await F.patch('clipjobs/' + id, { status: 'stopped', msg: 'Start se pehle band kiya', stopRequested: true });
    else await F.patch('clipjobs/' + id, { stopRequested: true, msg: 'Band karne ka signal bheja...' });
    return { ok: 1 };
  },
  'POST clipresume': async req => {
    const id = bodyOf(req).id, j = await F.get('clipjobs/' + id);
    if (!j) throw fail(404, 'Job nahi mila');
    if (clipActive(j)) throw fail(400, 'Yeh job abhi chal raha hai');
    if ((await F.list('clipjobs')).some(x => x.id !== id && clipActive(x))) throw fail(400, 'Ek aur clip job chal raha hai. Pehle usse khatam hone do');
    if (!(await F.list('gkeys')).some(k => !k.dead)) throw fail(400, 'Koi chalti Gemini key nahi hai. Keys ko “dobara chalu” karo ya nayi jodo');
    await F.patch('clipjobs/' + id, { status: 'queued', step: 'queued', msg: 'Runner ka intezaar...', err: null, stopRequested: false, queuedAt: Date.now(), heartbeat: Date.now(), logTail: [] });
    await clipDispatch(id); return { ok: 1 };
  },
  'POST clipreset': async req => {
    const id = bodyOf(req).id, j = await F.get('clipjobs/' + id);
    if (!j) throw fail(404, 'Job nahi mila');
    if (j.runId && j.runId !== 'local') await G.cancel(j.runId).catch(() => { });
    await F.patch('clipjobs/' + id, { status: (j.pending || []).length ? 'partial' : 'stopped', msg: 'Zabardasti reset kiya', stopRequested: true, heartbeat: Date.now(), stage: (j.pending || []).length ? 'upload' : (j.stage || '') });
    return { ok: 1 };
  },
  'GET cliplogs': async req => { const j = await F.get('clipjobs/' + new URL(req.url, 'http://x').searchParams.get('id')); return { lines: (j && j.logTail) || [] }; },
  'DELETE clipjobs': async req => {
    const id = new URL(req.url, 'http://x').searchParams.get('id'); if (!id) throw fail(400, 'id chahiye');
    const j = await F.get('clipjobs/' + id); if (clipActive(j)) throw fail(400, 'Chalte hue job ko delete nahi kar sakte. Pehle band karo');
    try { for (const a of await G.assets(G.clipsTag())) if (a.name.startsWith(id + '_')) await G.deleteAsset(a.id); } catch { }
    await F.del('clipjobs/' + id); return { ok: 1 };
  },
  'POST gkeys': async req => {
    const b = bodyOf(req), keys = [...new Set(String(b.keys || b.key || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean))];
    if (!keys.length) throw fail(400, 'Gemini API key paste karo (AIza... se shuru hoti hai)');
    if (keys.length > 10) throw fail(400, 'Ek baar me 10 se zyada key nahi');
    const have = await F.list('gkeys'); const res = { added: 0, dup: 0, bad: [] };
    for (const k of keys) {
      if (!GKEY_RE.test(k)) { res.bad.push('…' + k.slice(-4) + ' (format galat)'); continue; }
      const id = crypto.createHash('sha256').update(k).digest('hex').slice(0, 10);
      if (have.some(x => x.id === id)) { res.dup++; continue; }
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': k }, signal: AbortSignal.timeout(8000) });
        if ([400, 401, 403].includes(r.status)) { res.bad.push('…' + k.slice(-4) + ' (Google ne reject kiya)'); continue; }
      } catch { /* network dikkat: key rakh lete hain, runner check karega */ }
      await F.set('gkeys/' + id, { label: (keys.length === 1 && String(b.label || '').trim().slice(0, 30)) || `Key ${have.length + res.added + 1}`, keyEnc: C.enc(k), hint: '…' + k.slice(-4), added: Date.now(), dead: false, deadReason: '', cool: {}, today: { day: '', n: 0 } });
      res.added++;
    }
    return res;
  },
  'DELETE gkeys': async req => { await F.del('gkeys/' + new URL(req.url, 'http://x').searchParams.get('id')); return { ok: 1 }; },
  'POST gkeyreset': async req => {
    const id = bodyOf(req).id, list = id ? [await F.get('gkeys/' + id)].filter(Boolean) : await F.list('gkeys');
    for (const k of list) await F.patch('gkeys/' + k.id, { dead: false, deadReason: '', cool: {}, lastErr: '' });
    return { ok: 1, n: list.length };
  },
  'POST ytcookies': async req => {
    const t = String(bodyOf(req).text || '');
    if (t.length > 700000) throw fail(400, 'Cookies file bahut badi hai');
    const n = normCookies(t);
    if (!n.split('\n').some(l => l.split('\t').length >= 7 && /youtube|google/i.test(l))) throw fail(400, 'Yeh Netscape cookies.txt format nahi lag raha (youtube.com ki lines chahiye)');
    await F.set('meta/ytcookies', { enc: C.enc(n), added: Date.now() }); return { ok: 1 };
  },
  'DELETE ytcookies': async () => { await F.del('meta/ytcookies'); return { ok: 1 }; },

  'GET health': req => health(req)
};

module.exports = async (req, res) => {
  const r = route(req), m = req.method;
  try {
    const authed = A.check(A.cookie(req).ll_sid);
    if (r === 'session' && m === 'GET') return json(res, 200, { authed, configured: !!process.env.ADMIN_PASSWORD && !!process.env.FIREBASE_SERVICE_ACCOUNT });
    if (r === 'login' && m === 'POST') { if (req.headers['x-liveloop'] !== '1') return json(res, 403, { error: 'csrf' }); return await login(req, res); }
    if (r === 'logout') return json(res, 200, { ok: 1 }, { 'Set-Cookie': 'll_sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' });
    if (!authed) return r === 'oauth/callback' ? (res.statusCode = 302, res.setHeader('Location', '/'), res.end()) : json(res, 401, { error: 'login karo' });
    if (m !== 'GET' && req.headers['x-liveloop'] !== '1') return json(res, 403, { error: 'csrf' });

    if (r === 'oauth/callback' && m === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams;
      try {
        if (q.get('error')) throw new Error('Google: ' + q.get('error'));
        if (!A.checkState(q.get('state') || '')) throw new Error('state galat ya purana - dobara Connect dabao');
        const c = await Go.exchange(q.get('code'), origin(req) + '/api/oauth/callback');
        await F.set('accounts/' + c.id, { title: c.title, refreshEnc: C.enc(c.refresh), added: Date.now() });
        res.statusCode = 302; res.setHeader('Location', '/?ok=' + encodeURIComponent('Channel connect ho gaya: ' + c.title)); return res.end();
      } catch (e) { res.statusCode = 302; res.setHeader('Location', '/?err=' + encodeURIComponent(esc(e.message))); return res.end(); }
    }
    const h = routes[`${m} ${r}`];
    if (!h) return json(res, 404, { error: 'nahi mila' });
    return json(res, 200, await h(req));
  } catch (e) { return json(res, e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: String(e.message || e) }); }
};
