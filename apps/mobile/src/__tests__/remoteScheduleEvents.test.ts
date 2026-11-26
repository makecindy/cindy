import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRemoteScheduleTimingsToIndex,
  remoteScheduleEventStore,
} from '@/scheduler/remoteScheduleEvents';
import {
  getScheduleIndexInvalidationVersion,
  loadSessionScheduleIndexThrottled,
  loadSharedSessionScheduleIndex,
  resetScheduleIndexThrottleForTesting,
} from '@/session/scheduleIndex';

describe('remote schedule event store', () => {
  beforeEach(() => {
    remoteScheduleEventStore.clearAll();
    resetScheduleIndexThrottleForTesting();
  });

  it('invalidates once before consumers reload and preserves unrelated device caches', async () => {
    const load = vi.fn(async () => new Map());
    const loadOther = vi.fn(async () => new Map());
    await loadSessionScheduleIndexThrottled('dev-1', load);
    await loadSessionScheduleIndexThrottled('dev-2', loadOther);
    const requests: Promise<unknown>[] = [];
    const off = remoteScheduleEventStore.subscribe(() => {
      requests.push(loadSessionScheduleIndexThrottled('dev-1', load));
      requests.push(loadSessionScheduleIndexThrottled('dev-1', load));
    });
    try {
      remoteScheduleEventStore.apply('dev-1', { type: 'read', scheduleId: 'sched-1' });
      await Promise.all(requests);
      await loadSessionScheduleIndexThrottled('dev-2', loadOther);
      expect(load).toHaveBeenCalledTimes(2);
      expect(loadOther).toHaveBeenCalledTimes(1);
      expect(getScheduleIndexInvalidationVersion('dev-1')).toBe(1);
    } finally { off(); }
  });

  it('preserves a completed-event probe while read feedback does not request another probe', () => {
    const probeVersion = () => {
      const state = remoteScheduleEventStore.getSnapshot('dev-1');
      return state.unreadVersion - state.unreadClearVersion;
    };
    remoteScheduleEventStore.apply('dev-1', { type: 'completed', scheduleId: 'sched-1', runId: 'run-1', sessionId: 'task-1' });
    const completedVersion = probeVersion();
    expect(completedVersion).toBeGreaterThan(0);
    remoteScheduleEventStore.apply('dev-1', { type: 'read', scheduleId: 'sched-1' });
    remoteScheduleEventStore.apply('dev-1', { type: 'all-read' });
    expect(probeVersion()).toBe(completedVersion);
  });

  it('increments per-device versions for pushed schedule events', () => {
    const sub = vi.fn();
    const off = remoteScheduleEventStore.subscribe(sub);

    remoteScheduleEventStore.apply('dev-1', { type: 'changed', scheduleId: 'sched-1' });
    remoteScheduleEventStore.apply('dev-1', { type: 'fired', scheduleId: 'sched-1', runId: 'run-1' });
    remoteScheduleEventStore.apply('dev-2', { type: 'ready' });

    expect(remoteScheduleEventStore.getVersion('dev-1')).toBe(2);
    expect(remoteScheduleEventStore.getVersion('dev-2')).toBe(1);
    expect(remoteScheduleEventStore.getSnapshot('dev-1')).toMatchObject({
      runsVersion: 2,
      scheduleListVersion: 1,
      // changed 与 fired 都会重拉侧栏索引(fired:认领清空了下次运行时间并插入运行中)。
      sessionIndexVersion: 2,
      unreadVersion: 1,
      version: 2,
    });
    expect(remoteScheduleEventStore.getSnapshot('dev-2')).toMatchObject({
      runsVersion: 0,
      scheduleListVersion: 1,
      // ready:宿主冷启 / 切账号后重标中断、重算下次运行,索引一并重拉。
      sessionIndexVersion: 1,
      unreadVersion: 0,
      version: 1,
    });
    expect(sub).toHaveBeenCalledTimes(3);

    off();
  });

  it('publishes mirror invalidation even without an existing schedule event snapshot', () => {
    const before = remoteScheduleEventStore.getMirrorInvalidationSnapshot();
    const sub = vi.fn();
    const off = remoteScheduleEventStore.subscribe(sub);

    remoteScheduleEventStore.invalidateDeviceMirror('dev-1');

    const afterFirst = remoteScheduleEventStore.getMirrorInvalidationSnapshot();
    expect(afterFirst).not.toBe(before);
    expect(afterFirst.get('dev-1')).toBeGreaterThan(0);
    expect(remoteScheduleEventStore.getVersion('dev-1')).toBe(0);
    expect(sub).toHaveBeenCalledTimes(1);

    remoteScheduleEventStore.invalidateDeviceMirror('dev-1');
    const afterSecond = remoteScheduleEventStore.getMirrorInvalidationSnapshot();
    expect(afterSecond).toBe(afterFirst);
    expect(sub).toHaveBeenCalledTimes(1);

    off();
  });

  it.each([40, 80, 100])('batch-invalidates %i devices with a single notification', (count) => {
    const sub = vi.fn();
    const off = remoteScheduleEventStore.subscribe(sub);
    const deviceIds = Array.from({ length: count }, (_, i) => `wave-dev-${i}`);

    remoteScheduleEventStore.invalidateDeviceMirrors(deviceIds);

    // 整波只 notify 一轮,而不是逐台 N 轮——逐台通知在设备数超过 React 嵌套
    // 更新上限时致命退出(2026-09-10 Android 冷启动,40/80 台隔离复现)。
    expect(sub).toHaveBeenCalledTimes(1);
    const snapshot = remoteScheduleEventStore.getMirrorInvalidationSnapshot();
    expect(snapshot.size).toBe(count);
    for (const deviceId of deviceIds) expect(snapshot.get(deviceId)).toBeGreaterThan(0);

    // Repeated offline verdicts without fresh data are not new transitions.
    remoteScheduleEventStore.invalidateDeviceMirrors(deviceIds);
    expect(sub).toHaveBeenCalledTimes(1);
    expect(remoteScheduleEventStore.getMirrorInvalidationSnapshot()).toBe(snapshot);

    off();
  });

  it('re-arms after a fresh event or recovery, with monotonic generations', () => {
    remoteScheduleEventStore.invalidateDeviceMirrors(['a', 'a', '', 'b']);
    const first = remoteScheduleEventStore.getMirrorInvalidationSnapshot();
    const notify = vi.fn();
    const off = remoteScheduleEventStore.subscribe(notify);
    try {
      for (let i = 0; i < 100; i++) remoteScheduleEventStore.invalidateDeviceMirrors(['a', 'b']);
      expect(notify).not.toHaveBeenCalled();
      expect(remoteScheduleEventStore.getMirrorInvalidationSnapshot()).toBe(first);
      remoteScheduleEventStore.apply('a', { type: 'ready' });
      remoteScheduleEventStore.invalidateDeviceMirrors(['a', 'b']);
      const second = remoteScheduleEventStore.getMirrorInvalidationSnapshot();
      expect(second.get('a')).toBeGreaterThan(first.get('a')!);
      expect(second.get('b')).toBe(first.get('b'));
      expect(remoteScheduleEventStore.getVersion('a')).toBe(0);
      expect(notify).toHaveBeenCalledTimes(2);
      remoteScheduleEventStore.clearDeviceMirrorInvalidation('a');
      remoteScheduleEventStore.invalidateDeviceMirror('a');
      expect(remoteScheduleEventStore.getMirrorInvalidationSnapshot().get('a')).toBeGreaterThan(second.get('a')!);
      expect(notify).toHaveBeenCalledTimes(4);
      remoteScheduleEventStore.clearDevice('a');
      expect(remoteScheduleEventStore.getMirrorInvalidationSnapshot().has('a')).toBe(true);
    } finally { off(); }
  });

  it('projects run lifecycle and read events into targeted refresh versions', () => {
    remoteScheduleEventStore.apply('dev-1', { type: 'fired', scheduleId: 'sched-1', runId: 'run-1' });
    expect(remoteScheduleEventStore.getSnapshot('dev-1')).toMatchObject({
      runsVersion: 1,
      scheduleListVersion: 0,
      sessionIndexVersion: 1,
      unreadVersion: 0,
    });

    remoteScheduleEventStore.apply('dev-1', {
      type: 'completed',
      scheduleId: 'sched-1',
      runId: 'run-1',
      sessionId: 'chat-1',
    });
    expect(remoteScheduleEventStore.getSnapshot('dev-1')).toMatchObject({
      runsVersion: 2,
      scheduleListVersion: 0,
      sessionIndexVersion: 2,
      unreadVersion: 1,
    });
    expect(remoteScheduleEventStore.getSnapshot('dev-1').lastProjection).toMatchObject({
      runPatch: {
        scheduleId: 'sched-1',
        runId: 'run-1',
        sessionId: 'chat-1',
        status: 'terminal',
      },
      unreadImpact: 'may-increase',
    });

    remoteScheduleEventStore.apply('dev-1', { type: 'all-read' });
    expect(remoteScheduleEventStore.getSnapshot('dev-1')).toMatchObject({
      runsVersion: 3,
      sessionIndexVersion: 3,
      unreadVersion: 2,
    });
    expect(remoteScheduleEventStore.getSnapshot('dev-1').lastProjection?.refresh.runRefresh).toEqual({ mode: 'all' });
  });

  it('ignores runtime-state diagnostics without invalidating, notifying, or replacing the last projection', () => {
    remoteScheduleEventStore.apply('dev-1', {
      type: 'completed', scheduleId: 'sched-1', runId: 'run-1', sessionId: 'chat-1',
    });
    const before = remoteScheduleEventStore.getSnapshot('dev-1');
    const invalidationVersion = getScheduleIndexInvalidationVersion('dev-1');
    const sub = vi.fn();
    const off = remoteScheduleEventStore.subscribe(sub);
    try {
      remoteScheduleEventStore.apply('dev-1', { type: 'runtime-state', snapshot: { inFlight: 0 } });
      expect(sub).not.toHaveBeenCalled();
      expect(remoteScheduleEventStore.getSnapshot('dev-1')).toBe(before);
      expect(getScheduleIndexInvalidationVersion('dev-1')).toBe(invalidationVersion);

      // 未知的新类型仍走保守的全量刷新。
      remoteScheduleEventStore.apply('dev-1', { type: 'future-event' });
      expect(sub).toHaveBeenCalledTimes(1);
      expect(getScheduleIndexInvalidationVersion('dev-1')).toBe(invalidationVersion + 1);
      expect(remoteScheduleEventStore.getSnapshot('dev-1')).toMatchObject({
        runsVersion: before.runsVersion + 1,
        scheduleListVersion: before.scheduleListVersion + 1,
        sessionIndexVersion: before.sessionIndexVersion + 1,
        unreadVersion: before.unreadVersion + 1,
      });
    } finally { off(); }
  });

  it('unreadClearVersion 只随未读清除类事件(read / all-read)递增', () => {
    // fired / completed 属非清除类(none / may-increase),不 bump。
    remoteScheduleEventStore.apply('dev-1', { type: 'fired', scheduleId: 'sched-1', runId: 'run-1' });
    remoteScheduleEventStore.apply('dev-1', {
      type: 'completed', scheduleId: 'sched-1', runId: 'run-1', sessionId: 'chat-1',
    });
    expect(remoteScheduleEventStore.getSnapshot('dev-1').unreadClearVersion).toBe(0);

    remoteScheduleEventStore.apply('dev-1', { type: 'read', scheduleId: 'sched-1', runIds: ['run-1'] });
    expect(remoteScheduleEventStore.getSnapshot('dev-1').unreadClearVersion).toBe(1);

    remoteScheduleEventStore.apply('dev-1', { type: 'all-read' });
    expect(remoteScheduleEventStore.getSnapshot('dev-1').unreadClearVersion).toBe(2);
  });

  it('clears stale device versions when a host disappears', () => {
    remoteScheduleEventStore.apply('dev-1', { type: 'changed', scheduleId: 'sched-1' });
    remoteScheduleEventStore.apply('dev-2', { type: 'changed', scheduleId: 'sched-2' });

    remoteScheduleEventStore.clearDevice('dev-1');
    expect(remoteScheduleEventStore.getVersion('dev-1')).toBe(0);
    expect(remoteScheduleEventStore.getVersion('dev-2')).toBe(1);

    remoteScheduleEventStore.clearAll();
    expect(remoteScheduleEventStore.getVersion('dev-2')).toBe(0);
    expect(remoteScheduleEventStore.getMirrorInvalidationSnapshot().size).toBe(0);
  });

  // 测试价值
  // - 生产入口与可观察结果：remoteScheduleEventStore.apply + loadSharedSessionScheduleIndex + applyRemoteScheduleTimingsToIndex 在「首次未加载/旧主机无时间戳」与「现代端跨 >=2 个 60s tick 稳态 skip + 兼容 changed 去重 + 掉帧恢复 + 失败恢复」下的真实请求计数与视图状态。
  // - 规则依据：docs/dev-rules/protocol-compatibility.md、docs/dev-rules/server-channel-review.md 与 docs/dev-rules/remote-and-mobile-adaptation.md。
  // - 现有覆盖缺口：既有测试未覆盖跨多个 60s tick 下现代手机 0 次 sessions:list、忽略同次 skippedRunId 兼容 changed、掉帧/首次加载兜底与失败恢复重拉。
  // - 最小失败输入：跨 2 个 60s tick 的 fired→skipped→+10s changed(skippedRunId) 流，外加掉帧 skipped、首次未种入索引和 failed→skipped(preRunCheckSucceeded:true)。
  // - tier：unit（集成消费管道计数对比）。
  it('eliminates sessions:list and duplicate compat-changed reads across >=2 60s skip ticks while preserving legacy reconciliation, dropped-frame, first-load, and failure recovery', async () => {
    // 0) First-load unseeded state: before loadSharedSessionScheduleIndex seeds the device record,
    // a patchable skipped still bumps sessionIndexVersion (and keeps sessionListVersion=0 for empty sessionId).
    remoteScheduleEventStore.apply('unseeded-host', {
      type: 'skipped',
      scheduleId: 'sched-first',
      runId: 'r-first',
      sessionId: '',
      lastFiredAt: 1_000,
      lastFinishedAt: 1_020,
      nextFireAt: 61_020,
    });
    expect(remoteScheduleEventStore.getSnapshot('unseeded-host')).toMatchObject({
      sessionIndexVersion: 1,
      sessionListVersion: 0,
      scheduleListVersion: 0,
    });

    // Old Host (skipped omits timestamps): still refreshes sessionIndex without touching sessionListVersion.
    remoteScheduleEventStore.apply('old-host', {
      type: 'skipped',
      scheduleId: 'sched-legacy',
      runId: 'r-old',
      sessionId: '',
    });
    expect(remoteScheduleEventStore.getSnapshot('old-host')).toMatchObject({
      sessionIndexVersion: 1,
      sessionListVersion: 0,
    });

    // Multi-tick (>= 2 × 60s) comparison between Modern Mobile (devices/[deviceId].tsx real version triggers)
    // and Legacy Mobile (pre-fix sessionIndexVersion -> loadSessions & non-deduped +10s changed).
    let hostNextFireAt = 60_000;
    let hostRunning = false;
    let hostFailedRun: { id: string; firedAt: number; finishedAt: number; errorMsg: string } | null = null;

    let modernSessionsListCalls = 0;
    let modernScheduleListCalls = 0;
    let modernIndexRunsCalls = 0;
    const maker = {
      schedule: {
        list: vi.fn(async () => {
          modernScheduleListCalls += 1;
          return [
            {
              id: 'sched-1',
              name: 'Follow PR',
              status: 'active',
              source: 'user',
              targetSessionId: 'sess-1',
              nextFireAt: hostRunning ? undefined : hostNextFireAt,
            },
          ] as never;
        }),
        listSidebarIndexRuns: vi.fn(async () => {
          modernIndexRunsCalls += 1;
          const runs: Array<Record<string, unknown>> = [
            {
              runId: 'r-init',
              scheduleId: 'sched-1',
              scheduleName: 'Follow PR',
              scheduleStatus: 'active',
              sessionId: 'sess-1',
              status: hostRunning ? 'running' : 'success',
              firedAt: 1_000,
              finishedAt: hostRunning ? undefined : 1_050,
              readAt: 1_050,
              nextFireAt: hostRunning ? undefined : hostNextFireAt,
            },
          ];
          if (hostFailedRun) {
            runs.push({
              runId: hostFailedRun.id,
              scheduleId: 'sched-1',
              scheduleName: 'Follow PR',
              scheduleStatus: 'active',
              sessionId: 'sess-1',
              status: 'failed',
              firedAt: hostFailedRun.firedAt,
              finishedAt: hostFailedRun.finishedAt,
              errorMsg: hostFailedRun.errorMsg,
              nextFireAt: hostRunning ? undefined : hostNextFireAt,
            });
          }
          return { runs } as never;
        }),
        listRuns: vi.fn(async () => []),
      },
    } as unknown as Parameters<typeof loadSharedSessionScheduleIndex>[1];

    let modernRawIndex = await loadSharedSessionScheduleIndex('modern-dev', maker);
    modernSessionsListCalls += 1; // initial mount loadSessions()
    let prevSnap = remoteScheduleEventStore.getSnapshot('modern-dev');
    const syncModernScreen = async () => {
      const snap = remoteScheduleEventStore.getSnapshot('modern-dev');
      if (snap.sessionListVersion > prevSnap.sessionListVersion) {
        modernSessionsListCalls += 1;
      }
      if (
        snap.sessionIndexVersion > prevSnap.sessionIndexVersion ||
        snap.scheduleListVersion > prevSnap.scheduleListVersion ||
        snap.unreadClearVersion > prevSnap.unreadClearVersion
      ) {
        modernRawIndex = await loadSharedSessionScheduleIndex('modern-dev', maker);
      }
      prevSnap = snap;
    };
    const modernEffectiveIndex = () =>
      applyRemoteScheduleTimingsToIndex(
        modernRawIndex,
        remoteScheduleEventStore.getSnapshot('modern-dev').scheduleTimings,
      );

    // Legacy Mobile baseline counters (pre-fix devices/[deviceId].tsx + ignoring skipped timings/skippedRunId):
    let legacySessionsListCalls = 0;
    let legacyChangedReconciles = 0;
    let legacyNextFireAt = 60_000;
    const applyLegacyEvent = (event: { type: string }) => {
      if (event.type === 'fired' || event.type === 'skipped' || event.type === 'failed') {
        legacySessionsListCalls += 1;
      } else if (event.type === 'changed') {
        legacySessionsListCalls += 1;
        legacyChangedReconciles += 1;
        legacyNextFireAt = hostNextFireAt;
      }
    };

    // Reset post-bootstrap counters before the 2 × 60s steady-state skip ticks.
    modernSessionsListCalls = 0;
    modernScheduleListCalls = 0;
    modernIndexRunsCalls = 0;

    // Steady-state Tick 1 (t = 60s -> +10s compat changed) and Tick 2 (t = 120s -> +10s compat changed)
    for (const [tickIdx, firedAt] of [60_000, 120_000].entries()) {
      const runId = `r-skip-${tickIdx + 1}`;
      hostRunning = true;
      const firedEvent = { type: 'fired', scheduleId: 'sched-1', runId };
      remoteScheduleEventStore.apply('modern-dev', firedEvent);
      await syncModernScreen();
      applyLegacyEvent(firedEvent);

      hostRunning = false;
      hostNextFireAt = firedAt + 60_000;
      const skippedEvent = {
        type: 'skipped',
        scheduleId: 'sched-1',
        runId,
        sessionId: '',
        lastFiredAt: firedAt,
        lastFinishedAt: firedAt + 25,
        nextFireAt: hostNextFireAt,
        preRunCheckSucceeded: true,
      };
      const indexCallsBeforeSkip = modernIndexRunsCalls;
      remoteScheduleEventStore.apply('modern-dev', skippedEvent);
      await syncModernScreen();
      applyLegacyEvent(skippedEvent);
      // Skipped itself triggered 0 index reads and 0 sessions:list reads, while patching nextFireAt & running=false in-place!
      expect(modernIndexRunsCalls).toBe(indexCallsBeforeSkip);
      expect(modernEffectiveIndex().get('sess-1')).toMatchObject({
        running: false,
        nextFireAt: hostNextFireAt,
      });

      // +10s delayed compatibility changed with skippedRunId: ignored by Modern Mobile, reconciled by Legacy Mobile.
      const compatChanged = { type: 'changed', scheduleId: 'sched-1', skippedRunId: runId };
      const versionBeforeCompatChanged = remoteScheduleEventStore.getVersion('modern-dev');
      remoteScheduleEventStore.apply('modern-dev', compatChanged);
      await syncModernScreen();
      applyLegacyEvent(compatChanged);
      expect(remoteScheduleEventStore.getVersion('modern-dev')).toBe(versionBeforeCompatChanged);
    }

    // Proof across 2 × 60s steady-state skip ticks:
    // - Modern Mobile did 0 sessions:list reads (vs Legacy 6) and 0 extra reads for skipped/+10s compat changed (only 2 fired index reads).
    // - Legacy Mobile executed 2 bounded +10s changed reconciliations and caught up to 180_000.
    expect(modernSessionsListCalls).toBe(0);
    expect(modernScheduleListCalls).toBe(2);
    expect(modernIndexRunsCalls).toBe(2);
    expect(modernEffectiveIndex().get('sess-1')?.nextFireAt).toBe(180_000);
    expect(legacyChangedReconciles).toBe(2);
    expect(legacySessionsListCalls).toBe(6);
    expect(legacyNextFireAt).toBe(180_000);

    // 3) Dropped skipped frame recovery: fired(r-drop) arrives, skipped(r-drop) is lost, +10s compat changed(skippedRunId='r-drop') arrives -> Modern Mobile reconciles!
    hostRunning = true;
    remoteScheduleEventStore.apply('modern-dev', { type: 'fired', scheduleId: 'sched-1', runId: 'r-drop' });
    await syncModernScreen();
    hostRunning = false;
    hostNextFireAt = 240_000;
    const indexCallsBeforeDropRecover = modernIndexRunsCalls;
    remoteScheduleEventStore.apply('modern-dev', {
      type: 'changed',
      scheduleId: 'sched-1',
      skippedRunId: 'r-drop',
    });
    await syncModernScreen();
    expect(modernIndexRunsCalls).toBe(indexCallsBeforeDropRecover + 1);
    expect(modernEffectiveIndex().get('sess-1')).toMatchObject({
      running: false,
      nextFireAt: 240_000,
    });

    // 4) Failure -> subsequent pre-run recovery skipped: reloads index & clears failure banner even before real changed arrives.
    hostFailedRun = { id: 'r-fail', firedAt: 240_000, finishedAt: 240_030, errorMsg: 'gh network error' };
    hostNextFireAt = 300_000;
    remoteScheduleEventStore.apply('modern-dev', {
      type: 'failed',
      scheduleId: 'sched-1',
      runId: 'r-fail',
      sessionId: '',
    });
    await syncModernScreen();
    expect(modernEffectiveIndex().get('sess-1')?.latestFailedRun?.runId).toBe('r-fail');
    expect(modernSessionsListCalls).toBe(0); // empty sessionId failure still never pulls sessions:list

    hostFailedRun = null;
    hostNextFireAt = 360_000;
    const indexCallsBeforeRecovery = modernIndexRunsCalls;
    remoteScheduleEventStore.apply('modern-dev', {
      type: 'skipped',
      scheduleId: 'sched-1',
      runId: 'r-recover',
      sessionId: '',
      lastFiredAt: 300_000,
      lastFinishedAt: 300_020,
      nextFireAt: 360_000,
      preRunCheckSucceeded: true,
    });
    await syncModernScreen();
    expect(modernIndexRunsCalls).toBe(indexCallsBeforeRecovery + 1);
    expect(modernEffectiveIndex().get('sess-1')?.latestFailedRun).toBeUndefined();
    expect(modernEffectiveIndex().get('sess-1')?.nextFireAt).toBe(360_000);
  });
});
