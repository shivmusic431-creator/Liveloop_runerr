'use strict';
// Words -> chhote caption phrases -> ASS (karaoke highlight wale) subtitles

// words: [{w,s,e}]  ->  phrases: [{s,e,words:[{t,s,e}]}]  (clip ke andar ke, original video ke time par)
function buildPhrases(words, cs, ce, maxW = 4, maxC = 26) {
  const out = []; let cur = null;
  const push = () => { if (cur && cur.words.length) { cur.s = cur.words[0].s; cur.e = cur.words[cur.words.length - 1].e; out.push(cur); } cur = null; };
  for (const w of words) {
    if (w.e <= cs || w.s >= ce) continue;
    const t = String(w.w).replace(/[{}\\]/g, '').trim(); if (!t) continue;
    if (cur) {
      const len = cur.words.reduce((a, x) => a + x.t.length + 1, 0) + t.length, last = cur.words[cur.words.length - 1];
      if (cur.words.length >= maxW || len > maxC || w.s - last.e > 0.6) push();
    }
    if (!cur) cur = { words: [] };
    cur.words.push({ t, s: Math.max(w.s, cs), e: Math.min(w.e, ce) });
    if (/[.?!।,;:]$/.test(t) && cur.words.length >= 2) push();
  }
  push(); return out;
}

// fixed = Gemini ne har phrase ka sudhra hua text diya (same count). Word timing jitna ho sake bachate hain.
function applyFix(phrases, fixed) {
  if (!Array.isArray(fixed) || fixed.length !== phrases.length) return phrases;
  return phrases.map((p, i) => {
    const toks = String(fixed[i] ?? '').replace(/[{}\\]/g, '').split(/\s+/).filter(Boolean);
    if (!toks.length) return p;
    if (toks.length === p.words.length) return { ...p, words: p.words.map((w, j) => ({ ...w, t: toks[j] })) };
    const tot = toks.reduce((a, t) => a + t.length + 1, 0), span = Math.max(0.3, p.e - p.s); let at = p.s;
    return { ...p, words: toks.map(t => { const d = span * (t.length + 1) / tot, w = { t, s: at, e: at + d }; at += d; return w; }) };
  });
}

const pickFont = phrases => {
  let dev = 0, lat = 0;
  for (const p of phrases) for (const w of p.words) { dev += (w.t.match(/[\u0900-\u097F]/g) || []).length; lat += (w.t.match(/[A-Za-z]/g) || []).length; }
  return dev > lat * 0.3 ? { name: 'Noto Sans Devanagari', size: 74 } : { name: 'Noto Sans', size: 82 };
};
const cs = s => Math.max(0, Math.round(s * 100));
const ts = s => { const c = cs(s), h = Math.floor(c / 360000), m = Math.floor(c % 360000 / 6000), x = Math.floor(c % 6000 / 100); return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}.${String(c % 100).padStart(2, '0')}`; };

// off = clip ka start (second), isse ghata kar phrases clip-relative ho jate hain
function makeAss(phrases, off, { w = 1080, h = 1920, marginV = 520 } = {}) {
  const f = pickFont(phrases);
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${f.name},${f.size},&H0000E6FF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,2,2,70,70,${marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const lines = phrases.map((p, i) => {
    const s = p.s - off, nx = phrases[i + 1];
    let e = Math.min(p.e + 0.18, nx ? nx.s - off - 0.02 : Infinity); if (e < p.e - off) e = p.e - off; if (e <= s) e = s + 0.3;
    const txt = p.words.map((x, j) => {
      const nxt = p.words[j + 1], d = Math.max(1, cs((nxt ? nxt.s : p.e) - x.s));
      return `{\\k${d}}${x.t}`;
    }).join(' ');
    return `Dialogue: 0,${ts(s)},${ts(e)},Default,,0,0,0,,{\\fscx88\\fscy88\\t(0,120,\\fscx100\\fscy100)}${txt}`;
  });
  return head + lines.join('\n') + '\n';
}
module.exports = { buildPhrases, applyFix, makeAss, pickFont };
