'use strict';
const need = k => { const v = process.env[k]; if (!v) throw new Error(k + ' env set nahi hai'); return v; };
const TAG = () => process.env.VIDEOS_TAG || 'videos', REF = () => process.env.RUNNER_REF || 'main';
let me = null;

async function gh(method, url, body) {
  const r = await fetch('https://api.github.com' + url, {
    method, signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + need('GH_TOKEN'), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'liveloop', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 204) return {};
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) { const e = new Error(`GitHub ${r.status}: ${j.message || t.slice(0, 120)}`); e.status = r.status; throw e; }
  return j;
}
// "user/repo", poora github URL, ya sirf "repo" (tab token wale account ka naam jod diya jata hai)
async function repo(k) {
  let v = need(k).trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
  if (!v.includes('/')) { me = me || (await gh('GET', '/user')).login; v = me + '/' + v; }
  return v;
}
exports.gh = gh; exports.repo = repo;
exports.dispatch = async (file, inputs) => {
  const R = await repo('RUNNER_REPO');
  try { return await gh('POST', `/repos/${R}/actions/workflows/${file}/dispatches`, { ref: REF(), inputs }); }
  catch (e) {
    if (e.status === 404) throw new Error(`404: "${R}" repo ya .github/workflows/${file} nahi mila. Setup tab me detail dikhegi`);
    if (e.status === 403) throw new Error('403: token ko Actions = Read and write permission nahi hai');
    if (e.status === 422) throw new Error(`422: branch "${REF()}" nahi mili ya ${file} me workflow_dispatch nahi hai`);
    throw e;
  }
};
exports.cancel = async id => gh('POST', `/repos/${await repo('RUNNER_REPO')}/actions/runs/${encodeURIComponent(id)}/cancel`);
exports.clipsTag = () => process.env.CLIPS_TAG || 'clips';
exports.assets = async tag => {
  const V = await repo('VIDEOS_REPO'); let rel;
  try { rel = await gh('GET', `/repos/${V}/releases/tags/${encodeURIComponent(tag || TAG())}`); }
  catch (e) { if (e.status === 404) return []; throw e; }
  const a = await gh('GET', `/repos/${V}/releases/${rel.id}/assets?per_page=100`);
  return a.filter(x => x.state === 'uploaded').map(x => ({ id: x.id, name: x.name, size: x.size, created: x.created_at }));
};
exports.deleteAsset = async id => gh('DELETE', `/repos/${await repo('VIDEOS_REPO')}/releases/assets/${encodeURIComponent(id)}`);
