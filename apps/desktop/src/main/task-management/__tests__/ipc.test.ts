import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTaskArchiveScheduler } from '../scheduler.js';
import { TASK_MANAGEMENT_CHANNEL } from '../../../shared/taskManagement.js';
import type { ArchiveProtection } from '../eligibility.js';
import { markResourceUsageWebContentsId } from '../../resource-usage-window/registry.js';
import { markRemoteDesktopViewer } from '../../remote-desktop-viewer/registry.js';
import { markRsbWindowWebContentsId } from '../../right-sidebar-window/registry.js';

// #10310, unit: engine/store tests cannot validate renderer ownership or combine
// multiple windows. Minimal boundary is a late report from the previous login.
const h = vi.hoisted(() => ({
  handle: vi.fn(),
  configure: vi.fn(),
  check: vi.fn(async () => {}),
  update: vi.fn(async () => ({})),
  invalidate: vi.fn(),
  onInvalidated: vi.fn(),
  refresh: vi.fn(),
  requestCheck: vi.fn(),
  powerOn: vi.fn(),
  owner: 'a',
  generation: 1,
  remote: [] as string[],
  windows: [] as Array<{
    webContents: {
      id: number;
      once: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };
  }>,
}));
vi.mock('electron', () => ({
  app: { isPackaged: true },
  ipcMain: { handle: h.handle },
  BrowserWindow: { getAllWindows: () => h.windows },
  powerMonitor: { on: h.powerOn },
}));
vi.mock('../../ownerContext.js', () => ({
  activeDataOwnerId: () => h.owner,
  ownerGeneration: () => h.generation,
}));
vi.mock('../../appSessionState.js', () => ({ onAppSessionInvalidated: h.onInvalidated }));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
  isTrustedAppRendererWindow: () => true,
}));
vi.mock('../../device-link/subscriptions.js', () => ({ getKnownControllerIds: () => h.remote }));
vi.mock('../service.js', () => ({
  configureTaskArchivePlatform: h.configure,
  refreshTaskArchiveReadiness: h.refresh,
  requestTaskArchiveCheck: h.requestCheck,
  updateTaskArchiveSettings: h.update,
  taskArchiveEngine: { check: h.check, invalidate: h.invalidate, preview: vi.fn(), undo: vi.fn() },
}));
vi.mock('../store.js', () => ({
  taskManagementScope: () => `${h.owner}:${h.generation}`,
  taskManagementStore: { read: () => ({ enabled: false, days: 7 }) },
}));
import { registerTaskManagementIpc } from '../ipc.desktop.js';

let scheduler: ReturnType<typeof createTaskArchiveScheduler>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.owner = 'a';
  h.generation = 1;
  h.remote = [];
  h.windows = [1, 2].map((id) => ({
    webContents: { id, once: vi.fn(), on: vi.fn(), send: vi.fn() },
  }));
  scheduler = createTaskArchiveScheduler({
    check: h.check,
    settled: async () => {},
    invalidate: h.invalidate,
    warn: vi.fn(),
  });
  h.refresh.mockImplementation(() => scheduler.setReady(protection().ready));
  h.requestCheck.mockImplementation(() => {
    h.refresh();
    scheduler.request();
  });
  registerTaskManagementIpc();
});
afterEach(() => {
  scheduler.setReady(false);
  vi.clearAllTimers();
  vi.useRealTimers();
});
function request(raw: unknown, window = 0) {
  const handler = h.handle.mock.calls.find(([channel]) => channel === TASK_MANAGEMENT_CHANNEL)![1];
  return handler({ sender: h.windows[window].webContents }, raw);
}
function report(viewed: string[], drafts: string[], window = 0) {
  return request(
    {
      operation: 'protect',
      value: { ownerId: h.owner, ownerGeneration: h.generation, viewed, drafts },
    },
    window,
  );
}
const protection = (): ArchiveProtection => h.configure.mock.calls[0][0].protection();

it('waits for all windows, retains both kinds of protection and invalidates them on account changes', async () => {
  expect(protection().ready).toBe(false);
  await report(['open'], ['draft']);
  expect(protection().ready).toBe(false);
  await report(['other'], [], 1);
  expect(protection()).toMatchObject({
    ready: true,
    viewed: new Set(['open', 'other']),
    drafts: new Set(['draft']),
  });
  h.onInvalidated.mock.calls[0][0]();
  expect(protection().ready).toBe(false);
});

// Normal startup prewarms these trusted utility windows. They never mount
// MainLayout, so waiting for their reports used to block every real task view.
it('does not wait for the prewarmed utility renderers to report task protection', async () => {
  const utilityIds = [101, 102, 103];
  markResourceUsageWebContentsId(101);
  markRemoteDesktopViewer(102);
  markRsbWindowWebContentsId(103);
  h.windows.push(
    ...utilityIds.map((id) => ({
      webContents: { id, once: vi.fn(), on: vi.fn(), send: vi.fn() },
    })),
  );
  await report([], []);
  expect(protection().ready).toBe(false);
  await report([], [], 1);
  expect(protection().ready).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.check).toHaveBeenCalledOnce();
});

it('rejects old-login writes and reports, even when the account id is unchanged', async () => {
  const owner = { ownerId: 'a', ownerGeneration: 1 };
  h.generation = 2;
  await expect(request({ operation: 'update', owner, patch: { enabled: true } })).rejects.toThrow(
    'PRECONDITION_FAILED',
  );
  await expect(
    request({ operation: 'protect', value: { ...owner, viewed: [], drafts: [] } }),
  ).rejects.toThrow('PRECONDITION_FAILED');
  expect(h.update).not.toHaveBeenCalled();
  expect(protection().ready).toBe(false);
});

it('validates day limits before writing and shares the normal settings operation', async () => {
  const owner = { ownerId: 'a', ownerGeneration: 1 };
  await expect(request({ operation: 'update', owner, patch: { days: 366 } })).rejects.toThrow(
    'INVALID_PARAMS',
  );
  expect(h.update).not.toHaveBeenCalled();
  await request({ operation: 'update', owner, patch: { days: 14 } });
  expect(h.update).toHaveBeenCalledExactlyOnceWith({ days: 14 });
});

it('treats unreported remote drafts and a reloading window as unknown', async () => {
  await report([], []);
  await report([], [], 1);
  h.remote = ['controller'];
  expect(protection().remoteUnknown).toBe(true);
  h.windows[0].webContents.on.mock.calls.find(([name]) => name === 'did-start-loading')![1]();
  expect(protection().ready).toBe(false);
});

// #10310 startup follow-up: a first protection report previously started a scan
// immediately. Exercise the real IPC adapter and scheduler with a fake clock.
it('starts the grace period only after all main views mount; reports and wake cannot bypass it', async () => {
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.check).not.toHaveBeenCalled();
  await report([], []);
  await vi.advanceTimersByTimeAsync(15_000);
  await report([], [], 1);
  await vi.advanceTimersByTimeAsync(29_999);
  await report(['new-view'], []);
  h.powerOn.mock.calls.find(([event]) => event === 'resume')![1]();
  expect(h.check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.check).toHaveBeenCalledExactlyOnceWith(true);
});

it('cancels a startup check on reload and starts a fresh grace period after the view returns', async () => {
  await report([], []);
  await report([], [], 1);
  await vi.advanceTimersByTimeAsync(20_000);
  h.windows[0].webContents.on.mock.calls.find(([event]) => event === 'did-start-loading')![1]();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.check).not.toHaveBeenCalled();
  await report([], []);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(h.check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.check).toHaveBeenCalledOnce();
});
