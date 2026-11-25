import { readFileSync } from 'node:fs';
import { readFit } from './dist/index.js';
for (const f of process.argv.slice(2)) {
  try { const s = await readFit(readFileSync(f), { force: false, strict: true }); console.log(f.split('/').pop().slice(0,20), 'CRC ok=', s.crcValid, 'warn=', s.warnings); }
  catch (e) { console.log(f.split('/').pop().slice(0,20), 'FAIL:', e.message); }
}
