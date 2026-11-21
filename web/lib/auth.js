'use strict';
const crypto = require('crypto');
const secret = () => process.env.SESSION_SECRET || crypto.createHash('sha256').update('sess:' + (process.env.ADMIN_PASSWORD || '') + require('./crypto').seed()).digest('hex');
const sign = v => crypto.createHmac('sha256', secret()).update(v).digest('base64url');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// signed cookie (serverless me memory session nahi chalta)
exports.mint = () => { const p = Buffer.from(JSON.stringify({ exp: Date.now() + 7 * 864e5 })).toString('base64url'); return p + '.' + sign(p); };
exports.check = c => {
  try {
    const [p, s] = String(c || '').split('.');
    return !!p && !!s && same(s, sign(p)) && JSON.parse(Buffer.from(p, 'base64url')).exp > Date.now();
  } catch { return false; }
};
exports.pw = p => {
  const w = process.env.ADMIN_PASSWORD || '';
  if (!w) return false;
  const h = x => crypto.createHash('sha256').update(String(x)).digest();
  return crypto.timingSafeEqual(h(p), h(w));
};
// OAuth state (10 min valid)
exports.mintState = () => { const t = Date.now().toString(36) + '.' + crypto.randomBytes(8).toString('hex'); return t + '.' + sign('st:' + t); };
exports.checkState = s => {
  try {
    const i = String(s).lastIndexOf('.'), t = s.slice(0, i), g = s.slice(i + 1);
    return same(g, sign('st:' + t)) && Date.now() - parseInt(t.split('.')[0], 36) < 600e3;
  } catch { return false; }
};
exports.cookie = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, v.join('=')]));
