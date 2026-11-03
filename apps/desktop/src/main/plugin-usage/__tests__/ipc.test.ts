import { expect, it, vi } from 'vitest';
import { registerPluginUsageIpc } from '../ipc';
import type { PluginUsageService } from '../service';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { withGhostInstallLock } from '../../cindy-brain/ghostInstallLock';
import type { PluginUsageIdentity } from '../../../shared/pluginUsage';
function harness(trusted = true, lockId?: (id: string) => string) {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const service = {
    summary: vi.fn(async () => null),
    history: vi.fn(async () => []),
    clear: vi.fn(async () => {}),
    bind: vi.fn(),
    capture: vi.fn(),
  } as unknown as PluginUsageService;
  const warn = vi.fn();
  const identity = vi.fn<() => PluginUsageIdentity | null>(() => null);
  const current = { service };
  registerPluginUsageIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) } as Pick<IpcMain, 'handle'>,
    assertTrusted: () => {
      if (!trusted) throw new Error('Untrusted frame');
    },
    service: () => current.service,
    identity,
    lockId,
    warn,
  });
  return { handlers, service, warn, identity, current };
}
it('checks trusted top-level app sender on every usage endpoint before reading or clearing', async () => {
  const { handlers, service } = harness(false);
  for (const handler of handlers.values())
    await expect(handler({} as IpcMainInvokeEvent, null)).rejects.toThrow('Untrusted frame');
  expect(service.summary).not.toHaveBeenCalled();
  expect(service.clear).not.toHaveBeenCalled();
  expect(service.history).not.toHaveBeenCalled();
});
it('waits for the install transaction before reading a revision or creating a history binding', async () => {
  const { handlers, service, identity } = harness();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const updating = withGhostInstallLock('upgrading-plugin', async () => {
    entered();
    await new Promise<void>((r) => {
      release = r;
    });
  });
  await ready;
  const summary = handlers.get('ghosts:usage-summary')!(
    {} as IpcMainInvokeEvent,
    'upgrading-plugin',
  );
  await Promise.resolve();
  expect(identity).not.toHaveBeenCalled();
  expect(service.bind).not.toHaveBeenCalled();
  release();
  await updating;
  await expect(summary).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(identity).toHaveBeenCalledOnce();
});
it('does not read the next owner when an account changes while waiting for installation', async () => {
  const { handlers, identity, current } = harness();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const updating = withGhostInstallLock('switching-plugin', async () => {
    entered();
    await new Promise<void>((r) => {
      release = r;
    });
  });
  await ready;
  const summary = handlers.get('ghosts:usage-summary')!(
    {} as IpcMainInvokeEvent,
    'switching-plugin',
  );
  current.service = {} as PluginUsageService;
  release();
  await updating;
  await expect(summary).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(identity).not.toHaveBeenCalled();
});
it('never treats a missing or malformed subject as clear-all; only explicit null clears all', async () => {
  const { handlers, service } = harness();
  const clear = handlers.get('ghosts:usage-clear')!;
  for (const id of [undefined, {}, 42, 'a'.repeat(36)])
    await expect(clear({} as IpcMainInvokeEvent, id)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  expect(service.clear).not.toHaveBeenCalled();
  await clear({} as IpcMainInvokeEvent, null);
  expect(service.clear).toHaveBeenCalledWith(null);
  const id = '12345678-1234-1234-1234-123456789012';
  await clear({} as IpcMainInvokeEvent, id);
  expect(service.clear).toHaveBeenLastCalledWith(id);
});
it('hides database failures and preserves deliberate visibility and argument errors', async () => {
  const { handlers, service, warn } = harness();
  vi.mocked(service.history).mockRejectedValue(new Error('SQL secret path'));
  await expect(
    handlers.get('ghosts:usage-history')!({} as IpcMainInvokeEvent),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.not.stringContaining('secret'),
  });
  expect(warn).toHaveBeenCalledOnce();
  await expect(
    handlers.get('ghosts:usage-summary')!({} as IpcMainInvokeEvent, 'valid-plugin'),
  ).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

it('accepts an instance key while waiting on the existing logical package lock', async () => {
  const { handlers, identity } = harness(true, () => 'same-name');
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const updating = withGhostInstallLock('same-name', async () => {
    entered();
    await new Promise<void>((resolve) => { release = resolve; });
  });
  await ready;
  const summary = handlers.get('ghosts:usage-summary')!({} as IpcMainInvokeEvent, '_ns__acme__same-name');
  await Promise.resolve();
  expect(identity).not.toHaveBeenCalled();
  release();
  await updating;
  await expect(summary).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(identity).toHaveBeenCalledWith('_ns__acme__same-name');
});
