'use strict';
const { spawn } = require('child_process');
exports.repoName = async (v, token) => {
  v = String(v || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
  if (v && !v.includes('/')) {
    const r = await fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'liveloop' } });
    const j = await r.json().catch(() => ({}));
    if (!j.login) throw new Error('VIDEOS_REPO me username/repo likho');
    v = j.login + '/' + v;
  }
  return v;
};
exports.sleep = ms => new Promise(r => setTimeout(r, ms));

// command chalao, stdout wapas do; fail par stderr ka ant dikhao
exports.sh = (cmd, args, opt = {}) => new Promise((ok, no) => {
  const p = spawn(cmd, args, { ...opt, env: { ...process.env, ...(opt.env || {}) } });
  let o = '', e = '';
  p.stdout.on('data', d => { o += d; });
  p.stderr.on('data', d => { e += d; });
  p.on('error', no);
  p.on('close', c => c === 0 ? ok(o) : no(new Error((e || o).trim().slice(-300) || `${cmd} exit ${c}`)));
});

exports.probe = async f => {
  try {
    const o = await exports.sh('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate:format=duration', '-of', 'json', f]);
    const j = JSON.parse(o), s = j.streams || [];
    const v = s.find(x => x.codec_type === 'video') || {}, a = s.find(x => x.codec_type === 'audio');
    const [n, d] = String(v.avg_frame_rate || '0/1').split('/').map(Number);
    return { codec: v.codec_name || null, w: v.width, h: v.height, pix: v.pix_fmt, fps: d ? n / d : 0, audio: a ? a.codec_name : null, dur: +(j.format && j.format.duration) || 0 };
  } catch { return null; }
};

// pehle 90 second me do keyframes ke beech sabse bada gap (YouTube ko <=4s chahiye)
exports.maxGop = async f => {
  const o = await exports.sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+90', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', f]);
  const ks = o.split('\n').map(l => l.split(',')).filter(x => x[1] && x[1].includes('K')).map(x => parseFloat(x[0])).filter(x => !isNaN(x)).sort((a, b) => a - b);
  if (ks.length < 2) return Infinity;
  let m = 0; for (let i = 1; i < ks.length; i++) m = Math.max(m, ks[i] - ks[i - 1]);
  return m;
};

exports.dims = (q, o) => { const [w, h, d] = exports.Q[q] || exports.Q.hd; return o === 'h' ? [h, w, d] : [w, h, d]; };
exports.Q = { low: [360, 640, 800], med: [480, 854, 1500], hd: [720, 1280, 2500], fhd: [1080, 1920, 4500] };
exports.vfilter = (w, h, fit) => (fit === 'pad'
  ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`
  : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`) + ',fps=30,format=yuv420p';
