// Cloud packaging only. Activity observations are not a restart/drain lease.
export const taskProbes = Object.freeze({
  anySessionInTurn: 'active-turn',
  listClaudeBackgroundSessions: 'claude-background-activity',
  anyGhostSessionBusy: 'ghost-background-activity',
  anyBackgroundBashRunning: 'background-bash',
  anyCindySlotJobRunning: 'cindy-slot-job',
  anyPiSubagentRunning: 'pi-subagent',
});

const validTime = value => Number.isSafeInteger(value) && value >= 0;
const validCount = validTime;
const unique = values => [...new Set(values)];

/** Do not confuse missing methods, failed reads, or malformed values with false. */
export function readTaskProbes(sources) {
  const blockers = [];
  for (const [method, label] of Object.entries(taskProbes)) {
    try {
      const value = sources[method]();
      if (method === 'listClaudeBackgroundSessions') {
        if (!Array.isArray(value)) throw new Error('invalid probe');
        if (value.length) blockers.push(label);
      } else {
        if (typeof value !== 'boolean') throw new Error('invalid probe');
        if (value) blockers.push(label);
      }
    } catch { blockers.push(`${label}-unknown`); }
  }
  return blockers;
}

/** A claimed automatic fire has no next wake until it finishes. Only a matching
 * live attempt explains that absence; an orphaned/malformed schedule stays unknown. */
export function nextScheduleWake(schedules, automaticInFlightScheduleIds = []) {
  if (!Array.isArray(schedules)) throw new Error('schedule metadata unavailable');
  if (!Array.isArray(automaticInFlightScheduleIds)
    || automaticInFlightScheduleIds.some(id => typeof id !== 'string' || !id)) throw new Error('invalid running schedules');
  const claimed = new Set(automaticInFlightScheduleIds);
  let earliest = null;
  for (const item of schedules) {
    if (!item || typeof item.status !== 'string' || typeof item.manual !== 'boolean') throw new Error('invalid schedule');
    if (item.status !== 'active' || item.manual) continue;
    if (item.nextFireAt == null && claimed.has(item.id)) continue;
    if (!validTime(item.nextFireAt)) throw new Error('schedule time unavailable');
    earliest = earliest === null ? item.nextFireAt : Math.min(earliest, item.nextFireAt);
  }
  return earliest;
}

/** Retain attempts on both sides of the async DB read: a run can finish and
 * replan while listActive is returning its previously claimed (empty) wake. */
export async function readSchedulerActivity(getScheduler, getStorage) {
  const scheduler = getScheduler(), storage = getStorage();
  if (!scheduler || !storage) throw new Error('cloud scheduler not ready');
  const before = scheduler.getRuntimeSnapshot();
  const schedules = await storage.listActive();
  if (scheduler !== getScheduler() || storage !== getStorage()) throw new Error('cloud scheduler changed');
  const after = scheduler.getRuntimeSnapshot();
  const claimed = new Set();
  for (const snapshot of [before, after]) {
    if (!validCount(snapshot?.inFlight) || !Array.isArray(snapshot.inFlightRuns)
      || snapshot.inFlightRuns.length !== snapshot.inFlight || !Array.isArray(snapshot.waitingSchedules))
      throw new Error('invalid scheduler runtime');
    for (const run of snapshot.inFlightRuns) {
      if (typeof run?.scheduleId !== 'string' || !run.scheduleId || !['automatic', 'run-now'].includes(run.source))
        throw new Error('invalid scheduler attempt');
      if (run.source === 'automatic') claimed.add(run.scheduleId);
    }
  }
  return { inFlight: Math.max(before.inFlight, after.inFlight),
    waiting: Math.max(before.waitingSchedules.length, after.waitingSchedules.length),
    automaticInFlightScheduleIds: [...claimed],
    schedules: schedules.map(s => ({ id: s.id, status: s.status, manual: s.manual, nextFireAt: s.nextFireAt })) };
}

/** Count metadata only; never serialize queued prompts or interaction contents. */
export function inputActivityBlockers(value) {
  const blockers = [];
  for (const [key, label] of [
    ['active', 'input-dispatch'], ['queued', 'pending-input'],
    ['interactions', 'pending-interaction'], ['settling', 'input-settling'],
  ]) {
    if (!validCount(value?.[key])) blockers.push(`${label}-unknown`);
    else if (value[key] > 0) blockers.push(label);
  }
  return blockers;
}

/** One outstanding async scan at a time; a timeout never starts unbounded work. */
export function createActivityReader({ resolveSources, readContext, readInput, readScheduler,
  remoteInvokeBusy, now = Date.now, timeoutMs = 1_000, quietMs = 10_000 }) {
  let outstanding = null;
  let lastBusyAtMs = now();
  let quietSince = null;
  let stopped = false;
  let revision = 0;
  let previousOwner = null;

  function result(blockers, observedAtMs, nextWakeAtMs = null) {
    blockers = unique(blockers);
    const failed = blockers.some(v => v.endsWith('-unknown'));
    if (failed) blockers.unshift('activity-unknown');
    const busy = blockers.length > 0;
    if (busy) { lastBusyAtMs = observedAtMs; quietSince = null; }
    else {
      if (quietSince === null) quietSince = observedAtMs;
      if (observedAtMs < quietSince || observedAtMs - quietSince < quietMs) blockers.push('idle-grace');
    }
    const observedOwner = previousOwner;
    const observedRevision = revision;
    return {
      // Reporting task idleness does not opt instances into automatic suspension.
      idle: { maySuspend: false, blockers, lastBusyAtMs, nextWakeAtMs },
      cloudActivity: { version: 1, state: failed ? 'unknown' : blockers.length ? 'busy' : 'idle', observedAtMs },
      isCurrent() {
        try { return !stopped && revision === observedRevision && observedOwner !== null && context() === observedOwner; }
        catch { return false; }
      },
    };
  }

  function context() {
    const value = readContext();
    if (!value || value.ready !== true || typeof value.owner !== 'string' || !value.owner) throw new Error('context unavailable');
    return value.owner;
  }
  function sync(sources) {
    const blockers = readTaskProbes(sources);
    try { blockers.push(...inputActivityBlockers(readInput())); }
    catch { blockers.push('input-unknown'); }
    try {
      const busy = remoteInvokeBusy();
      if (typeof busy !== 'boolean') throw new Error('invalid invoke state');
      if (busy) blockers.push('remote-invoke');
    } catch { blockers.push('remote-invoke-unknown'); }
    return blockers;
  }

  return {
    stop() { stopped = true; revision++; },
    async read() {
      const started = now();
      if (stopped) return result(['stopping-unknown'], started);
      if (outstanding) return result(['collector-pending-unknown'], started);
      let owner, sources;
      try { owner = context(); sources = resolveSources(); }
      catch { return result(['sources-unknown'], started); }
      if (owner !== previousOwner) { previousOwner = owner; quietSince = null; lastBusyAtMs = started; }
      const generation = revision;
      const first = sync(sources);
      const job = (async () => {
        const blockers = [...first];
        let nextWakeAtMs = null;
        try {
          const running = await sources.anySchedulerRunRunning();
          if (typeof running !== 'boolean') throw new Error('invalid scheduler state');
          if (running) blockers.push('scheduler-running');
          const schedule = await readScheduler();
          if (!validCount(schedule?.inFlight) || !validCount(schedule?.waiting)) throw new Error('invalid scheduler metadata');
          if (schedule.inFlight) blockers.push('scheduler-in-flight');
          if (schedule.waiting) blockers.push('scheduler-waiting');
          nextWakeAtMs = nextScheduleWake(schedule.schedules, schedule.automaticInFlightScheduleIds);
          if (nextWakeAtMs !== null && nextWakeAtMs <= now() + 120_000) blockers.push('scheduler-next-wake');
        } catch { blockers.push('scheduler-unknown'); }
        // Detect work arriving while asynchronous metadata reads were in progress.
        try {
          if (context() !== owner || resolveSources() !== sources) blockers.push('owner-changed-unknown');
        } catch { blockers.push('owner-changed-unknown'); }
        blockers.push(...sync(sources));
        return { blockers, nextWakeAtMs };
      })();
      outstanding = job;
      void job.finally(() => { if (outstanding === job) outstanding = null; }).catch(() => {});
      let timer;
      const timedOut = Symbol('timeout');
      try {
        const scan = await Promise.race([job, new Promise(resolve => {
          timer = setTimeout(() => resolve(timedOut), timeoutMs);
        })]);
        const completed = now();
        if (stopped || revision !== generation) return result(['stopping-unknown'], completed);
        if (scan === timedOut) return result(['collector-timeout-unknown'], completed);
        if (!validTime(started) || !validTime(completed) || completed < started || completed - started > timeoutMs)
          return result(['collector-stale-unknown'], completed);
        return result(scan.blockers, completed, scan.nextWakeAtMs);
      } catch { return result(['collector-failed-unknown'], now()); }
      finally { clearTimeout(timer); }
    },
  };
}
