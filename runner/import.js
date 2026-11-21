'use strict';
// Link se video/thumbnail utha kar (zarurat ho to H.264 me convert karke) private repo ke Release me daalta hai.
const fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');
const { Readable, Transform } = require('stream'), { pipeline } = require('stream/promises');
const F = require('./lib/fs'), U = require('./lib/util');

let REPO = process.env.VIDEOS_REPO;
const ID = process.env.IMPORT_ID, TAG = process.env.VIDEOS_TAG || 'videos';
const GH = { GH_TOKEN: process.env.VIDEOS_TOKEN };
const LIMIT = 2 * 1024 ** 3 - 1024 * 1024;      // GitHub asset limit 2 GiB
const MAXDL = 6 * 1024 ** 3;                    // itni badi file download nahi karenge
const WORK = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'imp-' + ID);
fs.mkdirSync(WORK, { recursive: true });
if (!ID) { console.error('IMPORT_ID nahi mila'); process.exit(2); }

let url = '';
const redact = s => (url ? String(s).split(url).join('<link>') : String(s));
let lastP = 0;
async function prog(o, force) { if (!force && Date.now() - lastP < 4000) return; lastP = Date.now(); try { await F.patch('imports/' + ID, o); } catch (e) { console.log('progress write fail: ' + e.message); } }
const fail = async m => { console.log('ERROR: ' + redact(m)); await prog({ status: 'error', msg: redact(m).slice(0, 300), url: '' }, true); process.exit(1); };

const clean = s => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 90) || 'video';

async function fetchFile(u, dest) {
  const hdr = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: '*/*' };
  for (let hop = 0; hop < 2; hop++) {
    const r = await fetch(u, { redirect: 'follow', headers: hdr });
    if (!r.ok) throw new Error(`Link se ${r.status} aaya. Link direct download wala aur public hona chahiye`);
    const ct = r.headers.get('content-type') || '';
    if (/text\/html/i.test(ct)) {
      const html = await r.text();
      const m = /mediafire\.com/i.test(u) && (html.match(/https?:\/\/download[0-9a-z-]*\.mediafire\.com\/[^"'\s<>]+/i) || [])[0];
      if (m && hop === 0) { u = m.replace(/&amp;/g, '&'); console.log('MediaFire page se direct link nikala'); continue; }
      throw new Error('Yeh direct download link nahi hai (web page khul raha hai). Dropbox me ?dl=1 lagao, ya seedha .mp4 link do');
    }
    const len = +r.headers.get('content-length') || 0;
    if (len > MAXDL) throw new Error('File bahut badi hai (' + (len / 1e9).toFixed(1) + ' GB)');
    let got = 0;
    const cnt = new Transform({ transform(c, e, cb) { got += c.length; if (got > MAXDL) return cb(new Error('File bahut badi hai')); if (len) prog({ status: 'downloading', pct: Math.min(40, Math.round(got / len * 40)), msg: `Download: ${(got / 1e6).toFixed(0)} / ${(len / 1e6).toFixed(0)} MB` }); else prog({ status: 'downloading', msg: `Download: ${(got / 1e6).toFixed(0)} MB` }); cb(null, c); } });
    await pipeline(Readable.fromWeb(r.body), cnt, fs.createWriteStream(dest));
    return { ct, len: got, finalUrl: r.url };
  }
}

function convert(src, out, pr, o) {
  return new Promise((ok, no) => {
    const [w, h, d] = U.dims(o.quality, o.orient), br = d;
    const ain = pr.audio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'];
    const amap = pr.audio ? ['-map', '0:v:0', '-map', '0:a:0'] : ['-map', '0:v:0', '-map', '1:a:0', '-shortest'];
    const a = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-i', src, ...ain, '-vf', U.vfilter(w, h, o.fit), ...amap, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', br + 'k', '-maxrate', br + 'k', '-bufsize', 2 * br + 'k', '-g', '60', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', out];
    const p = spawn('ffmpeg', a, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stdout.on('data', x => { const m = String(x).match(/out_time_us=(\d+)/g); if (m && pr.dur) { const pct = Math.min(99, Math.round(+m[m.length - 1].split('=')[1] / 1e4 / pr.dur)); prog({ status: 'converting', pct: 40 + Math.round(pct * 0.5), msg: `H.264 convert: ${pct}%` }); } });
    p.stderr.on('data', x => { err = String(x).trim().split('\n').pop(); });
    p.on('error', no);
    p.on('close', c => c === 0 ? ok() : no(new Error('Convert fail: ' + err.slice(0, 200))));
  });
}

(async () => {
  const imp = await F.get('imports/' + ID);
  if (!imp || !imp.url) return fail('Import request nahi mili');
  url = imp.url;
  if (!REPO || !process.env.VIDEOS_TOKEN) return fail('VIDEOS_REPO / VIDEOS_TOKEN secret set nahi hai');
  REPO = await U.repoName(REPO, process.env.VIDEOS_TOKEN).catch(e => fail(e.message));
  const mode = ['auto', 'none', 'force'].includes(imp.convert) ? imp.convert : 'auto';
  await prog({ status: 'downloading', pct: 1, msg: 'Download shuru' }, true);

  // naam
  let base = imp.name ? clean(imp.name) : '';
  if (!base) { try { base = clean(decodeURIComponent(path.basename(new URL(url).pathname))); } catch { base = 'video'; } }
  let ext = (base.match(/\.([A-Za-z0-9]{2,4})$/) || [])[1] || '';
  const isImg = /^(jpe?g|png)$/i.test(ext);
  const raw = path.join(WORK, 'raw' + (ext ? '.' + ext : ''));
  const info = await fetchFile(url, raw).catch(e => fail(e.message));
  const size0 = fs.statSync(raw).size;
  console.log('Download pura: ' + (size0 / 1e6).toFixed(0) + ' MB');

  let final = raw, name;
  if (isImg) {
    if (size0 > 2097152) return fail('Thumbnail 2MB se bada hai');
    name = base;
  } else {
    const pr = await U.probe(raw);
    if (!pr || !pr.codec) return fail('Yeh video file nahi lagti (ffprobe padh nahi paaya)');
    let need = mode === 'force';
    if (mode === 'auto') {
      const gop = await U.maxGop(raw).catch(() => Infinity);
      need = pr.codec !== 'h264' || !pr.audio || pr.audio !== 'aac' || pr.pix !== 'yuv420p' || pr.fps > 60 || gop > 4.1;
      console.log(`probe: ${pr.codec} ${pr.w}x${pr.h} ${pr.fps.toFixed(1)}fps audio=${pr.audio || '-'} pix=${pr.pix} gop=${gop === Infinity ? '>90s' : gop.toFixed(1) + 's'} -> convert ${need ? 'chahiye' : 'nahi chahiye'}`);
    }
    if (!need && size0 > LIMIT) return fail('File 2 GB se badi hai. Convert "Auto/Force" chuno taaki chhoti ho jaye');
    base = base.replace(/\.[^.]+$/, '');
    if (need) {
      final = path.join(WORK, 'out.mp4');
      await prog({ status: 'converting', pct: 40, msg: 'H.264 me convert ho raha hai...' }, true);
      await convert(raw, final, pr, imp).catch(e => fail(e.message));
      fs.unlinkSync(raw);
      name = base + '_live.mp4';
    } else name = base + '.' + (ext || 'mp4');
    if (fs.statSync(final).size > LIMIT) return fail('Convert ke baad bhi file 2 GB se badi hai. Quality kam karo ya video chhota karo');
  }

  // Release taiyar karo
  await prog({ status: 'uploading', pct: 92, msg: 'GitHub Release me upload ho raha hai' }, true);
  try { await U.sh('gh', ['release', 'view', TAG, '--repo', REPO], { env: GH }); }
  catch { await U.sh('gh', ['release', 'create', TAG, '--repo', REPO, '--title', 'LiveLoop videos', '--notes', 'LiveLoop dashboard se manage hota hai. Haath se mat badlo.'], { env: GH }).catch(e => fail('Release nahi ban paya (videos repo me kam se kam ek commit hona chahiye): ' + e.message)); }

  // naam takraav
  let taken = [];
  try { taken = (await U.sh('gh', ['release', 'view', TAG, '--repo', REPO, '--json', 'assets', '--jq', '.assets[].name'], { env: GH })).split('\n').filter(Boolean); } catch { }
  let uniq = name, n = 2; while (taken.includes(uniq)) uniq = name.replace(/(\.[^.]+)$/, `-${n++}$1`);
  const up = path.join(WORK, uniq); fs.renameSync(final, up);
  await U.sh('gh', ['release', 'upload', TAG, up, '--repo', REPO], { env: GH }).catch(e => fail('Upload fail: ' + e.message));

  await prog({ status: 'done', pct: 100, msg: 'Ho gaya', asset: uniq, size: fs.statSync(up).size, url: '' }, true);
  console.log('DONE: ' + uniq);
})().catch(e => fail(String(e && e.message || e)));
