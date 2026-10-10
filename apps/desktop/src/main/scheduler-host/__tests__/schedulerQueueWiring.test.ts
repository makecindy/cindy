import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MakerScheduleRunnerDeps } from '../runner';
import type { StartSchedulerDeps } from '../index';

const mocks = vi.hoisted(() => ({
  restore: vi.fn<(sessionId: string) => Promise<boolean>>(),
  runnerDeps: null as MakerScheduleRunnerDeps | null,
}));

// 保留真正的 startScheduler 装配，只隔离 Electron、持久化和后台服务。
vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('@cindy/maker-scheduler', () => ({ Scheduler: class {
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
vi.mock('../../maker-ipc/register.js', () => ({
  ensureSchedulerQueueRestored: mocks.restore,
  applyPiImModelSelectionUnderLock: vi.fn(), acquirePendingAgentSwitchForDirectSend: vi.fn(),
  broadcastSessionCreated: vi.fn(), cancelSchedulerAutoResume: vi.fn(),
  enqueueSchedulerPrompt: vi.fn(), hasQueuedSchedulerPrompt: vi.fn(),
  isSchedulerAutoResumePending: vi.fn(), isSchedulerPromptTracked: vi.fn(),
  isSchedulerTargetSessionBusy: vi.fn(), onSchedulerAutoResumeFailed: vi.fn(),
  removeQueuedSchedulerPrompt: vi.fn(),
}));
vi.mock('../storage', () => ({ DrizzleScheduleStorage: class {
  async deleteOrphanRuns() { return 0; }
} }));
vi.mock('../project-automation-loader', () => ({ ProjectAutomationLoader: class {
  async reconcileAll() {}
} }));
vi.mock('../runner', () => ({ MakerScheduleRunner: class {
  constructor(deps: MakerScheduleRunnerDeps) { mocks.runnerDeps = deps; }
  attachScheduler() {}
} }));
vi.mock('../../localDb/ipc/messages.js', () => ({ listMessagesForAgentHandoff: vi.fn() }));
vi.mock('../../messagePersistBroadcaster.js', () => ({ drainPersistQueue: vi.fn() }));
vi.mock('../script-runner', () => ({ ScriptScheduleRunner: class { attachScheduler() {} } }));
vi.mock('../script-capability-broker', () => ({ SchedulerScriptCapabilityBroker: class {} }));
vi.mock('../notifier', () => ({ DesktopNotifier: class {} }));
vi.mock('../../im/feishu/notificationOrigin', () => ({ sendFeishuSessionNotification: vi.fn() }));
vi.mock('../../wecomGroupNotification', () => ({ wecomGroupNotificationService: {} }));
vi.mock('../../routines/service.js', () => ({ getRoutineEngine: async () => null, stopRoutines: async () => {} }));

import { resetScheduler, startScheduler } from '../index';

afterEach(async () => {
  await resetScheduler();
  mocks.restore.mockReset();
  mocks.runnerDeps = null;
});

describe('scheduler queue wiring', () => {
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
  });
});
