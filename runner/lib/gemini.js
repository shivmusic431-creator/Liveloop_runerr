'use strict';
// Gemini free-tier client: kai API keys x kai models.
//   model nahi mila / overload / kharab output  -> agla model
//   quota (429)                                  -> agli key (ya cooldown khatam hone par wapas)
//   key galat / project band                      -> key "dead" (dashboard se reset hota hai)
// Cooldown Firestore me save hota hai, isliye alag-alag runs ko pata rehta hai kaun si key+model kab tak band hai.
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FALLBACK = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];

// ---------- Pacific time (Gemini daily quota yahin ke midnight par reset hota hai) ----------
const pacParts = now => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now).map(x => [x.type, x.value]));
const pacDay = now => { const p = pacParts(now); return `${p.year}-${p.month}-${p.day}`; };
const nextPacMidnight = now => { const p = pacParts(now); return now - ((+p.hour * 60 + +p.minute) * 60 + +p.second) * 1000 + 86400e3 + 5000; };

// ---------- model ranking ----------
// hard = sabse accha pehle (pro > flash > lite), easy = halka pehle (flash > lite > pro) taaki pro ka quota bache
function rankModels(names, tier) {
  const rows = [];
  for (const n of names) {
    const id = String(n).replace(/^models\//, '');
    if (/image|tts|audio|live|native|embed|robot|computer|customtools|dialog|vision|aqa|exp\b|-exp-|thinking-exp|gemma/i.test(id)) continue;
    let m = id.match(/^gemini-(\d+(?:\.\d+)?)-(pro|flash-lite|flash)(?:-(.+))?$/);
    if (m) rows.push({ id, v: parseFloat(m[1]), t: m[2], suffix: m[3] || '' });
    else if ((m = id.match(/^gemini-(pro|flash-lite|flash)-latest$/))) rows.push({ id, v: -1, t: m[1], suffix: 'latest' });
  }
  const hard = { pro: 3, flash: 2, 'flash-lite': 1 }, easy = { flash: 3, 'flash-lite': 2, pro: 1 };
  const tr = tier === 'easy' ? easy : hard;
  rows.sort((a, b) => (b.v - a.v) || (tr[b.t] - tr[a.t]) || ((a.suffix ? 1 : 0) - (b.suffix ? 1 : 0)) || a.id.localeCompare(b.id));
  if (tier === 'easy') rows.sort((a, b) => ((b.v >= 0) - (a.v >= 0)) || (tr[b.t] - tr[a.t]) || (b.v - a.v) || ((a.suffix ? 1 : 0) - (b.suffix ? 1 : 0)));
  return [...new Set(rows.map(r => r.id))];
}

// ---------- error samajhna ----------
function parseErr(status, text) {
  let j = {}; try { j = JSON.parse(text); } catch { }
  const e = j.error || {}, msg = String(e.message || text || '').slice(0, 400);
  let delay = 0; const q = [];
  for (const d of Array.isArray(e.details) ? e.details : []) {
    const ty = String(d['@type'] || '');
    if (/RetryInfo/.test(ty) && d.retryDelay) delay = (parseFloat(d.retryDelay) * 1000) || delay;
    if (/QuotaFailure/.test(ty)) for (const v of d.violations || []) q.push(`${v.quotaId || ''} ${v.quotaMetric || ''}`);
  }
  if (!delay) { const m = msg.match(/retry in ([\d.]+)\s*s/i); if (m) delay = parseFloat(m[1]) * 1000; }
  return { status, msg, st: e.status || '', delay, q: q.join(' ') };
}
function decide(x, now) {
  const all = `${x.msg} ${x.q}`;
  if (x.status === 429 || x.st === 'RESOURCE_EXHAUSTED') {
    if (/limit:\s*0\b/.test(all)) return { act: 'cool', until: nextPacMidnight(now), why: 'yeh model free tier me nahi hai' };
    if (/PerDay|per day|daily/i.test(all)) return { act: 'cool', until: nextPacMidnight(now), why: 'daily quota khatam' };
    return { act: 'cool', until: now + Math.min(Math.max(x.delay || 30e3, 5e3), 300e3) + 1000, why: 'per-minute quota' };
  }
  if (x.status === 404) return { act: 'model', why: 'model nahi mila' };
  if (x.status === 401 || (x.status === 400 && /API key not valid|API_KEY_INVALID|API key expired|key.*(invalid|expired)/i.test(all))) return { act: 'dead', why: 'key galat ya expire' };
  if (x.status === 400 && /FAILED_PRECONDITION|free tier is not available/i.test(all)) return { act: 'dead', why: 'free tier is country/project me nahi' };
  if (x.status === 403) {
    if (/model/i.test(x.msg) && !/project|API key|denied access|suspended|leaked/i.test(x.msg)) return { act: 'cool', until: now + 86400e3, why: 'model ki permission nahi' };
    return { act: 'dead', why: x.msg.slice(0, 90) || 'permission denied' };
  }
  if ([0, 408, 500, 502, 503, 504].includes(x.status)) return { act: 'retry', why: x.status ? 'Gemini overload ' + x.status : 'network error' };
  if (x.status === 400) return { act: 'model', why: 'request is model ko manzoor nahi: ' + x.msg.slice(0, 80) };
  return { act: 'retry', why: `HTTP ${x.status}` };
}

function cleanJson(t) {
  let s = String(t).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch { }
  const a = s.search(/[\[{]/), b = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error('JSON nahi mila');
}

// store = { keys(): [{id,label,key,dead,deadReason,cool,today}], patch(id, obj) }
module.exports = ({ store, log = () => { }, maxCalls = 20, maxAttempts = 60 }) => {
  let ks = null, models = null, calls = 0, attempts = 0;
  const badModels = new Set();            // is run me 404 wale model
  const usage = {};                       // model -> calls

  async function load() {
    if (ks) return;
    ks = await store.keys(); const now = Date.now();
    for (const k of ks) { k.cool = Object.fromEntries(Object.entries(k.cool || {}).filter(([, t]) => t > now)); k.today = k.today && k.today.day === pacDay(now) ? k.today : { day: pacDay(now), n: 0 }; }
    if (!ks.length) throw new Error('Gemini API key nahi hai. Dashboard → Clips → Gemini keys me key jodo');
  }
  const save = async k => { try { await store.patch(k.id, { cool: k.cool, dead: !!k.dead, deadReason: k.deadReason || '', today: k.today, lastErr: k.lastErr || '' }); } catch (e) { log('WARNING', 'key state save fail: ' + e.message); } };

  async function listModels() {
    if (models) return models;
    for (const k of ks.filter(x => !x.dead)) {
      try {
        const r = await fetch(`${BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': k.key }, signal: AbortSignal.timeout(20e3) });
        if (!r.ok) continue;
        const j = await r.json();
        const n = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name);
        if (n.length) { models = n; log('INFO', `Gemini models mile: ${n.filter(x => /gemini/.test(x)).length}`); return models; }
      } catch { }
    }
    log('WARNING', 'models.list nahi chala, fallback list use hogi'); models = FALLBACK; return models;
  }

  async function once(k, model, o) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: o.prompt }] }],
      generationConfig: { temperature: o.temp ?? 0.4, maxOutputTokens: o.maxOut || 8192, ...(o.json === false ? {} : { responseMimeType: 'application/json' }) },
      safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map(category => ({ category, threshold: 'BLOCK_ONLY_HIGH' }))
    };
    if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
    for (let tr = 0; tr < 3; tr++) {
      attempts++;
      let status = 0, text = '';
      try {
        const r = await fetch(`${BASE}/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k.key }, body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeout || 150e3) });
        status = r.status; text = await r.text();
      } catch (e) { text = String(e.message || e); }
      if (status === 200) {
        try {
          const j = JSON.parse(text), c = (j.candidates || [])[0], parts = (c && c.content && c.content.parts) || [];
          const out = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
          if (!out.trim()) return { bad: (j.promptFeedback && j.promptFeedback.blockReason) || (c && c.finishReason) || 'khali jawab' };
          if (o.json === false) return { value: out };
          let v; try { v = cleanJson(out); } catch { return { bad: (c && c.finishReason === 'MAX_TOKENS') ? 'jawab beech me kat gaya (MAX_TOKENS)' : 'JSON kharab' }; }
          if (o.validate) { try { v = o.validate(v) ?? v; } catch (e) { return { bad: 'validate: ' + e.message }; } }
          return { value: v };
        } catch (e) { return { bad: 'response samajh nahi aaya' }; }
      }
      const x = parseErr(status, text), d = decide(x, Date.now());
      if (d.act === 'retry' && tr < 2) { await sleep(tr ? 10e3 : 4e3); continue; }
      if (d.act === 'retry') return { act: 'cool', until: Date.now() + 120e3, why: d.why, model: true };
      return { ...d, model: d.act === 'model' };
    }
  }

  async function call(o) {
    await load();
    const all = await listModels();
    const order = rankModels(all, o.tier || 'hard');
    const list = order.length ? order : FALLBACK;
    if (calls >= maxCalls) throw Object.assign(new Error(`Gemini call budget (${maxCalls}) poora ho gaya`), { budget: true });
    const bad = new Set(); let last = '';
    for (let round = 0; round < 4; round++) {
      let wait = null;
      for (const model of list) {
        if (badModels.has(model)) continue;
        for (const k of ks) {
          if (k.dead || bad.has(model + '|' + k.id)) continue;
          const until = k.cool[model] || 0;
          if (until > Date.now()) { if (until - Date.now() <= 75e3) wait = Math.min(wait ?? Infinity, until - Date.now()); continue; }
          if (attempts >= maxAttempts) throw new Error('Gemini: bahut zyada koshish ho gayi. ' + last);
          const r = await once(k, model, o);
          if (r && 'value' in r) {
            calls++; usage[model] = (usage[model] || 0) + 1; k.today.n++; k.lastErr = ''; await save(k);
            log('INFO', `Gemini ${o.task || 'call'} OK: ${model} (${k.label}) [${calls}/${maxCalls}]`);
            return r.value;
          }
          last = `${model}: ${(r && (r.why || r.bad)) || '?'}`;
          if (r.bad) { bad.add(model + '|' + k.id); log('WARNING', `Gemini ${model}: ${r.bad}, agla try`); continue; }
          if (r.act === 'dead') { k.dead = true; k.deadReason = r.why; k.lastErr = r.why; await save(k); log('WARNING', `Key ${k.label} band: ${r.why}`); continue; }
          if (r.act === 'cool') {
            k.cool[model] = r.until; k.lastErr = `${model}: ${r.why}`; await save(k);
            log('WARNING', `Key ${k.label} / ${model}: ${r.why} (${Math.round((r.until - Date.now()) / 60000)} min)`);
            if (r.model) break;       // overload: dusre key par bhi wahi hoga, agla model
            continue;                 // quota: agli key
          }
          if (r.act === 'model') { badModels.add(model); k.cool[model] = Date.now() + 6 * 3600e3; await save(k); log('WARNING', `Gemini ${model}: ${r.why}`); break; }
        }
      }
      if (wait !== null && isFinite(wait)) { log('INFO', `Sab key/model abhi cooldown me, ${Math.ceil(wait / 1000)}s ruk rahe`); await sleep(wait + 500); continue; }
      break;
    }
    const alive = ks.filter(k => !k.dead).length;
    throw Object.assign(new Error(!alive ? 'Saari Gemini keys band/kharab hain' : `Gemini free quota abhi khatam hai (saari key/model). Pacific midnight (lagbhag 12:30-13:30 IST) ke baad retry karo. ${last}`), { quota: true });
  }

  return { call, stats: () => ({ calls, attempts, usage, keys: (ks || []).map(k => ({ label: k.label, n: k.today.n, dead: !!k.dead })) }) };
};
module.exports.rankModels = rankModels; module.exports.decide = decide; module.exports.parseErr = parseErr; module.exports.nextPacMidnight = nextPacMidnight; module.exports.pacDay = pacDay; module.exports.cleanJson = cleanJson;
