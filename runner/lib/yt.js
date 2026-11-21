'use strict';
// YouTube Data API v3: broadcast banana, bind, live karna, complete karna
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function jf(url, opt) {
  const r = await fetch(url, opt);
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) {
    const m = (j.error && (j.error.message || j.error_description || j.error)) || t.slice(0, 150);
    throw new Error(`${r.status} ${typeof m === 'string' ? m : JSON.stringify(m)}`);
  }
  return j;
}

module.exports = ({ clientId, clientSecret, refresh, log }) => {
  let tk = null, exp = 0;
  async function token() {
    if (tk && exp > Date.now()) return tk;
    try {
      const r = await jf('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: 'refresh_token' }) });
      tk = r.access_token; exp = Date.now() + (r.expires_in - 60) * 1e3; return tk;
    } catch (e) {
      if (/invalid_grant/.test(e.message)) throw new Error('Channel ka access khatam ho gaya. Channels tab me channel hatao aur dobara connect karo (OAuth app Production me ho)');
      throw e;
    }
  }
  const api = async (method, url, body) => jf('https://www.googleapis.com/youtube/v3/' + url, { method, headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  async function prepare(c, st, thumbPath) {
    const title = (c.title || c.name).slice(0, 100);
    const s = await api('POST', 'liveStreams?part=snippet,cdn,contentDetails', { snippet: { title: title + ' (stream)' }, cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' }, contentDetails: { isReusable: false } });
    const ing = s.cdn.ingestionInfo; st.ytUrl = ing.ingestionAddress; st.ytKey = ing.streamName; st.sid = s.id;
    const b = await api('POST', 'liveBroadcasts?part=snippet,status,contentDetails', {
      snippet: { title, description: c.description || '', scheduledStartTime: new Date(Date.now() + 30000).toISOString() },
      status: { privacyStatus: c.privacy || 'unlisted', selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: false, latencyPreference: 'low', monitorStream: { enableMonitorStream: false } }
    });
    st.bid = b.id;
    await api('POST', `liveBroadcasts/bind?id=${b.id}&part=id,contentDetails&streamId=${s.id}`);
    try { await api('PUT', 'videos?part=snippet', { id: b.id, snippet: { title, description: c.description || '', tags: c.tags || [], categoryId: '22' } }); }
    catch (e) { log('WARNING', `tags/description update fail: ${e.message}`); }
    if (thumbPath) {
      try {
        const buf = fs.readFileSync(thumbPath);
        if (buf.length > 2097152) throw new Error('thumbnail 2MB se bada hai');
        const mime = /\.png$/i.test(thumbPath) ? 'image/png' : 'image/jpeg';
        await jf(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${b.id}&uploadType=media`, { method: 'POST', headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': mime }, body: buf });
        log('INFO', 'thumbnail upload ho gaya');
      } catch (e) { log('WARNING', 'thumbnail fail: ' + e.message); }
    }
  }

  // ffmpeg ka data YouTube tak pahunche to broadcast ko live me transition karo
  async function goLive(st, want) {
    for (let i = 0; i < 36 && want(); i++) {
      await sleep(5000);
      try {
        const r = await api('GET', 'liveStreams?part=status&id=' + st.sid);
        if (r.items && r.items[0] && r.items[0].status.streamStatus === 'active') {
          try { await api('POST', `liveBroadcasts/transition?broadcastStatus=live&id=${st.bid}&part=status`); }
          catch (e) { log('INFO', 'transition note: ' + e.message); }
          const b = await api('GET', 'liveBroadcasts?part=status&id=' + st.bid);
          st.ytStatus = (b.items && b.items[0] && b.items[0].status.lifeCycleStatus) || 'unknown';
          log('INFO', 'YouTube broadcast status = ' + st.ytStatus); return;
        }
      } catch (e) { log('WARNING', 'YouTube status check: ' + e.message); }
    }
    if (want()) { st.ytStatus = 'ingest nahi mila'; log('WARNING', '3 min tak YouTube ko video nahi mila'); }
  }

  const complete = bid => api('POST', `liveBroadcasts/transition?broadcastStatus=complete&id=${bid}&part=status`);

  // ---- clips: video upload (private + publishAt = YouTube khud us time par public karega) ----
  const ytErr = (status, t) => {
    let j = {}; try { j = JSON.parse(t); } catch { }
    const er = j.error || {}, reason = ((er.errors || [])[0] || {}).reason || er.status || '';
    const e = new Error(`YouTube upload ${status} ${reason}: ${String(er.message || t).slice(0, 160)}`);
    e.reason = reason; e.status = status;
    e.fatal = /quotaExceeded|uploadLimitExceeded|rateLimitExceeded|forbidden|authError|insufficientPermissions|youtubeSignupRequired|accountClosed|accountSuspended/i.test(reason) || status === 401 || status === 403;
    return e;
  };
  async function upload(file, m) {
    const buf = fs.readFileSync(file);
    const meta = { snippet: { title: m.title, description: m.description, tags: m.tags || [], categoryId: m.category || '22' }, status: { privacyStatus: 'private', publishAt: m.publishAt, selfDeclaredMadeForKids: false } };
    let last;
    for (let tr = 0; tr < 3; tr++) {
      try {
        const r = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
          method: 'POST', signal: AbortSignal.timeout(60e3),
          headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(buf.length), 'X-Upload-Content-Type': 'video/mp4' },
          body: JSON.stringify(meta)
        });
        if (!r.ok) throw ytErr(r.status, await r.text());
        const loc = r.headers.get('location'); if (!loc) throw new Error('YouTube ne upload URL nahi diya');
        const u = await fetch(loc, { method: 'PUT', signal: AbortSignal.timeout(15 * 60e3), headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(buf.length) }, body: buf });
        const t = await u.text();
        if (!u.ok) throw ytErr(u.status, t);
        const j = JSON.parse(t); if (!j.id) throw new Error('upload ke baad video id nahi mili');
        return j.id;
      } catch (e) { last = e; if (e.fatal || (e.status && e.status < 500 && e.status !== 408)) throw e; await sleep(5000 * (tr + 1)); }
    }
    throw last;
  }
  return { prepare, goLive, complete, upload };
};
