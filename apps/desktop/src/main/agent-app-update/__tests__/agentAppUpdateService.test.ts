import { describe, expect, it, vi } from 'vitest';
import type { InteractionDecision } from '@cindy/maker-core';

import {
  createAgentAppUpdateService,
  type AgentAppUpdateDeps,
  type AgentAppUpdateMarker,
} from '../agentAppUpdateService.js';
import { AGENT_APP_AUTO_UPDATE_TOOL_NAME, AGENT_APP_UPDATE_TOOL_NAME } from '../constants.js';

const caller = { sessionId: 'task-1', sessionInstanceId: 'instance-1' };
const ownerA = { ownerId: 'owner-a' };

function allow(): InteractionDecision {
  return { kind: 'permission', behavior: 'allow' };
}

function deny(reason?: string): InteractionDecision {
  return { kind: 'permission', behavior: 'deny', ...(reason ? { reason } : {}) };
}

function setup(overrides: Partial<AgentAppUpdateDeps> = {}) {
  let records: AgentAppUpdateMarker[] = [];
  let autoUpdate = false;
  let activeOwner: { ownerId: string } | null = ownerA;
  const deps: AgentAppUpdateDeps = {
    appVersion: () => '0.1.86',
    platform: 'darwin',
    pid: 100,
    now: () => 1_000,
    check: vi.fn(async () => ({
      status: 'available',
      currentVersion: '0.1.86',
      targetVersion: '0.1.90',
    })),
    apply: vi.fn(async ({ beforeRelaunch }) => {
      await beforeRelaunch();
      return { status: 'relaunching' as const, targetVersion: '0.1.90' };
    }),
    readAutoUpdate: () => autoUpdate,
    writeAutoUpdate: vi.fn((enabled: boolean) => {
      autoUpdate = enabled;
      return autoUpdate;
    }),
    resolveCaller: vi.fn(() => 'owner' as const),
    countOtherRunningTasks: vi.fn(() => 2),
    hasBackgroundWork: vi.fn(async () => false),
    requestHostPermission: vi.fn(async () => allow()),
    waitForCallerTurnToEnd: vi.fn(async () => undefined),
    captureOwner: vi.fn(() => activeOwner),
    isOwnerCurrent: vi.fn((owner) => activeOwner?.ownerId === owner.ownerId),
    marker: {
      list: () => [...records],
      add: vi.fn((_owner, record: AgentAppUpdateMarker) => {
        records = [...records, record];
      }),
      remove: vi.fn((_owner, requestId: string) => {
        records = records.filter((record) => record.requestId !== requestId);
      }),
    },
    notify: vi.fn(async () => 'written' as const),
    compareVersions: (candidate, current) =>
      candidate === current ? 'same' : (candidate ?? '') > current ? 'newer' : 'older',
    translate: (key) => key,
    ...overrides,
  };
  return {
    deps,
    service: createAgentAppUpdateService(deps),
    /** Latest restart record, or null. */
    getMarker: () => records.at(-1) ?? null,
    getRecords: () => [...records],
    setMarker: (value: AgentAppUpdateMarker | null) => {
      records = value ? [value] : [];
    },
    switchOwner: (owner: { ownerId: string } | null) => {
      activeOwner = owner;
    },
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('Agent app update install', () => {
  it('does not download or restart until the owner approves the Host card', async () => {
    let resolveCard!: (decision: InteractionDecision) => void;
    const { deps, service } = setup({
      requestHostPermission: vi.fn(
        () =>
          new Promise<InteractionDecision>((resolve) => {
            resolveCard = resolve;
          }),
      ),
    });
    const pending = service.install(caller);
    await flush();
    expect(deps.requestHostPermission).toHaveBeenCalledOnce();
    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.marker.add).not.toHaveBeenCalled();

    const [sessionId, instanceId, card] = vi.mocked(deps.requestHostPermission).mock.calls[0]!;
    expect([sessionId, instanceId]).toEqual(['task-1', 'instance-1']);
    expect(card).toMatchObject({
      kind: 'permission',
      toolName: AGENT_APP_UPDATE_TOOL_NAME,
      title: 'update.agentInstall.title',
      input: { from: '0.1.86', to: '0.1.90' },
      metadata: { hostOwnedConfirmation: 'app_update' },
    });
    expect(card.suggestions).toBeUndefined();
    expect(card.description?.split('\n')).toEqual([
      'update.agentInstall.versions',
      'update.agentInstall.otherTasks',
      'update.agentInstall.thisTask',
      'update.agentInstall.remote',
    ]);

    resolveCard(allow());
    await expect(pending).resolves.toMatchObject({
      status: 'started',
      currentVersion: '0.1.86',
      targetVersion: '0.1.90',
    });
    await flush();
    expect(deps.apply).toHaveBeenCalledOnce();
    expect(deps.waitForCallerTurnToEnd).toHaveBeenCalledWith(caller);
    expect(deps.apply).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: '0.1.90' }));
    const { beforeSpawn } = vi.mocked(deps.apply).mock.calls[0]![0];
    expect(beforeSpawn?.()).toBe(true);
    expect(deps.marker.add).toHaveBeenCalledWith(
      ownerA,
      expect.objectContaining({
        sessionId: 'task-1',
        fromVersion: '0.1.86',
        targetVersion: '0.1.90',
        pid: 100,
      }),
    );
  });

  it.each([
    ['deny', deny('user_denied'), { status: 'declined' }],
    ['timeout', deny('interaction_timeout'), { status: 'confirmation_timeout' }],
    ['abort', deny('session_aborted'), { status: 'declined' }],
    [
      'undelivered',
      deny('no_interaction_route'),
      { ok: false, errorCode: 'CONFIRMATION_UNAVAILABLE' },
    ],
  ])('does nothing when the card is answered with %s', async (_label, decision, expected) => {
    const { deps, service } = setup({ requestHostPermission: vi.fn(async () => decision) });
    await expect(service.install(caller)).resolves.toMatchObject(expected);
    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.marker.add).not.toHaveBeenCalled();
    // The flow is released: a later request raises a fresh card.
    await service.install(caller);
    expect(deps.requestHostPermission).toHaveBeenCalledTimes(2);
  });

  it('refuses non-owner turns before any card or download', async () => {
    const { deps, service } = setup({ resolveCaller: vi.fn(() => 'not-owner' as const) });
    await expect(service.install(caller)).resolves.toMatchObject({
      ok: false,
      errorCode: 'OWNER_TURN_REQUIRED',
    });
    expect(deps.check).not.toHaveBeenCalled();
    expect(deps.requestHostPermission).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it('re-checks the caller after approval and stops if the task went away', async () => {
    const resolveCaller = vi.fn().mockReturnValueOnce('owner').mockReturnValueOnce('unavailable');
    const { deps, service } = setup({ resolveCaller });
    await expect(service.install(caller)).resolves.toMatchObject({
      ok: false,
      errorCode: 'CALLER_UNAVAILABLE',
    });
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it('returns unsupported reasons without a card', async () => {
    const { deps, service } = setup({
      check: vi.fn(async () => ({
        status: 'unsupported',
        currentVersion: '0.0.0',
        reason: '此构建不支持应用内更新。',
      })),
    });
    await expect(service.install(caller)).resolves.toMatchObject({
      status: 'unsupported',
      reason: '此构建不支持应用内更新。',
    });
    expect(deps.requestHostPermission).not.toHaveBeenCalled();
  });

  it('keeps one install request: repeats neither raise another card nor download again', async () => {
    let resolveCard!: (decision: InteractionDecision) => void;
    let finishApply!: () => void;
    const { deps, service } = setup({
      requestHostPermission: vi.fn(
        () =>
          new Promise<InteractionDecision>((resolve) => {
            resolveCard = resolve;
          }),
      ),
      apply: vi.fn(
        () =>
          new Promise<{ status: 'relaunching' }>((resolve) => {
            finishApply = () => resolve({ status: 'relaunching' });
          }),
      ),
    });
    const first = service.install(caller);
    await flush();
    await expect(service.install(caller)).resolves.toMatchObject({
      status: 'confirmation_pending',
    });
    resolveCard(allow());
    await first;
    await expect(service.install(caller)).resolves.toMatchObject({
      status: 'in_progress',
      targetVersion: '0.1.90',
    });
    expect(deps.requestHostPermission).toHaveBeenCalledOnce();
    expect(deps.apply).toHaveBeenCalledOnce();
    finishApply();
  });

  it('writes an immediate failure back to the task when no restart happened', async () => {
    const { deps, service, getMarker } = setup({
      apply: vi.fn(async () => ({
        status: 'failed' as const,
        reason: '下载更新失败，请稍后重试。',
        errorCode: 'download_failed',
      })),
    });
    await service.install(caller);
    await flush();
    expect(getMarker()).toBeNull();
    expect(deps.notify).toHaveBeenCalledWith(
      ownerA,
      'task-1',
      expect.stringMatching(/^agent-app-update:/),
      'update.agentInstall.failed update.agentInstall.reasons.downloadFailed update.agentInstall.retryHint',
    );
    // Released after the failure.
    await service.install(caller);
    expect(deps.requestHostPermission).toHaveBeenCalledTimes(2);
  });

  it('localizes the failure reason from its error code, never the updater diagnostic text', async () => {
    const { deps, service } = setup({
      translate: (key) =>
        key === 'update.agentInstall.reasons.versionChanged'
          ? 'now {{version}}, confirmed {{confirmed}}'
          : key,
      apply: vi.fn(async () => ({
        status: 'failed' as const,
        reason: '中文诊断文本',
        errorCode: 'version_changed',
        stagedVersion: '0.1.91',
      })),
    });
    await service.install(caller);
    await flush();
    const text = vi.mocked(deps.notify).mock.calls[0]![3];
    expect(text).toContain('now 0.1.91, confirmed 0.1.90');
    expect(text).not.toContain('中文诊断文本');
  });

  it('falls back to a generic localized reason for unknown error codes', async () => {
    const { deps, service } = setup({
      apply: vi.fn(async () => ({ status: 'failed' as const, reason: 'x', errorCode: 'EACCES' })),
    });
    await service.install(caller);
    await flush();
    expect(vi.mocked(deps.notify).mock.calls[0]![3]).toContain(
      'update.agentInstall.reasons.generic',
    );
  });

  it('cancels the restart after an account switch and never writes into the next account', async () => {
    let restartAllowed: boolean | undefined;
    const harness = setup({
      apply: vi.fn(async ({ beforeRelaunch }) => {
        harness.switchOwner({ ownerId: 'owner-b' });
        restartAllowed = await beforeRelaunch();
        return restartAllowed
          ? { status: 'relaunching' as const }
          : { status: 'failed' as const, reason: 'cancelled', errorCode: 'relaunch_cancelled' };
      }),
    });
    await harness.service.install(caller);
    await flush();
    expect(restartAllowed).toBe(false);
    expect(harness.deps.notify).not.toHaveBeenCalled();
    // No restart happened, so no restart record is left on disk.
    expect(harness.deps.marker.add).not.toHaveBeenCalled();
    // The notice waits in memory until the confirming account is active again
    // (a fresh sign-in: same account id, new scope object).
    harness.switchOwner({ ownerId: 'owner-a' });
    await harness.service.deliverPendingResult();
    expect(harness.deps.notify).toHaveBeenCalledOnce();
    expect(harness.deps.notify).toHaveBeenCalledWith(
      { ownerId: 'owner-a' },
      'task-1',
      expect.stringMatching(/^agent-app-update:/),
      expect.stringContaining('update.agentInstall.reasons.notRestarted'),
    );
  });

  it('retries an in-process failure notice without blocking a new install', async () => {
    const notify = vi
      .fn<AgentAppUpdateDeps['notify']>()
      .mockRejectedValueOnce(new Error('database busy'))
      .mockResolvedValue('written');
    const apply = vi
      .fn<AgentAppUpdateDeps['apply']>()
      .mockResolvedValueOnce({ status: 'failed', reason: 'x', errorCode: 'download_failed' })
      .mockResolvedValue({ status: 'relaunching' });
    const harness = setup({ notify, apply });
    await harness.service.install(caller);
    await flush();
    expect(notify).toHaveBeenCalledOnce();
    expect(harness.getMarker()).toBeNull();
    // The next install request first retries the pending notice, then proceeds.
    await expect(harness.service.install(caller)).resolves.toMatchObject({ status: 'started' });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]![2]).toBe(notify.mock.calls[1]![2]);
    expect(harness.deps.requestHostPermission).toHaveBeenCalledTimes(2);
  });

  it('never drops an unrelated notice when flushes overlap', async () => {
    const harness = setup({
      apply: vi.fn(async ({ beforeRelaunch }) => {
        harness.switchOwner({ ownerId: 'owner-b' });
        await beforeRelaunch();
        return { status: 'failed' as const, reason: 'x', errorCode: 'relaunch_cancelled' };
      }),
    });
    // Two failed installs from two tasks, both queued while their account is away.
    await harness.service.install(caller);
    await flush();
    harness.switchOwner(ownerA);
    // The second request's opportunistic retry hits a busy database, so task-1 stays queued.
    vi.mocked(harness.deps.notify).mockRejectedValueOnce(new Error('database busy'));
    await harness.service.install({ sessionId: 'task-2', sessionInstanceId: 'instance-2' });
    await flush();
    harness.switchOwner(ownerA);
    vi.mocked(harness.deps.notify).mockClear();
    await Promise.all([
      harness.service.deliverPendingResult(),
      harness.service.deliverPendingResult(),
    ]);
    const delivered = new Set(vi.mocked(harness.deps.notify).mock.calls.map((call) => call[1]));
    expect(delivered).toEqual(new Set(['task-1', 'task-2']));
    vi.mocked(harness.deps.notify).mockClear();
    await harness.service.deliverPendingResult();
    expect(harness.deps.notify).not.toHaveBeenCalled();
  });

  it('keeps every undelivered failure notice, however many there are', async () => {
    const harness = setup({
      apply: vi.fn(async () => {
        harness.switchOwner(null);
        return { status: 'failed' as const, reason: 'x', errorCode: 'download_failed' };
      }),
    });
    for (let i = 0; i < 25; i += 1) {
      harness.switchOwner(ownerA);
      await harness.service.install({ sessionId: `task-${i}`, sessionInstanceId: `instance-${i}` });
      await flush();
    }
    harness.switchOwner(ownerA);
    await harness.service.deliverPendingResult();
    // Every task got its notice (some on a later request's retry), none was dropped.
    expect(new Set(vi.mocked(harness.deps.notify).mock.calls.map((call) => call[1])).size).toBe(25);
  });

  it('writes the restart record only at the last gate, and clears it if the spawn then fails', async () => {
    const harness = setup({
      apply: vi.fn(async ({ beforeRelaunch, beforeSpawn }) => {
        await beforeRelaunch();
        expect(harness.getMarker()).toBeNull();
        expect(beforeSpawn?.()).toBe(true);
        expect(harness.getMarker()).toMatchObject({ sessionId: 'task-1', targetVersion: '0.1.90' });
        return { status: 'failed' as const, reason: 'x', errorCode: 'updater_spawn_failed' };
      }),
    });
    await harness.service.install(caller);
    await flush();
    expect(harness.getMarker()).toBeNull();
    expect(vi.mocked(harness.deps.notify).mock.calls[0]![3]).toContain(
      'update.agentInstall.reasons.updaterNotStarted',
    );
  });

  it('does not restart when the restart record cannot be written', async () => {
    let allowed: boolean | undefined;
    const harness = setup({
      apply: vi.fn(async ({ beforeSpawn }) => {
        allowed = beforeSpawn?.();
        return allowed
          ? { status: 'relaunching' as const }
          : { status: 'failed' as const, reason: 'x', errorCode: 'relaunch_cancelled' };
      }),
    });
    vi.mocked(harness.deps.marker.add).mockImplementation(() => {
      throw new Error('disk full');
    });
    await harness.service.install(caller);
    await flush();
    expect(allowed).toBe(false);
    expect(harness.deps.notify).toHaveBeenCalledOnce();
  });

  it('keeps an undelivered earlier restart record next to a new one instead of overwriting it', async () => {
    const harness = setup({
      appVersion: () => '0.1.86',
      apply: vi.fn(async ({ beforeSpawn }) => {
        beforeSpawn?.();
        return { status: 'relaunching' as const };
      }),
    });
    harness.setMarker({
      requestId: 'earlier',
      sessionId: 'task-0',
      fromVersion: '0.1.80',
      targetVersion: '0.1.86',
      requestedAt: 900,
      pid: 99,
    });
    vi.mocked(harness.deps.notify).mockRejectedValueOnce(new Error('database busy'));
    await harness.service.deliverPendingResult();
    await harness.service.install(caller);
    await flush();
    // Both survive on disk, so the earlier task's result outlives this restart too.
    expect(harness.getRecords().map((record) => record.requestId)).toEqual([
      'earlier',
      expect.any(String),
    ]);
    expect(harness.getMarker()).toMatchObject({ sessionId: 'task-1' });
  });

  it('delivers every restart record of an earlier process independently', async () => {
    const harness = setup({ appVersion: () => '0.1.90' });
    const base = { fromVersion: '0.1.86', targetVersion: '0.1.90', requestedAt: 900, pid: 99 };
    harness.setMarker({ ...base, requestId: 'a', sessionId: 'task-a' });
    await harness.deps.marker.add(ownerA, { ...base, requestId: 'b', sessionId: 'task-b' });
    vi.mocked(harness.deps.notify).mockRejectedValueOnce(new Error('database busy'));
    await harness.service.deliverPendingResult();
    expect(harness.getRecords().map((record) => record.requestId)).toEqual(['a']);
    await harness.service.deliverPendingResult();
    expect(harness.getRecords()).toEqual([]);
  });

  it('refuses to start when no account is active at confirmation', async () => {
    const harness = setup();
    harness.switchOwner(null);
    await expect(harness.service.install(caller)).resolves.toMatchObject({
      ok: false,
      errorCode: 'CALLER_UNAVAILABLE',
    });
    expect(harness.deps.apply).not.toHaveBeenCalled();
    expect(harness.deps.marker.add).not.toHaveBeenCalled();
  });

  it('never raises a card without a concrete target version', async () => {
    const { deps, service } = setup({
      check: vi.fn(async () => ({ status: 'downloading', currentVersion: '0.1.86' })),
    });
    await expect(service.install(caller)).resolves.toMatchObject({ status: 'target_unknown' });
    expect(deps.requestHostPermission).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it('mentions the Linux password prompt only on Linux', async () => {
    const { deps, service } = setup({ platform: 'linux', countOtherRunningTasks: vi.fn(() => 0) });
    await service.install(caller);
    const card = vi.mocked(deps.requestHostPermission).mock.calls[0]![2];
    expect(card.description).toContain('update.agentInstall.noOtherTasks');
    expect(card.description).toContain('update.agentInstall.linuxAuth');
  });

  it('warns about background work instead of claiming nothing else is running', async () => {
    const { deps, service } = setup({
      countOtherRunningTasks: vi.fn(() => 0),
      hasBackgroundWork: vi.fn(async () => true),
    });
    await service.install(caller);
    const card = vi.mocked(deps.requestHostPermission).mock.calls[0]![2];
    expect(card.description).toContain('update.agentInstall.backgroundWork');
    expect(card.description).not.toContain('update.agentInstall.noOtherTasks');
  });

  it('treats an unreadable background probe as background work', async () => {
    const { deps, service } = setup({
      countOtherRunningTasks: vi.fn(() => 0),
      hasBackgroundWork: vi.fn(async () => { throw new Error('probe failed'); }),
    });
    await service.install(caller);
    const card = vi.mocked(deps.requestHostPermission).mock.calls[0]![2];
    expect(card.description).toContain('update.agentInstall.backgroundWork');
    expect(card.description).not.toContain('update.agentInstall.noOtherTasks');
  });
});

describe('Agent app update result after restart', () => {
  const marker = (overrides: Partial<AgentAppUpdateMarker> = {}): AgentAppUpdateMarker => ({
    requestId: 'req-1',
    sessionId: 'task-1',
    fromVersion: '0.1.86',
    targetVersion: '0.1.90',
    requestedAt: 900,
    pid: 99,
    ...overrides,
  });

  it('reports the new version once and clears the marker', async () => {
    const { deps, service, setMarker, getMarker } = setup({
      appVersion: () => '0.1.90',
      translate: (key) =>
        key === 'update.agentInstall.succeeded' ? 'updated to {{version}} from {{from}}' : key,
    });
    setMarker(marker());
    await service.deliverPendingResult();
    await service.deliverPendingResult();
    expect(deps.notify).toHaveBeenCalledOnce();
    expect(deps.notify).toHaveBeenCalledWith(
      ownerA,
      'task-1',
      'agent-app-update:req-1',
      'updated to 0.1.90 from 0.1.86',
    );
    expect(getMarker()).toBeNull();
  });

  it('reports a failed install when the version did not change', async () => {
    const { deps, service, setMarker } = setup();
    setMarker(marker());
    await service.deliverPendingResult();
    expect(deps.notify).toHaveBeenCalledWith(
      ownerA,
      'task-1',
      'agent-app-update:req-1',
      'update.agentInstall.failed update.agentInstall.retryHint',
    );
  });

  it('keeps the marker after a transient write failure and retries without duplicating', async () => {
    const notify = vi
      .fn<AgentAppUpdateDeps['notify']>()
      .mockRejectedValueOnce(new Error('database busy'))
      .mockResolvedValueOnce('written');
    const { service, setMarker, getMarker } = setup({ notify });
    setMarker(marker());
    await service.deliverPendingResult();
    expect(getMarker()).not.toBeNull();
    await service.deliverPendingResult();
    expect(getMarker()).toBeNull();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]![2]).toBe(notify.mock.calls[1]![2]);
  });

  it('clears the marker when the task no longer exists', async () => {
    const { service, setMarker, getMarker } = setup({
      notify: vi.fn(async () => 'task-missing' as const),
    });
    setMarker(marker());
    await service.deliverPendingResult();
    expect(getMarker()).toBeNull();
  });

  it('waits for an active account before reading the marker', async () => {
    const harness = setup();
    harness.setMarker(marker());
    harness.switchOwner(null);
    await harness.service.deliverPendingResult();
    expect(harness.deps.notify).not.toHaveBeenCalled();
    expect(harness.getMarker()).not.toBeNull();
  });

  it('ignores a marker written by this same process (no restart yet)', async () => {
    const { deps, service, setMarker, getMarker } = setup();
    setMarker(marker({ pid: 100 }));
    await service.deliverPendingResult();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(getMarker()).not.toBeNull();
  });

  it('drops stale markers silently', async () => {
    const { deps, service, setMarker, getMarker } = setup({
      now: () => 900 + 8 * 24 * 60 * 60 * 1000,
    });
    setMarker(marker());
    await service.deliverPendingResult();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(getMarker()).toBeNull();
  });
});

describe('Agent auto update switch and hint', () => {
  it('writes the existing setting only after the owner approves', async () => {
    const { deps, service } = setup();
    await expect(service.setAutoUpdate(caller, true)).resolves.toMatchObject({
      status: 'updated',
      autoUpdateEnabled: true,
    });
    expect(vi.mocked(deps.requestHostPermission).mock.calls[0]![2]).toMatchObject({
      toolName: AGENT_APP_AUTO_UPDATE_TOOL_NAME,
      input: { enabled: true },
      title: 'update.agentAutoUpdate.enableTitle',
    });
    expect(deps.writeAutoUpdate).toHaveBeenCalledWith(true);
    // Already enabled: no card, no write.
    await expect(service.setAutoUpdate(caller, true)).resolves.toMatchObject({
      status: 'unchanged',
    });
    expect(deps.requestHostPermission).toHaveBeenCalledOnce();
  });

  it('leaves the setting alone when declined or requested by a non-owner turn', async () => {
    const declined = setup({ requestHostPermission: vi.fn(async () => deny()) });
    await expect(declined.service.setAutoUpdate(caller, true)).resolves.toMatchObject({
      status: 'declined',
    });
    expect(declined.deps.writeAutoUpdate).not.toHaveBeenCalled();

    const guest = setup({ resolveCaller: vi.fn(() => 'not-owner' as const) });
    await expect(guest.service.setAutoUpdate(caller, true)).resolves.toMatchObject({
      errorCode: 'OWNER_TURN_REQUIRED',
    });
    expect(guest.deps.requestHostPermission).not.toHaveBeenCalled();
  });

  it('hints auto update once per task while it is off and an update exists', async () => {
    const { service } = setup();
    await expect(service.check(caller)).resolves.toMatchObject({
      autoUpdateEnabled: false,
      autoUpdateHint: true,
    });
    expect(await service.check(caller)).not.toHaveProperty('autoUpdateHint');
    await expect(service.check({ ...caller, sessionId: 'task-2' })).resolves.toMatchObject({
      autoUpdateHint: true,
    });
  });

  it('does not hint without an installable update or when already enabled', async () => {
    const noUpdate = setup({
      check: vi.fn(async () => ({ status: 'no_installable_update', currentVersion: '0.1.90' })),
    });
    expect(await noUpdate.service.check(caller)).not.toHaveProperty('autoUpdateHint');
    const enabled = setup({ readAutoUpdate: () => true });
    await expect(enabled.service.check(caller)).resolves.toMatchObject({ autoUpdateEnabled: true });
    expect(await enabled.service.check(caller)).not.toHaveProperty('autoUpdateHint');
  });
});
