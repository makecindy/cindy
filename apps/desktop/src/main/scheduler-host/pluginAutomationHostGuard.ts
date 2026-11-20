import { randomUUID } from 'node:crypto';
import type { FireContext, Schedule, ScheduleRunner } from '@cindy/maker-scheduler';

interface Account {
  run(action: 'acquire' | 'renew' | 'release', runId: string, signal?: AbortSignal): Promise<{ granted?: boolean; validForMs?: number }>;
}

export function primaryHostTargetIsRemote(schedule: Pick<Schedule, 'primaryHostKey'>,
  target?: { agentDeviceId?: string | null; remoteHostId?: string | null } | null): boolean {
  return !!schedule.primaryHostKey && !!(target?.agentDeviceId || target?.remoteHostId);
}

export function skipPrimaryHostRun(ctx: FireContext, resultText: string, sessionId = '') {
  // An interrupted run already owns its session and cost history. Reject before enqueue
  // so the scheduler restores that same interrupted record for a later Continue.
  if (ctx.resumeSessionId) throw new Error(resultText);
  return { skipped: true, sessionId, resultText };
}

export function withPluginAutomationHost(runner: ScheduleRunner, accountFor?: (key: string) => Account): ScheduleRunner {
  return { async fire(schedule, ctx) {
    if (!schedule.primaryHostKey) return runner.fire(schedule, ctx);
    const modelDeviceId = schedule.modelAgentDeviceId ?? schedule.agentDeviceId;
    if (!accountFor || modelDeviceId || (schedule.targetSessionId && !schedule.persistentSession)) {
      return skipPrimaryHostRun(ctx, 'This automation needs its selected execution computer.');
    }
    return runOnPrimary(runner, schedule, ctx, accountFor(schedule.primaryHostKey));
  } };
}

async function runOnPrimary(runner: ScheduleRunner, schedule: Schedule, ctx: FireContext, account: Account) {
  const runId = randomUUID();
  const stop = new AbortController();
  const signal = AbortSignal.any([ctx.signal, stop.signal]);
  let deadline = 0;
  let monotonicDeadline = 0;
  const remaining = () => Math.min(deadline - Date.now(), monotonicDeadline - performance.now());
  let renewTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  // Count from before the request, leaving a margin before the server releases a disconnected host.
  async function extend(action: 'acquire' | 'renew') {
    const started = Date.now();
    const startedMono = performance.now();
    const lease = await account.run(action, runId, signal);
    if (finished || signal.aborted || lease.granted !== true || typeof lease.validForMs !== 'number' ||
        !Number.isFinite(lease.validForMs) || lease.validForMs <= 5000 || lease.validForMs > 120_000) return false;
    const until = started + lease.validForMs - 5000;
    const untilMono = startedMono + lease.validForMs - 5000;
    if (Date.now() >= until || performance.now() >= untilMono || (action === 'renew' && remaining() <= 0)) return false;
    deadline = until;
    monotonicDeadline = untilMono;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => stop.abort(), remaining());
    renewTimer = setTimeout(() => {
      void extend('renew').then(ok => { if (!ok) stop.abort(); }, () => stop.abort());
    }, Math.max(1, Math.floor(remaining() / 3)));
    return true;
  }
  ctx.signal.throwIfAborted();
  ctx.assertFireContext?.();
  let granted: boolean;
  try {
    granted = await extend('acquire');
  } catch {
    ctx.signal.throwIfAborted();
    return skipPrimaryHostRun(ctx, 'The primary computer could not be confirmed. This run was skipped.');
  }
  if (!granted) return skipPrimaryHostRun(ctx, 'Only the selected primary computer can start this automation.');
  const valid = () => !signal.aborted && remaining() > 0;
  try {
    ctx.assertFireContext?.();
    if (!valid() || ctx.canDispatch?.() === false) return skipPrimaryHostRun(ctx, 'The execution context has changed.');
    return await runner.fire(schedule, { ...ctx, signal, canDispatch: () => valid() && (ctx.canDispatch?.() ?? true),
      assertFireContext() {
        ctx.assertFireContext?.();
        if (!valid()) { stop.abort(); throw new DOMException('Automation host lease expired', 'AbortError'); }
      } });
  } finally {
    finished = true;
    clearTimeout(renewTimer);
    clearTimeout(expiryTimer);
    stop.abort();
    // Failure leaves a bounded lease. Another account or an old caller cannot release a newer run.
    await account.run('release', runId).catch(() => {});
  }
}
