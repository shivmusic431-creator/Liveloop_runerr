'use strict';
// LiveLoop runner: GitHub Actions par chalta hai. Video download -> YouTube broadcast -> FFmpeg loop -> graceful stop.
const fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');
const F = require('./lib/fs'), C = require('./lib/crypto'), U = require('./lib/util'), mkYT = require('./lib/yt');

const ID = process.env.LIVE_ID, RUNID = process.env.GITHUB_RUN_ID || 'local';
let REPO = process.env.VIDEOS_REPO;
const TAG = process.env.VIDEOS_TAG || 'videos';
const MAX_H = 5.5; // GitHub job limit 6h hai
const RUN_URL = process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${RUNID}` : null;
if (!ID) { console.error('LIVE_ID nahi mila'); process.exit(2); }
const WORK = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'll-' + ID);
fs.mkdirSync(WORK, { recursive: true });

// ---------- logging (secrets chhupana) ----------
const secrets = new Set(), tail = [];
function addSecret(s) { s = String(s || ''); if (s.length < 4 || /[\r\n]/.test(s) || secrets.has(s)) return; secrets.add(s); console.log('::add-mask::' + s); }
const redact = s => { for (const x of secrets) s = s.split(x).join('***'); return s.replace(/ya29\.[\w.-]+/g, '***'); };
function log(l, m) {
  const line = `${new Date().toISOString().slice(11, 19)} [${l}] ${redact(String(m))}`;
  console.log(line); tail.push(line); if (tail.length > 300) tail.shift();
}

// ---------- state + Firestore flush ----------
const S = { status: 'starting', msg: '', want: true, proc: null, speed: null, fps: null, reconnects: 0, retries: 0, err: null, ytStatus: null, bid: null, sid: null, watch: null, startAt: Date.now(), stopAt: null, last: Date.now(), liveAt: 0, rt: null, warnAt: 0 };
let live = null, yt = null, lastFlush = 0, flushing = false, finishing = null, lastRead = 0;

async function flush(force) {
  if (!force && Date.now() - lastFlush < 8000) return;
  while (flushing) await U.sleep(50);
  flushing = true; lastFlush = Date.now();
  try {
    await F.patch('runs/' + ID, { status: S.status, msg: S.msg, speed: S.speed, fps: S.fps, reconnects: S.reconnects, err: S.err, ytStatus: S.ytStatus, bid: S.bid, watch: S.watch, stopAt: S.stopAt, startedAt: S.startAt, runId: RUNID, runUrl: RUN_URL, heartbeat: Date.now(), logTail: tail.slice(-120) });
  } catch (e) { console.log('Firestore flush fail: ' + redact(e.message)); }
  finally { flushing = false; }
}
const setStatus = (status, msg) => { S.status = status; S.msg = msg || ''; return flush(true); };

// ---------- video download ----------
async function download(names, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    await setStatus('starting', `Video download ho raha hai (${i + 1}/${names.length}): ${n}`);
    const t0 = Date.now();
    await U.sh('gh', ['release', 'download', TAG, '--repo', REPO, '--pattern', n, '--dir', dir, '--clobber'], { env: { GH_TOKEN: process.env.VIDEOS_TOKEN } });
    const f = path.join(dir, n);
    if (!fs.existsSync(f)) throw new Error('Video release me nahi mila: ' + n);
    log('INFO', `${n}: ${(fs.statSync(f).size / 1e6).toFixed(0)} MB, ${((Date.now() - t0) / 1000).toFixed(0)}s me download`);
    out.push(f);
  }
  return out;
}

// ---------- ffmpeg ----------
function ffArgs(files, enc, url, key) {
  const [w, h, d] = U.dims(live.quality, live.orient), br = +live.bitrate || d;
  let inp;
  if (files.length > 1) {
    const lf = path.join(WORK, 'list.txt');
    fs.writeFileSync(lf, files.map(v => `file '${v.replace(/'/g, "'\\''")}'`).join('\n'));
    inp = ['-re', '-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', lf];
  } else inp = ['-re', '-stream_loop', '-1', '-i', files[0]];
  const out = url.replace(/\/+$/, '') + '/' + key, pre = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1'];
  if (enc === 'copy') return [...pre, ...inp, '-c', 'copy', '-f', 'flv', out];
  return [...pre, ...inp, '-vf', U.vfilter(w, h, live.fit), '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', br + 'k', '-maxrate', br + 'k', '-bufsize', 2 * br + 'k', '-sc_threshold', '0', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-f', 'flv', out];
}

function runFF(files, enc, url, key) {
  if (!S.want) return;
  let p;
  try { p = spawn('ffmpeg', ffArgs(files, enc, url, key), { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { S.err = String(e.message); log('ERROR', e.message); return finish('error', 1); }
  S.proc = p; S.last = Date.now();
  log('INFO', `FFmpeg start (${enc}${enc === 'sw' ? ', ' + live.quality : ''}, ${files.length} video)`);
  p.on('error', e => { S.err = 'ffmpeg nahi chala: ' + e.message; log('ERROR', S.err); S.proc = null; finish('error', 1); });
  p.stdout.on('data', d => {
    S.last = Date.now();
    for (const l of String(d).split('\n')) {
      if (l.startsWith('speed=')) {
        const v = parseFloat(l.slice(6));
        if (!isNaN(v)) {
          S.speed = v;
          if (S.status !== 'live' && S.want) { S.status = 'live'; S.msg = ''; S.liveAt = Date.now(); S.err = null; flush(true); }
          if (v < 0.95 && Date.now() - S.warnAt > 60000) { S.warnAt = Date.now(); log('WARNING', `encoding speed ${v}x (<1.0x) - Copy mode ya kam quality lo`); }
        }
      } else if (l.startsWith('fps=')) S.fps = parseFloat(l.slice(4));
      if (S.liveAt && Date.now() - S.liveAt > 60000) S.retries = 0;
    }
  });
  p.stderr.on('data', d => String(d).split('\n').filter(Boolean).slice(-3).forEach(l => { S.err = redact(l).slice(0, 160); log('FFMPEG', l); }));
  p.on('exit', code => {
    S.proc = null; S.speed = null; S.fps = null; S.liveAt = 0;
    if (!S.want) return;
    S.retries++; S.reconnects++;
    const d = Math.min(60, 5 * 2 ** Math.min(S.retries - 1, 4));
    S.status = 'starting'; S.msg = `FFmpeg band (code ${code}), ${d}s baad dobara`; flush(true);
    log('WARNING', S.msg);
    S.rt = setTimeout(() => runFF(files, enc, url, key), d * 1000);
  });
}

// ---------- band karna (graceful) ----------
function finish(reason, code = 0) {
  if (finishing) return finishing;
  finishing = (async () => {
    S.want = false; clearTimeout(S.rt); S.status = 'stopping'; S.msg = 'Band ho raha hai...';
    log('INFO', 'STOP (' + reason + ')'); await flush(true);
    const p = S.proc;
    if (p) await new Promise(ok => { p.once('exit', ok); try { p.kill('SIGINT'); } catch { ok(); } setTimeout(() => { try { p.kill('SIGKILL'); } catch { } ok(); }, 8000); });
    if (yt && S.bid && live && live.complete !== false) {
      try { await yt.complete(S.bid); log('INFO', 'YouTube broadcast complete ho gaya'); } catch (e) { log('WARNING', 'broadcast complete fail: ' + e.message); }
    }
    try {
      await F.add('history', { liveId: ID, name: live ? live.name : ID, mode: live ? live.mode : '', start: new Date(S.startAt).toISOString(), end: new Date().toISOString(), minutes: Math.round((Date.now() - S.startAt) / 60000), reconnects: S.reconnects, reason, watch: S.watch, runUrl: RUN_URL });
    } catch { }
    S.status = reason === 'error' ? 'error' : 'stopped'; S.msg = ({ manual: 'Aapne band kiya', 'auto-stop': 'Auto-stop pura hua', cancelled: 'Runner cancel hua', error: 'Error se band hua' })[reason] || reason;
    await flush(true); process.exit(code);
  })();
  return finishing;
}
process.on('SIGTERM', () => finish('cancelled')); process.on('SIGINT', () => finish('cancelled'));

// ---------- control loop: hang detect, auto-stop, stop flag, heartbeat ----------
async function tick() {
  if (finishing) return;
  if (S.proc && Date.now() - S.last > 45000) { log('WARNING', 'FFmpeg hang - kill'); try { S.proc.kill('SIGKILL'); } catch { } }
  if (S.stopAt && Date.now() >= S.stopAt) return finish('auto-stop');
  if (Date.now() - lastRead > 8000) {
    lastRead = Date.now();
    try { const r = await F.get('runs/' + ID); if (!r || r.stopRequested || r.status === 'stopped') return finish('manual'); } catch (e) { log('WARNING', 'stop flag padh nahi paaye: ' + e.message); }
  }
  flush(false);
}

// ---------- main ----------
(async () => {
  const run = await F.get('runs/' + ID);
  if (!run || run.status !== 'queued') { console.log('Run queued nahi hai (' + (run ? run.status : 'missing') + ') - kuch nahi karna'); process.exit(0); }
  if (run.stopRequested) { await F.patch('runs/' + ID, { status: 'stopped', msg: 'Start se pehle hi band kiya' }); process.exit(0); }
  setInterval(() => tick().catch(e => console.log('tick: ' + e.message)), 5000);
  await setStatus('starting', 'Runner chalu hua, config pad raha hai');

  live = await F.get('lives/' + ID);
  if (!live) throw new Error('Live config nahi mila (shayad delete ho gaya)');
  const names = [...new Set(live.videos || [])];
  if (!names.length) throw new Error('Koi video select nahi hai');
  if (!REPO || !process.env.VIDEOS_TOKEN) throw new Error('VIDEOS_REPO / VIDEOS_TOKEN secret set nahi hai');
  REPO = await U.repoName(REPO, process.env.VIDEOS_TOKEN);
  const hours = Math.min(MAX_H, +run.hours > 0 ? +run.hours : MAX_H);

  // secrets decrypt + mask
  let streamUrl, streamKey, refresh = '';
  addSecret(process.env.GOOGLE_CLIENT_SECRET); addSecret(process.env.VIDEOS_TOKEN);
  if (live.mode === 'api') {
    const a = await F.get('accounts/' + live.account);
    if (!a) throw new Error('YouTube channel connect nahi hai (Channels tab me connect karo)');
    refresh = C.dec(a.refreshEnc); addSecret(refresh);
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET secret set nahi hai');
    yt = mkYT({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, refresh, log });
  } else {
    streamUrl = live.url; streamKey = C.dec(live.keyEnc); addSecret(streamKey);
    if (!/^rtmps?:\/\//.test(streamUrl || '') || !streamKey) throw new Error('Manual mode ke liye RTMP URL aur Stream Key chahiye');
  }

  const files = await download(names, path.join(WORK, 'videos'));
  let thumb = null;
  if (live.mode === 'api' && live.thumb) { try { [thumb] = await download([live.thumb], path.join(WORK, 'thumb')); } catch (e) { log('WARNING', 'thumbnail download fail: ' + e.message); } }

  // copy mode ke liye check; layak nahi to software encode
  let enc = live.encoder === 'sw' ? 'sw' : 'copy';
  if (enc === 'copy') {
    for (const f of files) {
      const p = await U.probe(f);
      if (!p || p.codec !== 'h264' || !p.audio || !/^(aac|mp3)$/.test(p.audio)) { enc = 'sw'; log('WARNING', `${path.basename(f)} copy ke layak nahi (${p ? p.codec + '/' + (p.audio || 'audio nahi') : 'padh nahi paaye'}) - Software encode par ja rahe hain`); break; }
    }
  }

  if (live.mode === 'api') {
    await setStatus('preparing', 'YouTube broadcast ban raha hai');
    try { await yt.prepare(live, S, thumb); } catch (e) { throw new Error('YouTube API: ' + e.message); }
    streamUrl = S.ytUrl; streamKey = S.ytKey; addSecret(streamKey);
    S.watch = 'https://youtube.com/watch?v=' + S.bid;
    log('INFO', 'Broadcast ready: ' + S.watch);
  }
  if (!S.want) return;

  S.startAt = Date.now(); S.stopAt = Date.now() + hours * 3600e3;
  log('INFO', `START: ${live.name} (${live.mode}, ${enc}) auto-stop ${hours} ghante`);
  await setStatus('starting', 'FFmpeg shuru ho raha hai');
  runFF(files, enc, streamUrl, streamKey);
  if (live.mode === 'api') yt.goLive(S, () => S.want).catch(e => log('WARNING', 'goLive: ' + e.message));
})().catch(e => { S.err = redact(String(e.message || e)); log('ERROR', S.err); finish('error', 1); });
