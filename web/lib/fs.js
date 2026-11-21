'use strict';
// Firestore REST client (zero-dependency). Service account se token banata hai.
const crypto = require('crypto');
let SA = null, T = { t: null, exp: 0 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Service account JSON kai roop me chalega: seedha JSON, quotes me, \" wala, ya base64
function parseSA(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('FIREBASE_SERVICE_ACCOUNT set nahi hai');
  s = s.replace(/^(['"`])([\s\S]*)\1$/, '$2').trim();
  const tries = [s, s.replace(/\\"/g, '"'), () => Buffer.from(s, 'base64').toString('utf8')];
  for (const t of tries) {
    try {
      let j = JSON.parse(typeof t === 'function' ? t() : t);
      if (typeof j === 'string') j = JSON.parse(j);
      if (j && j.client_email && j.private_key && j.project_id) return j;
    } catch { }
  }
  throw new Error('FIREBASE_SERVICE_ACCOUNT sahi JSON nahi hai. Downloaded .json file ka poora text ({ se } tak) bina quotes ke dobara paste karo');
}
function loadSA() {
  const j = parseSA(process.env.FIREBASE_SERVICE_ACCOUNT);
  j.private_key = j.private_key.replace(/\\n/g, '\n');
  return j;
}
const b64u = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

async function token() {
  SA = SA || loadSA();
  if (T.t && T.exp > Date.now()) return T.t;
  const n = Math.floor(Date.now() / 1e3);
  const u = b64u({ alg: 'RS256', typ: 'JWT' }) + '.' + b64u({ iss: SA.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: n, exp: n + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(u).sign(SA.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { signal: AbortSignal.timeout(15000), method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: u + '.' + sig }) });
  const j = await r.json();
  if (!r.ok) throw new Error('Firebase token: ' + (j.error_description || j.error || r.status));
  T = { t: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1e3 };
  return T.t;
}

const enc = v => v === null || v === undefined ? { nullValue: null }
  : typeof v === 'boolean' ? { booleanValue: v }
  : typeof v === 'number' ? (Number.isFinite(v) ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : { nullValue: null })
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } }
  : typeof v === 'object' ? { mapValue: { fields: fields(v) } }
  : { stringValue: String(v) };
const fields = o => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined).map(([k, x]) => [k, enc(x)]));
const dec = v => {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) return obj(v.mapValue.fields || {});
  return null;
};
const obj = f => Object.fromEntries(Object.entries(f || {}).map(([k, x]) => [k, dec(x)]));
const unpack = d => ({ id: d.name.split('/').pop(), ...obj(d.fields) });

async function call(method, path, { body, query } = {}, tries = 3) {
  SA = SA || loadSA();
  const base = `https://firestore.googleapis.com/v1/projects/${SA.project_id}/databases/(default)/documents`;
  const url = base + (path ? '/' + path : '') + (query ? '?' + query : '');
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000), method, headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (r.status === 404 && method === 'GET') return null;
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = {}; }
      if (!r.ok) {
        const m = (j.error && j.error.message) || t.slice(0, 160);
        const e = new Error(`Firestore ${r.status}: ${m}`); e.status = r.status;
        if ((r.status === 429 || r.status >= 500) && i < tries) { await sleep(500 * i); continue; }
        throw e;
      }
      return j;
    } catch (e) {
      if (e.status || i >= tries) throw e;
      await sleep(500 * i);
    }
  }
}

const mask = o => Object.keys(o).filter(k => o[k] !== undefined).map(k => 'updateMask.fieldPaths=' + encodeURIComponent('`' + k + '`')).join('&');
module.exports = {
  get: async p => { const d = await call('GET', p); return d ? unpack(d) : null; },
  set: (p, o) => call('PATCH', p, { body: { fields: fields(o) } }),                 // poora document badal deta hai
  patch: (p, o) => call('PATCH', p, { body: { fields: fields(o) }, query: mask(o) }), // sirf diye hue fields
  add: (col, o) => call('POST', col, { body: { fields: fields(o) } }),
  del: p => call('DELETE', p),
  list: async col => {
    const out = []; let pt = '';
    do {
      const d = await call('GET', col, { query: 'pageSize=300' + (pt ? '&pageToken=' + encodeURIComponent(pt) : '') });
      if (!d) break;
      (d.documents || []).forEach(x => out.push(unpack(x)));
      pt = d.nextPageToken || '';
    } while (pt);
    return out;
  },
  sa: () => (SA = SA || loadSA()),
  _fields: fields, _obj: obj
};
