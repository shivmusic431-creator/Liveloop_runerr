'use strict';
const form = o => new URLSearchParams(o).toString();
async function jf(url, opt) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), ...opt }), t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) throw new Error(`${r.status} ${(j.error_description || (j.error && (j.error.message || j.error)) || t.slice(0, 120))}`);
  return j;
}
const ready = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
exports.ready = ready;
exports.authUrl = (redirect, state) => {
  if (!ready()) throw Object.assign(new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET Vercel env me set karo'), { code: 400 });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + form({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: 'https://www.googleapis.com/auth/youtube', access_type: 'offline', prompt: 'consent', state });
};
exports.exchange = async (code, redirect) => {
  const r = await jf('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code' }) });
  if (!r.refresh_token) throw new Error('refresh token nahi mila - myaccount.google.com/permissions se LiveLoop hatao aur dobara connect karo');
  const ch = await jf('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: 'Bearer ' + r.access_token } });
  const c = ch.items && ch.items[0];
  if (!c) throw new Error('is Google account par YouTube channel nahi mila');
  return { id: c.id, title: c.snippet.title, refresh: r.refresh_token };
};
