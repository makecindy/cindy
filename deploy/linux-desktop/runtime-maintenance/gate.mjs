import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const ingresses = Object.freeze(['agent-input', 'agent-dispatch', 'scheduler', 'remote-input', 'plugin-work']);
export function digest(value) {
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
const integer = v => Number.isSafeInteger(v) && v >= 0;
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const bindingKeys = ['instanceId', 'deviceId', 'statefulSetUid', 'pvcUid'];
export function validBinding(v) {
  return v && Object.keys(v).sort().join() === [...bindingKeys].sort().join() && bindingKeys.every(k => id(v[k]));
}
export function validCommand(v) {
  const keys = [...bindingKeys, 'version', 'operationId', 'epoch', 'sequence', 'action', 'sourcePodUid',
    'sourceBootId', 'targetDigest', 'policyDigest', 'windowEndAt', 'expiresAt', 'expectedReceiptDigest'];
  return v && Object.keys(v).sort().join() === keys.sort().join() && v.version === 1
    && bindingKeys.every(k => id(v[k])) && ['operationId', 'sourcePodUid', 'sourceBootId'].every(k => id(v[k]))
    && integer(v.epoch) && v.epoch > 0 && integer(v.sequence) && v.sequence > 0
    && ['prepare', 'seal', 'cancel', 'release'].includes(v.action)
    && typeof v.targetDigest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(v.targetDigest)
    && sha(v.policyDigest) && sha(v.expectedReceiptDigest) && integer(v.windowEndAt) && integer(v.expiresAt);
}
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { fs.rmSync(tmp, { force: true }); }
}
export function readJson(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const s = fs.fstatSync(fd); if (!s.isFile() || s.size > 16384) throw new Error('MAINTENANCE_FILE_INVALID');
    return JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
}
const blocked = () => Object.assign(new Error('CLOUD_MAINTENANCE_RETRY: maintenance is in progress; request was not queued'),
  { code: 'CLOUD_MAINTENANCE_RETRY', retryable: true });

/** All admissions and the final seal check are synchronous on the Host thread.
 * No accepted new-request queue: callers receive an explicit retryable rejection.
 * The durable ledger is on the PVC, outside rollbackable business databases.
 */
export function createMaintenanceGate({ binding, podUid, ledgerFile, now = Date.now,
  bootId = randomUUID(), save = atomicJson, load = readJson, coverage = [] }) {
  if (!validBinding(binding) || !id(podUid) || !id(bootId)) throw new Error('MAINTENANCE_IDENTITY_INVALID');
  let state = { version: 1, binding, phase: 'open', command: null, commandDigest: null };
  let fault = false, inFlight = 0, activityRevision = 0, quietSinceMs = null, heartbeatSequence = 0;
  let sample = null, sampleRevision = -1;
  const inherited = new AsyncLocalStorage();
  try {
    const saved = load(ledgerFile);
    if (saved.version !== 1 || digest(saved.binding) !== digest(binding)
      || !['open', 'preparing', 'sealed', 'released', 'cancelled'].includes(saved.phase)
      || (saved.command !== null && (!validCommand(saved.command) || digest(saved.command) !== saved.commandDigest))
      || (saved.command === null && saved.phase !== 'open')) throw new Error('MAINTENANCE_LEDGER_INVALID');
    state = saved;
    // Preparing on another boot is not authority to reopen or to seal it.
    if (state.phase === 'preparing' && state.command?.sourceBootId !== bootId) fault = true;
  } catch (e) { if (e.code !== 'ENOENT') fault = true; }
  function persist(next) {
    // Close admission before attempting I/O; failure never opens the gate.
    fault = true;
    save(ledgerFile, next);
    state = next; fault = false; activityRevision++; quietSinceMs = null;
  }
  function phase() { return fault ? 'recovery-hold' : state.phase; }
  const closed = () => fault || state.phase === 'sealed';
  function touch() { activityRevision++; quietSinceMs = null; }
  function admit(kind, existing = false) {
    if (closed() || (state.phase === 'preparing' && !existing && !inherited.getStore()?.active)) throw blocked();
    touch();
  }
  function run(kind, fn, existing = false) {
    admit(kind, existing); inFlight++;
    const context = { active: true };
    const done = () => { context.active = false; inFlight--; touch(); };
    try {
      const result = inherited.run(context, fn);
      if (result && typeof result.then === 'function') return Promise.resolve(result).finally(done);
      done(); return result;
    } catch (e) { done(); throw e; }
  }
  function observe(value, revision) {
    const at = now();
    const valid = value && integer(value.atMs) && value.atMs <= at && at - value.atMs <= 15000
      && ['active', 'legacyQueued', 'unknown'].every(k => integer(value[k]))
      && (value.nextWakeAtMs === null || integer(value.nextWakeAtMs));
    sample = valid ? value : null; sampleRevision = revision;
    if (!valid || revision !== activityRevision || inFlight || value.active || value.legacyQueued || value.unknown) quietSinceMs = null;
    else if (quietSinceMs === null) quietSinceMs = at;
  }
  function canSeal() {
    return !fault && state.phase === 'preparing' && sample && sampleRevision === activityRevision
      && now() >= sample.atMs && now() - sample.atMs <= 15000 && !inFlight
      && !sample.active && !sample.legacyQueued && !sample.unknown
      && quietSinceMs !== null && now() - quietSinceMs >= 10000
      && ingresses.every(k => coverage.includes(k));
  }
  const stateDigest = () => digest({ state, podUid, bootId });
  function accept(command) {
    if (!validCommand(command) || bindingKeys.some(k => command[k] !== binding[k])) throw blocked();
    const cmdDigest = digest(command), previous = state.command;
    if (!fault && cmdDigest === state.commandDigest) return; // projection retries are idempotent
    if (command.expiresAt <= now() || command.expiresAt > now() + 15 * 60_000
      || command.expectedReceiptDigest !== stateDigest()) throw blocked();
    if (previous && (command.epoch < previous.epoch || (command.epoch === previous.epoch
      && (command.operationId !== previous.operationId || command.sequence !== previous.sequence + 1)))) throw blocked();
    if (command.action === 'prepare') {
      if (fault || !['open', 'cancelled', 'released'].includes(state.phase) || command.sequence !== 1
        || (previous && command.epoch <= previous.epoch) || command.sourcePodUid !== podUid
        || command.sourceBootId !== bootId || command.windowEndAt - now() < 20 * 60_000) throw blocked();
      persist({ ...state, phase: 'preparing', command, commandDigest: cmdDigest }); return;
    }
    if (!previous || command.operationId !== previous.operationId || command.epoch !== previous.epoch
      || ['targetDigest', 'policyDigest', 'windowEndAt', 'sourcePodUid', 'sourceBootId'].some(k => previous[k] !== command[k])) throw blocked();
    if (command.action === 'seal') {
      if (command.sourceBootId !== bootId || command.sourcePodUid !== podUid || !canSeal()
        || now() >= previous.expiresAt || command.windowEndAt - now() < 20 * 60_000) throw blocked();
      persist({ ...state, phase: 'sealed', command, commandDigest: cmdDigest }); return;
    }
    if (command.action === 'cancel') {
      // Never cancel a sealed operation on the replacement Pod.
      if (!['preparing', 'sealed'].includes(state.phase) || command.sourcePodUid !== podUid
        || command.sourceBootId !== bootId || fault) throw blocked();
      persist({ ...state, phase: 'cancelled', command, commandDigest: cmdDigest }); return;
    }
    if (state.phase !== 'sealed' || fault || command.sourceBootId === bootId || command.sourcePodUid === podUid) throw blocked();
    // The controller checks actual candidate image/identity before issuing release.
    persist({ ...state, phase: 'released', command, commandDigest: cmdDigest });
  }
  return {
    hold() { fault = true; touch(); },
    // Scheduler housekeeping may be async without starting a task. Track it so
    // seal cannot overtake a DB claim/replan, without manufacturing busy forever
    // on an otherwise idle periodic tick. A scan crossing an observation still
    // invalidates that observation via the activity revision.
    async scan(fn) {
      if (closed()) return;
      inFlight++; activityRevision++;
      try { return await fn(); } finally { inFlight--; activityRevision++; }
    },
    run, admit, phase, accept, observe, revision: () => activityRevision,
    // The replacement boot starts sealed. Preserve a valid persisted due fire
    // instead of startup normalization advancing it past the maintenance outage.
    // Invalid/manual/completed one-shot schedules still use the scheduler's result.
    restoreScheduleWake(schedule, computed, at) {
      return !fault && state.phase === 'sealed' && computed !== undefined
        && integer(schedule.nextFireAt) && schedule.nextFireAt <= at
        ? schedule.nextFireAt : computed;
    },
    schedulerAllowed() { return !closed(); }, // protect: do not suppress due work during prepare
    receipt() {
      if (!fault && state.phase === 'preparing' && now() >= state.command.expiresAt) {
        persist({ ...state, phase: 'cancelled' });
      }
      const fresh = sample && sampleRevision === activityRevision && now() >= sample.atMs && now() - sample.atMs <= 15000;
      return { version: 1, ...binding, podUid, bootId, phase: phase(),
        operationId: state.command?.operationId ?? null, epoch: state.command?.epoch ?? 0,
        sequence: state.command?.sequence ?? 0, commandDigest: state.commandDigest,
        stateDigest: stateDigest(), heartbeatAtMs: now(), heartbeatSequence: ++heartbeatSequence,
        quietSinceMs, counts: { active: fresh ? sample.active : 0, legacyQueued: fresh ? sample.legacyQueued : 0,
          deferred: 0, inFlight, unknown: fresh && !fault ? sample.unknown : 1 },
        scheduleAdmission: 'running-only', nextWakeAtMs: fresh ? sample.nextWakeAtMs : null, ingresses: [...coverage], deferredTasks: false };
    },
  };
}

export const shutdownReasons = Object.freeze(['before-quit', 'signal:SIGTERM']);
/** Clean-shutdown evidence, or null. Issued only after every registered quit
 * step finished in time without error, for a sealed operation with nothing in
 * flight, and only for an orderly quit. A crash, SIGKILL or timed-out step
 * leaves no evidence, so a stopped volume without it is never backed up. */
export function shutdownEvidence(receipt, { reason, faults, now }) {
  if (!shutdownReasons.includes(reason) || faults !== 0 || receipt?.phase !== 'sealed' || !id(receipt.operationId)
    || !sha(receipt.commandDigest) || !integer(receipt.epoch) || receipt.epoch < 1 || receipt.counts?.inFlight !== 0) return null;
  return { version: 1, clean: true, instanceId: receipt.instanceId, deviceId: receipt.deviceId,
    statefulSetUid: receipt.statefulSetUid, pvcUid: receipt.pvcUid, podUid: receipt.podUid, bootId: receipt.bootId,
    operationId: receipt.operationId, epoch: receipt.epoch, sequence: receipt.sequence, commandDigest: receipt.commandDigest,
    reason, completedAtMs: now };
}

/** Maintenance protects actual work; the ordinary idle/suspend probe still
 * treats an imminent wake as a blocker. Keep all unknown/queue/input evidence. */
export function maintenanceActivitySample(observation) {
  const blockers = observation?.idle?.blockers ?? ['activity-unknown'];
  return {
    atMs: observation?.cloudActivity?.observedAtMs,
    active: blockers.filter(v => v !== 'idle-grace' && v !== 'scheduler-next-wake' && !v.endsWith('-unknown')).length,
    legacyQueued: observation?.inputCounts?.queued,
    unknown: observation?.isCurrent?.() === true && !blockers.some(v => v.includes('unknown')) ? 0 : 1,
    nextWakeAtMs: observation?.idle?.nextWakeAtMs ?? null,
  };
}
