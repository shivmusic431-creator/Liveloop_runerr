'use strict';
// Ek clip kaatna: 9:16 (1080x1920), blur-background ya center-crop, burned-in captions
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const K = require('./caps');

function filter(mode, hasAss) {
  const tail = ',fps=30,format=yuv420p' + (hasAss ? ',ass=c.ass' : '');
  if (mode === 'crop') return `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920${tail}[v]`;
  return '[0:v]split=2[a][b];'
    + '[a]scale=216:384:force_original_aspect_ratio=increase,crop=216:384,boxblur=5:2,scale=1080:1920:flags=bilinear,eq=brightness=-0.1[bg];'
    + '[b]scale=1080:1920:force_original_aspect_ratio=decrease[fg];'
    + `[bg][fg]overlay=(W-w)/2:(H-h)/2${tail}[v]`;
}

// o: { src, out, start, dur, phrases, mode, work, hasAudio }
function renderClip(o) {
  return new Promise((ok, no) => {
    const dir = path.join(o.work, 'r' + path.basename(o.out, '.mp4'));
    fs.mkdirSync(dir, { recursive: true });
    const hasAss = o.phrases && o.phrases.length;
    if (hasAss) fs.writeFileSync(path.join(dir, 'c.ass'), K.makeAss(o.phrases, o.start));
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(o.start.toFixed(2)), '-i', path.resolve(o.src), '-t', String(o.dur.toFixed(2)),
      '-filter_complex', filter(o.mode, hasAss), '-map', '[v]', ...(o.hasAudio === false ? [] : ['-map', '0:a:0?']),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-movflags', '+faststart', path.resolve(o.out)];
    const p = spawn('ffmpeg', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); }, 25 * 60e3);
    p.stderr.on('data', d => { err = (err + d).slice(-600); });
    p.on('error', e => { clearTimeout(t); no(e); });
    p.on('close', c => { clearTimeout(t); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } c === 0 && fs.existsSync(o.out) ? ok() : no(new Error('ffmpeg render fail: ' + err.trim().split('\n').pop())); });
    renderClip.proc = p;
  });
}
module.exports = { renderClip, filter };
