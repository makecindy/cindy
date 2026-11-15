import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MakerScheduleRunnerDeps } from '../runner.desktop';
import type { StartSchedulerDeps } from '../index.desktop';
import type { SchedulerOptions } from '@cindy/maker-scheduler';

const mocks = vi.hoisted(() => ({
  restore: vi.fn<(sessionId: string) => Promise<boolean>>(),
  quotaWait: vi.fn<(scheduleId: string) => Promise<string | null>>(),
  lastUserActionAt: vi.fn<(sessionId: string) => number | null>(),
  runnerDeps: null as MakerScheduleRunnerDeps | null,
  schedulerOptions: null as SchedulerOptions | null,
  runnerFire: vi.fn(),
  captureGuard: vi.fn<() => () => void>(),
}));

// 保留真正的 startScheduler 装配，只隔离 Electron、持久化和后台服务。
vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('@cindy/maker-scheduler', () => ({ Scheduler: class {
  constructor(options: SchedulerOptions) { mocks.schedulerOptions = options; }
  async start() {}
  async stop() {}
} }));
vi.mock('../../localDb/dialogueWorkspace', () => ({ dialogueWorkspaceRoots: () => [] }));
vi.mock('../../localDb/schema.js', () => ({ sessions: {} }));
vi.mock('../../localDb/client/current', () => ({ getDbClient: vi.fn() }));
vi.mock('../../maker-ipc/scheduledModelSelection', () => ({ assertScheduledHarnessSupported: vi.fn() }));
vi.mock('../../maker-host/model-route-guard-live.js', () => ({
  resolveDefaultScheduleRoute: vi.fn(), resolveRouteCopyCapabilities: vi.fn(),
  resolveScheduledModelSelectionLive: vi.fn(), verdictForModelRoute: vi.fn(),
}));
vi.mock('../../agent-island/service.js', () => ({ getAgentIslandService: () => null }));
vi.mock('../../notificationService.js', () => ({ getDesktopNotificationsEnabled: () => false }));
vi.mock('../../maker-ipc/scheduledSessionBootstrap.js', () => ({ captureScheduledOwnerGuard: mocks.captureGuard }));
vi.mock('../../maker-ipc/register.js', () => ({
  bootstrapScheduledSession: vi.fn(),
  ensureSchedulerQueueRestored: mocks.restore,
  findSchedulerUsageLimitWait: mocks.quotaWait,
  getSessionLastUserActionAt: mocks.lastUserActionAt,
  applyPiImModelSelectionUnderLock: vi.fn(), acquirePendingAgentSwitchForDirectSend: vi.fn(),
  prepareScheduledModelPreferencesUnderLock: vi.fn(), recordDispatchedModel: vi.fn(),
  broadcastSessionCreated: vi.fn(), cancelSchedulerAutoResume: vi.fn(),
  enqueueSchedulerPrompt: vi.fn(), hasQueuedSchedulerPrompt: vi.fn(),
  isSchedulerAutoResumePending: vi.fn(), isSchedulerPromptTracked: vi.fn(),
  isSchedulerTargetSessionBusy: vi.fn(), onSchedulerAutoResumeFailed: vi.fn(),
  removeQueuedSchedulerPrompt: vi.fn(),
}));
vi.mock('../storage.desktop', () => ({ DrizzleScheduleStorage: class {
  async deleteOrphanRuns() { return 0; }
} }));
vi.mock('../project-automation-loader', () => ({ ProjectAutomationLoader: class {
  async reconcileAll() {}
} }));
vi.mock('../runner.desktop', () => ({ MakerScheduleRunner: class {
  constructor(deps: MakerScheduleRunnerDeps) { mocks.runnerDeps = deps; }
  fire = mocks.runnerFire;
  attachScheduler() {}
} }));
vi.mock('../../localDb/ipc/messages.js', () => ({ listMessagesForAgentHandoff: vi.fn() }));
vi.mock('../../messagePersistBroadcaster.desktop.js', () => ({ drainPersistQueue: vi.fn() }));
vi.mock('../script-runner.desktop', () => ({ ScriptScheduleRunner: class { attachScheduler() {} } }));
vi.mock('../script-capability-broker.desktop', () => ({ SchedulerScriptCapabilityBroker: class {} }));
vi.mock('../notifier.desktop', () => ({ DesktopNotifier: class {} }));
vi.mock('../../im/feishu/notificationOrigin', () => ({ sendFeishuSessionNotification: vi.fn() }));
vi.mock('../../wecomGroupNotification', () => ({ wecomGroupNotificationService: {} }));

import { resetScheduler, startScheduler } from '../index.desktop';

afterEach(async () => {
  await resetScheduler();
  mocks.restore.mockReset();
  mocks.quotaWait.mockReset();
  mocks.lastUserActionAt.mockReset();
  mocks.runnerDeps = null;
  mocks.schedulerOptions = null;
  mocks.runnerFire.mockReset();
  mocks.captureGuard.mockReset();
});

describe('scheduler queue wiring', () => {
  it.each([true, false])('checks the captured owner after its plugin check (changed=%s)', async (changed) => {
    let owner = 'a';
    mocks.captureGuard.mockImplementation(() => {
      const captured = owner;
      return () => { if (captured !== owner) throw new Error('owner changed'); };
    });
    let release!: (result: { action: 'allow'; ghostName: string }) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<{ action: 'allow'; ghostName: string }>(resolve => { release = resolve; });
    await startScheduler({
      maker: {} as StartSchedulerDeps['maker'], getDb: vi.fn(), getMainWindow: () => null,
      feishuIm: {} as StartSchedulerDeps['feishuIm'], logger: {},
      screenControlPoint: async () => { entered(); return gate; },
    });
    const assertFireContext = mocks.schedulerOptions!.captureFireContext!();
    const fire = mocks.schedulerOptions!.runner.fire({
      id: 'schedule', name: 'schedule', prompt: 'work', preRunPlugin: { pluginId: 'plugin' },
    } as never, { runId: 'run', firedAt: 0, signal: new AbortController().signal, assertFireContext });
    await started;
    if (changed) owner = 'b';
    mocks.runnerFire.mockResolvedValue({ sessionId: 'task' });
    release({ action: 'allow', ghostName: 'plugin' });
    if (changed) {
      await expect(fire).rejects.toThrow('owner changed');
      expect(mocks.runnerFire).not.toHaveBeenCalled();
    } else {
      await expect(fire).resolves.toEqual({ sessionId: 'task' });
      expect(mocks.runnerFire).toHaveBeenCalledOnce();
    }
  });

  it.each([true, false])('passes queue restoration and its %s result through the desktop startup', async (restored) => {
    mocks.restore.mockResolvedValue(restored);
    await startScheduler({
      maker: {} as StartSchedulerDeps['maker'],
      getDb: vi.fn(), getMainWindow: () => null,
      feishuIm: {} as StartSchedulerDeps['feishuIm'], logger: {},
    });

    const restore = mocks.runnerDeps?.schedulerQueue?.ensureQueueRestored;
    expect(restore).toBe(mocks.restore);
    await expect(restore!('restored-session')).resolves.toBe(restored);
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith('restored-session');
    // Production startup must retain schedule-wide quota deduplication, including fresh-session fires.
    mocks.quotaWait.mockResolvedValue('old-quota-session');
    await expect(mocks.runnerDeps?.findUsageLimitWait?.('schedule')).resolves.toBe('old-quota-session');
    expect(mocks.quotaWait).toHaveBeenCalledExactlyOnceWith('schedule');
    // #7104 / unit: runner tests inject this bridge directly; startup must also
    // forward the live recovery clock so old messages still receive courtesy.
    const actionAt = restored ? 1_000_000 : null;
    mocks.lastUserActionAt.mockReturnValue(actionAt);
    expect(mocks.runnerDeps?.schedulerQueue?.getLastUserActionAt?.('restored-session'))
      .toBe(actionAt);
    expect(mocks.lastUserActionAt).toHaveBeenCalledExactlyOnceWith('restored-session');
  });
});
