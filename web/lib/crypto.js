'use strict';
// AES-256-GCM: refresh token / stream key Firestore me encrypted rakhne ke liye
const crypto = require('crypto');
// ENC_KEY optional hai. Na ho to Firebase service account ki private key se key banti hai
// (Vercel aur GitHub dono me wahi JSON hai, isliye dono jagah key same rehti hai).
const seed = () => {
  if (process.env.ENC_KEY && process.env.ENC_KEY.length >= 8) return process.env.ENC_KEY;
  return 'll:' + require('./fs').sa().private_key;
};
exports.seed = seed;
const key = () => crypto.createHash('sha256').update(seed()).digest();
exports.enc = t => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const e = Buffer.concat([c.update(String(t), 'utf8'), c.final()]);
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), e]).toString('base64url');
};
exports.dec = s => {
  if (!s) return '';
  if (!String(s).startsWith('v1.')) throw new Error('encrypted data ka format galat hai');
  const b = Buffer.from(s.slice(3), 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  try { return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); }
  catch { throw new Error('Decrypt fail: Vercel aur GitHub ka FIREBASE_SERVICE_ACCOUNT (ya ENC_KEY) alag hai'); }
};
