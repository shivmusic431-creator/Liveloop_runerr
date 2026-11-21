'use strict';
// Clip workflow ke aakhri step me (hamesha chalta hai): safai
//  1) runner achanak mara ho to job ka status theek karo
//  2) Release me bekar pade clips hatao (sirf "partial" jobs ke bache clips rakhte hain)
//  3) 7 din se purane workflow runs/logs hatao
//  4) purane Firestore records hatao
const F = require('./lib/fs'), U = require('./lib/util');
const ID = process.env.CLIP_ID, RUNID = process.env.GITHUB_RUN_ID || 'local', TAG = process.env.CLIPS_TAG || 'clips';
const OPEN = ['queued', 'downloading', 'transcribing', 'planning', 'rendering', 'uploading'];
const GH = { GH_TOKEN: process.env.VIDEOS_TOKEN };
const day = 864e5;

async function api(method, url) {
  const r = await fetch('https://api.github.com' + url, { method, signal: AbortSignal.timeout(20000), headers: { Authorization: 'Bearer ' + process.env.VIDEOS_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'liveloop' } });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`GitHub ${r.status}: ${j.message || ''}`); return j;
}

(async () => {
  let jobs = [];
  try { jobs = await F.list('clipjobs'); } catch (e) { console.log('jobs list fail: ' + e.message); }

  // 1) is run ka job
  const me = jobs.find(j => j.id === ID);
  if (me && OPEN.includes(me.status) && (!me.runId || me.runId === RUNID)) {
    const pend = (me.pending || []).length;
    await F.patch('clipjobs/' + ID, { status: me.status === 'queued' ? 'error' : (pend ? 'partial' : 'error'), msg: me.status === 'queued' ? 'Runner start nahi hua - GitHub Actions logs dekho' : 'Runner achanak band hua (timeout/cancel). “Dobara koshish” dabao, Gemini ke purane results bache hain', stage: pend ? 'upload' : (me.stage || ''), heartbeat: Date.now() }).catch(e => console.log(e.message));
    console.log('job status theek kiya');
  }

  // 2) Release ke orphan clips
  try {
    const REPO = await U.repoName(process.env.VIDEOS_REPO, process.env.VIDEOS_TOKEN);
    const keep = new Set(); for (const j of jobs) if (j.status === 'partial' || OPEN.includes(j.status)) for (const p of j.pending || []) keep.add(p.asset);
    let rel = null; try { rel = await api('GET', `/repos/${REPO}/releases/tags/${encodeURIComponent(TAG)}`); } catch (e) { if (!/404/.test(e.message)) throw e; }
    if (rel) {
      const assets = await api('GET', `/repos/${REPO}/releases/${rel.id}/assets?per_page=100`);
      let n = 0;
      for (const a of assets) if (!keep.has(a.name)) { await api('DELETE', `/repos/${REPO}/releases/assets/${a.id}`).then(() => n++).catch(e => console.log('asset delete fail: ' + e.message)); }
      console.log(`Release safai: ${n} bekar clip hatae, ${assets.length - n} rakhe`);
      if (assets.length - n === 0) await api('DELETE', `/repos/${REPO}/releases/${rel.id}`).then(() => console.log('khali clips release hata diya')).catch(() => { });
    }
  } catch (e) { console.log('release cleanup fail: ' + e.message); }

  // 3) purane workflow runs
  try {
    const R = process.env.GITHUB_REPOSITORY;
    if (R) {
      const j = await api('GET', `/repos/${R}/actions/runs?per_page=100&status=completed`);
      const old = (j.workflow_runs || []).filter(r => Date.now() - Date.parse(r.created_at) > 7 * day).slice(0, 60);
      let n = 0; for (const r of old) await api('DELETE', `/repos/${R}/actions/runs/${r.id}`).then(() => n++).catch(() => { });
      console.log(`Purane workflow runs hatae: ${n}`);
    }
  } catch (e) { console.log('runs cleanup fail: ' + e.message); }

  // 4) Firestore records
  try {
    for (const j of jobs) if (['done', 'stopped'].includes(j.status) && Date.now() - (j.created || 0) > 30 * day) await F.del('clipjobs/' + j.id);
    for (const v of await F.list('clipvids')) if (Date.now() - Date.parse(v.publishAt || 0) > 60 * day) await F.del('clipvids/' + v.id);
  } catch (e) { console.log('records cleanup fail: ' + e.message); }
})().catch(e => console.log('cleanup error: ' + e.message));
