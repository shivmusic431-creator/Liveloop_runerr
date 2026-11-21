'use strict';
// LiveLoop Clips runner (GitHub Actions):
// video download -> transcript -> Gemini planning (kai calls) -> clips render (captions ke saath)
// -> YouTube par sab schedule (private + publishAt) -> cleanup
const fs = require('fs'), path = require('path'), os = require('os');
const F = require('./lib/fs'), C = require('./lib/crypto'), U = require('./lib/util'), mkYT = require('./lib/yt');
const mkGem = require('./lib/gemini'), T = require('./lib/transcript'), P = require('./lib/plan'), R = require('./lib/render'), K = require('./lib/caps');

const ID = process.env.CLIP_ID, RUNID = process.env.GITHUB_RUN_ID || 'local';
const TAG = process.env.CLIPS_TAG || 'clips';
const RUN_URL = process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${RUNID}` : null;
if (!ID) { console.error('CLIP_ID nahi mila'); process.exit(2); }
const WORK = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'clip-' + ID);
fs.mkdirSync(WORK, { recursive: true });
let REPO = process.env.VIDEOS_REPO;
const GH = { GH_TOKEN: process.env.VIDEOS_TOKEN };

// ---------- logging (secrets aur link chhupana; public repo ke logs me kuch sensitive nahi) ----------
const secrets = new Set(), tail = [];
let JOB = null;
function addSecret(s) { s = String(s || ''); if (s.length < 4 || /[\r\n]/.test(s) || secrets.has(s)) return; secrets.add(s); console.log('::add-mask::' + s); }
const redact = s => { s = String(s); if (JOB && JOB.url) s = s.split(JOB.url).join('<link>'); for (const x of secrets) s = s.split(x).join('***'); return s.replace(/ya29\.[\w.-]+/g, '***').replace(/AIza[\w-]{20,}/g, '***'); };
function log(l, m) { const line = `${new Date().toISOString().slice(11, 19)} [${l}] ${redact(m)}`; console.log(line); tail.push(line); if (tail.length > 300) tail.shift(); }

// ---------- state ----------
const S = { status: 'queued', step: '', msg: '', pct: 0, err: null, want: true, plan: [], pending: [], calls: 0, stage: '' };
let lastFlush = 0, flushing = false, ckCache = {}, finishing = false;
const planView = () => S.plan.map(c => ({ id: c.id, start: c.start, end: c.end, title: c.title || '', publishAt: c.publishAt || '', state: c.state || 'queued', vid: c.vid || '', err: c.err || '' }));
async function flush(force) {
  if (!force && Date.now() - lastFlush < 8000) return;
  while (flushing) await U.sleep(50);
  flushing = true; lastFlush = Date.now();
  try { await F.patch('clipjobs/' + ID, { status: S.status, step: S.step, msg: S.msg, pct: Math.round(S.pct), err: S.err, plan: planView(), pending: S.pending, stage: S.stage, calls: S.calls, runId: RUNID, runUrl: RUN_URL, heartbeat: Date.now(), logTail: tail.slice(-120) }); }
  catch (e) { console.log('Firestore flush fail: ' + redact(e.message)); }
  finally { flushing = false; }
}
const setStatus = (status, msg, pct) => { S.status = status; S.step = status; S.msg = msg || ''; if (pct !== undefined) S.pct = pct; return flush(true); };
const say = m => { S.msg = m; flush(false); };
const prog = (lo, hi, label) => p => { S.pct = lo + (hi - lo) * p / 100; if (label) S.msg = `${label}: ${Math.round(p)}%`; flush(false); };
class Stop extends Error { }
const chk = () => { if (!S.want) throw new Stop('rok diya'); };

// ---------- Gemini keys (Firestore se) ----------
const gstore = {
  keys: async () => {
    const out = [];
    for (const d of await F.list('gkeys')) {
      try { const key = C.dec(d.keyEnc); addSecret(key); out.push({ id: d.id, label: d.label || d.id, key, dead: !!d.dead, deadReason: d.deadReason || '', cool: d.cool || {}, today: d.today || null }); }
      catch { log('WARNING', `Key ${d.label || d.id} decrypt nahi hui, skip`); }
    }
    return out;
  },
  patch: (id, o) => F.patch('gkeys/' + id, o)
};

// ---------- checkpoints (Gemini ke results Firestore me, taaki retry par calls dobara na lagen) ----------
const ck = {
  get: async n => ckCache[n] === undefined ? undefined : JSON.parse(ckCache[n]),
  set: async (n, v) => { ckCache[n] = JSON.stringify(v); await F.patch('clipjobs/' + ID, { ck: ckCache }); }
};

// ---------- release (bache hue clips) ----------
async function ensureRelease() {
  try { await U.sh('gh', ['release', 'view', TAG, '--repo', REPO], { env: GH }); }
  catch { await U.sh('gh', ['release', 'create', TAG, '--repo', REPO, '--title', 'clips (temporary)', '--notes', 'Upload se bache hue clips. Upload hote hi apne aap hat jate hain.'], { env: GH }); }
}
async function stash(c, file) {
  await ensureRelease();
  const name = `${ID}_${c.id}.mp4`, dest = path.join(WORK, name); fs.renameSync(file, dest);
  await U.sh('gh', ['release', 'upload', TAG, dest, '--repo', REPO, '--clobber'], { env: GH, timeout: 1800e3 });
  S.pending.push({ id: c.id, asset: name, title: c.title, description: c.description, tags: c.tags || [], publishAt: c.publishAt });
  c.state = 'stashed'; try { fs.unlinkSync(dest); } catch { }
}

// ---------- upload ----------
let yt = null, blocked = false;
async function uploadOne(c, file) {
  const vid = await yt.upload(file, { title: c.title, description: c.description, tags: c.tags, publishAt: c.publishAt, category: JOB.opts.category });
  await F.set('clipvids/' + vid, { jobId: ID, account: JOB.account, title: c.title, publishAt: c.publishAt, videoId: vid, created: Date.now() });
  c.state = 'uploaded'; c.vid = vid; c.err = '';
  try { fs.unlinkSync(file); } catch { }
  log('INFO', `${c.id}: schedule ho gaya (${c.publishAt})`);
  await flush(true);
}

async function history() {
  try {
    const list = (await F.list('clipvids')).filter(v => v.account === JOB.account && Date.parse(v.publishAt) > Date.now());
    return { last: list.map(v => v.publishAt).sort().pop() || null };
  } catch { return { last: null }; }
}

async function uploadPending() {
  const items = S.pending.slice();
  if (!items.length) return;
  await setStatus('uploading', 'Bache hue clips upload ho rahe hain', 60);
  const h = await history(); let last = h.last;
  for (const it of items) {
    chk();
    const c = S.plan.find(x => x.id === it.id) || { id: it.id, title: it.title };
    try {
      const f = path.join(WORK, it.asset);
      await U.sh('gh', ['release', 'download', TAG, '--repo', REPO, '--pattern', it.asset, '--dir', WORK, '--clobber'], { env: GH, timeout: 1800e3 });
      if (!fs.existsSync(f)) throw new Error('Release me clip nahi mila (shayad pehle hi hata diya)');
      let pub = it.publishAt;
      if (Date.parse(pub) < Date.now() + 20 * 60e3) { pub = P.assign({ n: 1, times: [], tz: JOB.opts.tz, perDay: 1, last, now: Date.now() })[0]; log('INFO', `${it.id}: purana time nikal gaya, naya slot ${pub}`); }
      Object.assign(c, { title: it.title, description: it.description, tags: it.tags, publishAt: pub });
      await uploadOne(c, f);
      last = pub;
      await U.sh('gh', ['release', 'delete-asset', TAG, it.asset, '--repo', REPO, '-y'], { env: GH }).catch(e => log('WARNING', 'asset hataya nahi: ' + e.message));
      S.pending = S.pending.filter(x => x.id !== it.id); await flush(true);
    } catch (e) {
      if (e instanceof Stop) throw e;
      S.err = e.message; c.state = 'stashed'; c.err = e.message.slice(0, 120);
      log('ERROR', `${it.id}: upload fail: ${e.message}`);
      if (e.fatal) break;
    }
  }
}

// ---------- pipeline ----------
async function pipeline() {
  const O = JOB.opts;
  await setStatus('downloading', 'Video download ho raha hai', 2);
  let cookies = null;
  try {
    const m = await F.get('meta/ytcookies');
    if (m && m.enc) { cookies = path.join(WORK, 'cookies.txt'); fs.writeFileSync(cookies, C.dec(m.enc), { mode: 0o600 }); }
  } catch (e) { log('WARNING', 'cookies padhne me dikkat: ' + e.message); }

  let src, inf = null, subFile = null, sub = null;
  if (T.isYT(JOB.url)) {
    inf = await T.info(JOB.url, cookies); chk();
    if (inf.duration > O.maxVideoMin * 60) throw new Error(`Video ${Math.round(inf.duration / 60)} min ka hai, limit ${O.maxVideoMin} min. Clips tab me limit badha sakte ho`);
    sub = T.pickSub(inf, O.lang);
    log('INFO', `Video ${Math.round(inf.duration / 60)} min, captions: ${sub ? sub.kind : 'nahi (Whisper chalega)'}`);
    const d = await T.downloadYT(JOB.url, WORK, { cookies, sub, onPct: prog(2, 16, 'Download') });
    src = d.file; subFile = d.subFile;
  } else {
    const d = await T.downloadDirect(JOB.url, WORK, prog(2, 16, 'Download')); src = d.file;
  }
  chk();
  const pr = await U.probe(src); if (!pr || !pr.dur) throw new Error('Download hui file video nahi lag rahi');
  const dur = (inf && inf.duration) || pr.dur;
  log('INFO', `Video file: ${(fs.statSync(src).size / 1e6).toFixed(0)} MB, ${pr.w}x${pr.h}`);

  // transcript
  await setStatus('transcribing', 'Transcript ban raha hai', 17);
  let words = [], source = 'whisper', lang = (inf && inf.language) || O.lang || '';
  if (subFile) { try { words = T.parseJson3(fs.readFileSync(subFile, 'utf8')); source = sub.kind; lang = lang || sub.lang.split('-')[0]; } catch (e) { log('WARNING', 'caption file padhne me dikkat: ' + e.message); } }
  if (words.length < 30) {
    log('INFO', 'YouTube captions nahi mile, Whisper se transcript bana rahe hain');
    const w = await T.whisper(src, WORK, { model: O.whisper, lang: O.lang || 'auto', dur, onPct: prog(17, 32, 'Whisper') });
    words = w.words; source = 'whisper'; lang = w.lang || lang;
  }
  if (words.length < 30) throw new Error('Transcript khali hai (video me bolna nahi hai ya awaaz saaf nahi)');
  log('INFO', `Transcript: ${words.length} words (${source}), language ${lang || '?'}`);
  chk();

  // Gemini plan
  await setStatus('planning', 'Gemini clips plan kar raha hai', 33);
  const gem = mkGem({ store: gstore, log, maxCalls: O.budget });
  const hist = await history();
  let plan;
  try { plan = await P.build({ words, dur, title: inf ? inf.title : '', lang, source, O, gem, ck, log, say: m => { S.msg = m; S.pct = Math.min(46, S.pct + 1.5); flush(false); }, history: hist }); }
  finally { S.calls = gem.stats().calls; }
  chk();
  // pichhli koshish ke states (jo clips ho chuke unhe dobara nahi)
  const prev = Object.fromEntries((JOB.plan || []).map(c => [c.id, c]));
  S.plan = plan.clips.map(c => { const p = prev[c.id]; return p && p.start === c.start && p.end === c.end && ['uploaded', 'stashed'].includes(p.state) ? { ...c, state: p.state, vid: p.vid, publishAt: p.publishAt || c.publishAt } : { ...c, state: 'queued' }; });
  log('INFO', `${S.plan.length} clips ka plan taiyar, Gemini calls: ${S.calls}`);
  await flush(true);

  // render + upload
  const todo = S.plan.filter(c => c.state === 'queued');
  for (let i = 0; i < todo.length; i++) {
    chk();
    const c = todo[i], out = path.join(WORK, `clip_${c.id}.mp4`);
    await setStatus('rendering', `Clip ${i + 1}/${todo.length} ban raha hai`, 47 + 50 * i / todo.length);
    c.state = 'rendering';
    const base = K.buildPhrases(words, c.start, c.end);
    const phrases = O.captions ? K.applyFix(base, c.fix) : [];
    await R.renderClip({ src, out, start: c.start, dur: c.end - c.start, phrases, mode: O.orient, work: WORK, hasAudio: !!pr.audio });
    log('INFO', `${c.id}: render ho gaya (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
    if (!blocked) {
      await setStatus('uploading', `Clip ${i + 1}/${todo.length} YouTube par schedule ho raha hai`, 47 + 50 * (i + 0.6) / todo.length);
      try { await uploadOne(c, out); continue; }
      catch (e) { blocked = true; c.err = e.message.slice(0, 120); S.err = e.message; log('ERROR', `Upload ruk gaya: ${e.message}. Baaki clips Release me rakhe jayenge`); }
    }
    try { await stash(c, out); await flush(true); } catch (e) { c.state = 'failed'; c.err = 'stash fail: ' + e.message.slice(0, 100); log('ERROR', c.err); try { fs.unlinkSync(out); } catch { } }
  }
}

// ---------- end ----------
async function finish(kind, code) {
  if (finishing) return; finishing = true;
  const up = S.plan.filter(c => c.state === 'uploaded').length, pend = S.pending.length, failed = S.plan.filter(c => c.state === 'failed' || c.state === 'queued' || c.state === 'rendering').length;
  let status, msg;
  if (kind === 'stop') { status = 'stopped'; msg = `Band kiya. ${up} clip schedule ho chuke`; }
  else if (kind === 'error') { status = 'error'; msg = S.err || 'Error'; }
  else if (pend || failed) { status = 'partial'; msg = `${up} clip schedule hue, ${pend + failed} baaki. “Bache upload karo” dabao${S.err ? '. ' + S.err.slice(0, 140) : ''}`; if (!pend && failed) S.stage = ''; }
  else { status = 'done'; msg = `${up} clips YouTube par schedule ho gaye`; }
  S.status = status; S.step = status; S.msg = msg; S.pct = status === 'done' ? 100 : S.pct;
  if (pend) S.stage = 'upload';
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { }
  log('INFO', msg);
  try {
    await flush(true);
    if (status === 'done') await F.patch('clipjobs/' + ID, { ck: {}, pending: [], stage: '' });
  } catch { }
  process.exit(code ?? (status === 'error' ? 1 : 0));
}

// ---------- main ----------
(async () => {
  JOB = await F.get('clipjobs/' + ID);
  if (!JOB) { console.log('Job nahi mila'); process.exit(0); }
  if (JOB.status !== 'queued') { console.log('Job queued nahi hai (' + JOB.status + '), kuch nahi karna'); process.exit(0); }
  addSecret(process.env.GOOGLE_CLIENT_SECRET); addSecret(process.env.VIDEOS_TOKEN);
  JOB.opts = Object.assign({ clips: 0, minSec: 25, maxSec: 60, perDay: 1, tz: 'Asia/Kolkata', orient: 'blur', captions: true, whisper: 'small', budget: 15, maxVideoMin: 240, lang: '', category: '22' }, JOB.opts || {});
  ckCache = { ...(JOB.ck || {}) }; S.pending = JOB.pending || []; S.stage = JOB.stage || ''; S.plan = JOB.plan || []; S.calls = JOB.calls || 0;
  REPO = await U.repoName(REPO, process.env.VIDEOS_TOKEN);
  await setStatus('downloading', 'Runner chalu hua', 1);
  setInterval(async () => {
    flush(false);
    try { const j = await F.get('clipjobs/' + ID); if (j && j.stopRequested && S.want) { S.want = false; log('INFO', 'Stop ka signal mila'); try { R.renderClip.proc && R.renderClip.proc.kill('SIGKILL'); T.run.last && T.run.last.kill('SIGKILL'); } catch { } } } catch { }
  }, 9000).unref();
  process.on('SIGTERM', () => { S.want = false; S.err = 'Runner cancel hua'; finish('error', 1); });

  const acct = await F.get('accounts/' + JOB.account);
  if (!acct) throw new Error('YouTube channel nahi mila. Channels tab me dobara jodo');
  yt = mkYT({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, refresh: C.dec(acct.refreshEnc), log });

  if (S.pending.length) await uploadPending();
  if (S.plan.length === 0 || S.plan.some(c => ['queued', 'rendering', 'failed'].includes(c.state))) {
    if (!(S.pending.length && blockedAfterPending())) await pipeline();
  }
  await finish('ok');
})().catch(async e => {
  if (e instanceof Stop || !S.want) return finish('stop', 0);
  S.err = T.friendly(e.message) || String(e.message);
  log('ERROR', S.err);
  if (e.quota) S.err = e.message;
  finish('error', 1);
});

// pending upload me fatal error aaya (quota) to naye clips banana bekaar hai
function blockedAfterPending() { return S.pending.length > 0 && !!S.err; }
