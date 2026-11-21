'use strict';
// Workflow ke aakhri step me (always): runner achanak mara ho (timeout/cancel) to status saaf karo
const F = require('./lib/fs'), C = require('./lib/crypto'), mkYT = require('./lib/yt');
const ID = process.env.LIVE_ID, RUNID = process.env.GITHUB_RUN_ID || 'local';
const OPEN = ['queued', 'starting', 'preparing', 'live', 'stopping'];
(async () => {
  const run = await F.get('runs/' + ID);
  if (!run || !OPEN.includes(run.status)) return;
  if (run.runId && run.runId !== RUNID) return; // kisi aur run ka hai
  try {
    const live = await F.get('lives/' + ID);
    if (live && live.mode === 'api' && run.bid && live.complete !== false) {
      const a = await F.get('accounts/' + live.account);
      if (a) {
        const yt = mkYT({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, refresh: C.dec(a.refreshEnc), log: (l, m) => console.log(`[${l}] ${m}`) });
        await yt.complete(run.bid); console.log('broadcast complete kiya');
      }
    }
  } catch (e) { console.log('cleanup: broadcast complete fail: ' + e.message); }
  await F.patch('runs/' + ID, { status: run.status === 'queued' ? 'error' : 'stopped', msg: run.status === 'queued' ? 'Runner start nahi hua - GitHub Actions logs dekho' : 'Runner achanak band hua (timeout/cancel)', heartbeat: Date.now() });
})().catch(e => { console.log('cleanup error: ' + e.message); });
