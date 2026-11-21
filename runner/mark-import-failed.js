'use strict';
// Import beech me fail/cancel ho jaye to dashboard me status atka na rahe
const F = require('./lib/fs');
const id = process.env.IMPORT_ID, path = 'imports/' + id;
F.get(path)
  .then(i => (i && !['done', 'error'].includes(i.status)) ? F.patch(path, { status: 'error', msg: 'Import beech me ruk gaya (GitHub Actions logs dekho)', url: '' }) : null)
  .catch(e => console.log('mark-import-failed: ' + e.message));
