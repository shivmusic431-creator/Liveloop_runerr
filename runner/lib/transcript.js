'use strict';
// Video download (yt-dlp / direct link) + transcript (YouTube captions, warna Whisper)
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const { Readable, Transform } = require('stream'), { pipeline } = require('stream/promises');
const U = require('./util');

const isYT = u => { try { return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(new URL(u).hostname); } catch { return false; } };

function friendly(m) {
  m = String(m || '');
  if (/Sign in to confirm|not a bot|confirm you.re not/i.test(m)) return 'YouTube ne bot-check lagaya (GitHub ke IP par aam hai). Clips tab me YouTube cookies daalo, ya video ka direct file link do';
  if (/Private video|members-only|Join this channel|This video is not available|Video unavailable|removed by the uploader/i.test(m)) return 'Video private/unavailable hai ya member-only hai';
  if (/HTTP Error 429|Too Many Requests/i.test(m)) return 'YouTube ne rate-limit kiya. Thodi der baad retry karo';
  if (/Requested format is not available|No video formats/i.test(m)) return 'Is video ka koi download format nahi mila (cookies ya yt-dlp update chahiye)';
  return m.slice(-260);
}

// streaming subprocess: har stdout line onLine ko
function run(cmd, args, { onLine, timeout = 3600e3, cwd } = {}) {
  return new Promise((ok, no) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', buf = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); no(new Error(`${cmd} timeout`)); }, timeout);
    p.stdout.on('data', d => { out += d; if (out.length > 4e6) out = out.slice(-2e6); buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (onLine) onLine(l); } });
    p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on('error', e => { clearTimeout(t); no(e); });
    p.on('close', c => { clearTimeout(t); c === 0 ? ok(out) : no(new Error((err || out).trim().slice(-800) || `${cmd} exit ${c}`)); });
    run.last = p;
  });
}

async function ytdlp(args, opt = {}) {
  const base = ['--no-playlist', '--no-warnings', '--no-colors', ...(opt.cookies ? ['--cookies', opt.cookies] : [])];
  try { return await run('yt-dlp', [...base, '--js-runtimes', 'node', ...args], opt); }
  catch (e) {
    if (/no such option|unrecognized arguments|Unknown option/i.test(e.message)) return run('yt-dlp', [...base, ...args], opt);
    throw new Error(friendly(e.message));
  }
}

async function info(url, cookies) {
  const o = await ytdlp(['-J', '--skip-download', url], { cookies, timeout: 180e3 });
  const j = JSON.parse(o);
  if (j.is_live || j.live_status === 'is_live') throw new Error('Yeh abhi live chal raha hai. Live khatam hone ke baad do');
  return j;
}

function pickSub(inf, hint) {
  const man = Object.keys(inf.subtitles || {}).filter(k => k !== 'live_chat'), auto = Object.keys(inf.automatic_captions || {});
  const L = String(hint || inf.language || '').split('-')[0].toLowerCase(), pref = [L, 'hi', 'en'].filter(Boolean);
  for (const p of pref) { const m = man.find(k => k === p || k.startsWith(p + '-')); if (m) return { lang: m, kind: 'manual' }; }
  const orig = auto.find(k => /-orig$/.test(k)); if (orig) return { lang: orig, kind: 'auto' };
  if (L && auto.includes(L)) return { lang: L, kind: 'auto' };     // sirf tab jab original language pata ho (translation se bachne ke liye)
  return null;
}

async function downloadYT(url, work, { cookies, sub, onPct }) {
  const args = ['-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4', '--newline', '--progress-template', 'download:%(progress._percent_str)s', '-o', path.join(work, 'src.%(ext)s')];
  if (sub) args.push(sub.kind === 'manual' ? '--write-subs' : '--write-auto-subs', '--sub-langs', sub.lang, '--sub-format', 'json3');
  args.push(url);
  await ytdlp(args, { cookies, onLine: l => { const m = l.match(/download:\s*([\d.]+)%/); if (m && onPct) onPct(Math.min(99, +m[1])); } });
  const f = fs.readdirSync(work).find(x => /^src\.(mp4|mkv|webm|mov)$/i.test(x));
  if (!f) throw new Error('Download ke baad video file nahi mili');
  const js = fs.readdirSync(work).find(x => /^src\..+\.json3$/i.test(x));
  return { file: path.join(work, f), subFile: js ? path.join(work, js) : null };
}

async function downloadDirect(url, work, onPct) {
  const dest = path.join(work, 'src.mp4'), MAX = 6 * 1024 ** 3;
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/124 Safari/537.36' } });
  if (!r.ok) throw new Error(`Link se ${r.status} aaya. Link direct download wala aur public hona chahiye`);
  if (/text\/html/i.test(r.headers.get('content-type') || '')) throw new Error('Yeh direct file link nahi hai (web page khul raha hai)');
  const len = +r.headers.get('content-length') || 0; let got = 0;
  const cnt = new Transform({ transform(c, e, cb) { got += c.length; if (got > MAX) return cb(new Error('File bahut badi hai')); if (len && onPct) onPct(Math.round(got / len * 99)); cb(null, c); } });
  await pipeline(Readable.fromWeb(r.body), cnt, fs.createWriteStream(dest));
  return { file: dest, subFile: null };
}

// ---------- json3 captions -> words ----------
function parseJson3(txt) {
  const j = JSON.parse(txt), raw = [];
  for (const ev of j.events || []) {
    if (!ev.segs) continue;
    const base = (ev.tStartMs || 0) / 1000, dur = (ev.dDurationMs || 0) / 1000;
    const segs = ev.segs.map(s => ({ t: String(s.utf8 || '').replace(/\s+/g, ' ').trim(), o: (s.tOffsetMs || 0) / 1000 })).filter(s => s.t);
    for (let i = 0; i < segs.length; i++) {
      const st = base + segs[i].o; let en = i + 1 < segs.length ? base + segs[i + 1].o : base + dur;
      if (!(en > st + 0.05)) en = st + 0.35;
      const toks = segs[i].t.split(' ').filter(Boolean), tot = toks.reduce((a, t) => a + t.length + 1, 0); let at = st;
      for (const t of toks) { const d = (en - st) * (t.length + 1) / tot; raw.push({ w: t, s: at, e: at + d }); at += d; }
    }
  }
  raw.sort((a, b) => a.s - b.s);
  const words = [];
  for (const w of raw) {                       // rolling-caption duplicates hatao
    const dupe = words.slice(-3).some(x => x.w === w.w && Math.abs(w.s - x.s) < 0.12);
    if (!dupe) words.push(w);
  }
  for (let i = 0; i < words.length; i++) {
    const nx = words[i + 1]; if (nx && words[i].e > nx.s) words[i].e = Math.max(words[i].s + 0.1, nx.s);
    if (words[i].e - words[i].s > 1.5) words[i].e = words[i].s + 1.5;
    words[i].s = +words[i].s.toFixed(2); words[i].e = +words[i].e.toFixed(2);
  }
  return words;
}

// ---------- Whisper fallback (runner par, free) ----------
async function whisper(src, work, { model = 'small', lang = 'auto', onPct, dur }) {
  const wav = path.join(work, 'audio.wav'), out = path.join(work, 'whisper.json');
  await U.sh('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', wav]);
  try { await U.sh('python3', ['-c', 'import faster_whisper']); }
  catch { await run('python3', ['-m', 'pip', 'install', '--quiet', '--break-system-packages', 'faster-whisper'], { timeout: 900e3 }); }
  await run('python3', [path.join(__dirname, '..', 'whisper.py'), wav, model, lang, out, String(dur || 0)], { timeout: 5 * 3600e3, onLine: l => { const m = l.match(/^PCT (\d+)/); if (m && onPct) onPct(+m[1]); } });
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  try { fs.unlinkSync(wav); } catch { }
  return { words: j.words || [], lang: j.lang || '' };
}

module.exports = { isYT, friendly, info, pickSub, downloadYT, downloadDirect, parseJson3, whisper, run };
