import fs from 'node:fs';
import path from 'node:path';
import {durableWrite} from './recovery.mjs';
import {randomUUID} from 'node:crypto';
const read = p => JSON.parse(fs.readFileSync(p,'utf8'));
const check = (v,m) => { if(!v) throw Error(m); };
const alive = pid => { try { process.kill(pid,0); return true; } catch(e) { return e.code !== 'ESRCH'; } };
export function acquire(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Serialize stale-owner inspection AND replacement. Two recovery processes must never both
  // remove a dead owner's directory and accidentally remove the new live owner's lock.
  // A crash in this tiny critical section leaves the guard for explicit inspection (fail closed).
  const guard = file + '.guard', token = randomUUID();
  fs.mkdirSync(guard, { mode: 0o700 });
  try {
    if (fs.existsSync(file)) {
      let pid; try { pid = read(path.join(file, 'owner.json')).pid; } catch { throw new Error(`Incomplete lock: ${file}`); }
      check(Number.isSafeInteger(pid) && pid > 0 && !alive(pid), `Already running: ${file}`);
      fs.rmSync(file, { recursive: true });
    }
    fs.mkdirSync(file, { mode: 0o700 });
    durableWrite(path.join(file, 'owner.json'), { pid: process.pid, token });
  } finally { fs.rmdirSync(guard); }
  return () => {
    // Never release another generation's lock.
    if (read(path.join(file, 'owner.json')).token === token) fs.rmSync(file, { recursive: true });
  };
}
