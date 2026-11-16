import { expect, it, vi } from 'vitest';
import type { ProjectAutomationLoader } from '../../scheduler-host/project-automation-loader';

// #8237, unit: invoke the registered IPC adapter. Loader-only tests miss dropped
// approval hashes and uncoded errors on the new pending-imports channel.
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: {
  removeHandler: (name: string) => handlers.delete(name),
  handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
} }));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../localDb/client/current', () => ({ getDbClient: vi.fn() }));
vi.mock('../../device-link/broadcast-tap', () => ({ tapWindowBroadcast: vi.fn() }));

import { registerProjectAutomationIpc } from '../project-automation';

it('forwards discovery and explicit approval, rejecting invalid inputs and coded failures', async () => {
  const pending = [{ workingDir: '/project', configHash: 'snapshot', schedules: [], removedNames: ['Old'] }];
  const listPendingImports = vi.fn().mockResolvedValue(pending);
  const reconcile = vi.fn().mockResolvedValue({ pendingImport: pending[0] });
  registerProjectAutomationIpc(async () => ({ onEvent: () => () => {}, listPendingImports, reconcile } as unknown as ProjectAutomationLoader));
  const list = handlers.get('maker:project-automation:pending-imports')!;
  const apply = handlers.get('maker:project-automation:reconcile')!;
  expect(await list()).toEqual(pending);
  await apply({}, { workingDir: '/project' });
  expect(reconcile).toHaveBeenLastCalledWith('/project', undefined);
  await apply({}, { workingDir: '/project', approvedHash: 'snapshot' });
  expect(reconcile).toHaveBeenLastCalledWith('/project', 'snapshot');
  await expect(apply({}, { workingDir: '/project', approvedHash: true })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  expect(reconcile).toHaveBeenCalledTimes(2);
  listPendingImports.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(list()).rejects.toMatchObject({ code: 'INTERNAL' });
});

// 2026-11-10 startup regression: the registered handler must exist before the
// loader, then return actual pending imports. Unit; old tests only used ready loaders.
it('registers before a slow loader and preserves the pending import until it is ready', async () => {
  let release!: (loader: ProjectAutomationLoader) => void;
  const ready = new Promise<ProjectAutomationLoader>(resolve => { release = resolve; });
  registerProjectAutomationIpc(() => ready);
  const pending = [{ workingDir: '/project', configHash: 'saved', schedules: [] }];
  const listPendingImports = vi.fn().mockResolvedValue(pending);
  const read = handlers.get('maker:project-automation:pending-imports')!();
  expect(listPendingImports).not.toHaveBeenCalled();
  release({ listPendingImports } as unknown as ProjectAutomationLoader);
  await expect(read).resolves.toEqual(pending);
});

it('returns startup failure without touching consent data or applying an import', async () => {
  registerProjectAutomationIpc(async () => {
    throw Object.assign(new Error('account changed'), { code: 'PRECONDITION_FAILED' });
  });
  await expect(handlers.get('maker:project-automation:reconcile')!({}, {
    workingDir: '/project', approvedHash: 'saved',
  })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
});
