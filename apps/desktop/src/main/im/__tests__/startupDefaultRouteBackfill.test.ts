import { beforeEach, describe, expect, it, vi } from 'vitest';

// PR #5155: an upgraded user who never saves channel settings still needs
// legacy-route backfill at startImConnection. The existing SQLite tests cover
// backfill persistence, but never call this startup entry. Use pending backfill
// and lifecycle ports to observe ordering without loading real transports/DBs.
// A separate unit file keeps the index singleton and channel mocks isolated
// from the existing pure lifecycle tests. The module is imported only once.
const h = vi.hoisted(() => ({
  events: [] as string[],
  started: false,
  relaunching: false,
  db: { owner: 'fake-startup-owner' },
  config: { agentKind: 'claude-code', defaultModel: 'test-model' },
  finishBackfill: (() => undefined) as () => void,
  backfill: vi.fn(),
}));

vi.mock('../../localDb/client/current', () => ({ getDbClient: () => h.db }));
vi.mock('../../maker-ipc/sessionRuntimeControl.js', () => ({}));
vi.mock('../host', () => ({}));
vi.mock('../feishu', () => ({}));
vi.mock('../discord', () => ({}));
vi.mock('../telegram', () => ({}));
vi.mock('../dingtalk', () => ({}));
vi.mock('../wechat', () => ({}));
vi.mock('../wecom', () => ({}));
vi.mock('../telegram/groupWindow', () => ({}));
vi.mock('../shared/orchestrator', () => ({
  getImOrchestrator: (source: string) => source === 'feishu' ? { adapter: { config: h.config } } : undefined,
}));
vi.mock('../shared/channelDefaultRouteSync', () => ({
  backfillLegacyImDefaultRoutesAtStartup: h.backfill,
}));
vi.mock('../connectionLifecycle', () => ({
  createSerializedConnectionLifecycle: () => ({
    isStarted: () => h.started,
    start: () => { h.events.push('connect'); h.started = true; },
  }),
}));
vi.mock('../accountBoundary', () => ({ captureImAccountGeneration: vi.fn() }));
vi.mock('../accountScopeBridge', () => ({ configureImAccountScope: vi.fn() }));
vi.mock('../binding', () => ({}));
vi.mock('../../authManager', () => ({}));
vi.mock('../../updateService', () => ({
  isUpdateRelaunchImminent: () => h.relaunching,
  getUpdateStatus: () => 'ready',
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../security/trustedAppRenderer', () => ({}));
vi.mock('../wechat/channelSettings', () => ({}));

import { startImConnection } from '../index';

beforeEach(() => {
  h.events.length = 0;
  h.started = false;
  h.relaunching = false;
  h.backfill.mockReset().mockImplementation(() => {
    h.events.push('backfill');
    return new Promise<void>((resolve) => { h.finishBackfill = resolve; });
  });
});

describe('IM startup legacy route backfill', () => {
  it('starts backfill with current channel config and DB before connecting, without waiting for it', async () => {
    startImConnection();
    expect(h.events).toEqual(['backfill', 'connect']);
    expect(h.backfill).toHaveBeenCalledWith([{ source: 'feishu', config: h.config }], h.db);
    // A repeated ready signal must not launch another backfill or connection.
    startImConnection();
    expect(h.backfill).toHaveBeenCalledOnce();
    expect(h.events).toEqual(['backfill', 'connect']);
    h.finishBackfill();
    await h.backfill.mock.results[0].value;
  });

  it('leaves both startup operations untouched while an update relaunch is imminent', () => {
    h.relaunching = true;
    startImConnection();
    expect(h.events).toEqual([]);
    expect(h.backfill).not.toHaveBeenCalled();
  });
});
