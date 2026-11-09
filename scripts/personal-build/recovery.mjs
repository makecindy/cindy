/** Durable promotion journal. No application code or dependency installer is loaded during recovery. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const assert = (ok, reason) => { if (!ok) throw new Error(reason); };
export function durableWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try {
    fs.renameSync(tmp, file);
    if (process.platform !== 'win32') {
      const parent = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
  } finally { fs.rmSync(tmp, { force: true }); }
}
export function readJournal(file) {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(s.version === 1 && ['stable', 'trial', 'recovering', 'blocked'].includes(s.phase), 'Invalid update journal; use the independent recovery entry');
  assert(s.good?.id && path.isAbsolute(s.good.directory) && s.selected?.id && path.isAbsolute(s.selected.directory), 'Invalid recovery pointers');
  assert(s.good.verified === true && (s.phase === 'trial' || s.selected.id === s.good.id), 'Invalid verified recovery selection');
  assert(Array.isArray(s.rejected), 'Invalid rejected update list');
  if (s.phase === 'trial') {
    assert(typeof s.generation === 'string' && s.generation.length > 0 && Number.isFinite(s.startedAt), 'Invalid trial identity');
    assert(s.readyAt === null || Number.isFinite(s.readyAt) && Number.isFinite(s.lastHealthyAt), 'Invalid trial health evidence');
  }
  return s;
}
export class RecoveryJournal {
  constructor(file, { now = Date.now, nonce = randomUUID } = {}) { this.file = file; this.now = now; this.nonce = nonce; }
  read() { return readJournal(this.file); }
  init(good) {
    assert(!fs.existsSync(this.file), 'Recovery journal already exists');
    assert(good?.verified === true, 'Initial recovery version needs a verified live startup');
    const s = { version: 1, phase: 'stable', selected: good, good, previous: null, rejected: [], generation: null };
    durableWrite(path.join(path.dirname(this.file), 'known-good.json'), good);
    durableWrite(this.file, s); return s;
  }
  begin(candidate, evidence) {
    const s = this.read();
    assert(s.phase === 'stable', 'Finish recovery before another update');
    assert(candidate.id !== s.good.id && !s.rejected.some(r => r.id === candidate.id), 'Candidate is unchanged or rejected');
    assert(evidence?.compatible && evidence?.prepared && evidence?.idle && evidence?.stopped, 'Candidate must be prepared, compatible, idle and old process fully stopped');
    assert(candidate.directory !== s.good.directory, 'Candidate must use a separate directory');
    const next = { ...s, phase: 'trial', selected: candidate, generation: this.nonce(), startedAt: this.now(), readyAt: null };
    // One durable pointer/journal commit: interruption selects recovery, never an unrecorded candidate.
    durableWrite(this.file, next); return next;
  }
  observe({ generation, id, healthy, processAlive }, probationMs) {
    const s = this.read();
    assert(s.phase === 'trial' && generation === s.generation && id === s.selected.id, 'Stale or unrelated health evidence');
    if (!healthy || !processAlive) return this.reject('candidate failed health observation');
    if (s.readyAt === null) { s.readyAt = this.now(); s.lastHealthyAt = this.now(); durableWrite(this.file, s); return s; }
    if (this.now() < s.lastHealthyAt || this.now() - s.lastHealthyAt > 15_000) return this.reject('health observation was interrupted');
    s.lastHealthyAt = this.now();
    if (this.now() - s.readyAt < probationMs) { durableWrite(this.file, s); return s; }
    const next = { ...s, phase: 'stable', previous: s.good, good: { ...s.selected, verified: true }, generation: null };
    next.selected = next.good;
    durableWrite(path.join(path.dirname(this.file), 'known-good.json'), next.good);
    durableWrite(this.file, next); return next;
  }
  reject(reason) {
    const s = this.read();
    assert(s.phase === 'trial', 'Only an uncommitted trial can be rejected');
    const rejected = [...s.rejected.filter(r => r.id !== s.selected.id), { id: s.selected.id, reason, at: this.now() }];
    const next = { ...s, phase: 'recovering', failed: s.selected, selected: s.good, generation: this.nonce(), rejected };
    durableWrite(this.file, next); return next;
  }
  recoverInterrupted() {
    const s = this.read();
    if (s.phase === 'trial') return this.reject('interrupted before promotion');
    return s;
  }
  finishRecovery(healthy) {
    const s = this.read(); assert(s.phase === 'recovering', 'No recovery in progress');
    s.phase = healthy ? 'stable' : 'blocked'; s.generation = null;
    if (!healthy) s.error = 'Recovery version could not start; automatic retries stopped';
    durableWrite(this.file, s); return s;
  }
}

/** Shared-profile automation is conservative: database/plugin/runtime changes require a separate handover. */
export function compatibility(current, candidate) {
  const reasons = [];
  for (const [key, label] of [['migrations', 'database migrations'], ['plugins', 'plugin installation'], ['runtime', 'runtime dependencies'], ['dataCode', 'persistent data implementation']]) {
    if (!current[key] || !candidate[key] || current[key] !== candidate[key]) reasons.push(label);
  }
  if (candidate.dbScript) reasons.push('explicit database script');
  return { compatible: reasons.length === 0, reasons };
}
