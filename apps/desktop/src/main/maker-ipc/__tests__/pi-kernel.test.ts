import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPiKernelIpc } from '../pi-kernel.js';
import { PiKernelError } from '../../agent-binaries/pi-kernel-manager.js';
vi.mock('../../agent-binaries/index.js', () => ({ getPiKernelManager: vi.fn() }));
vi.mock('../../manifestService.js', () => ({ getBaseUrl: vi.fn(), getPlatformKey: vi.fn() }));
const manager = { state: vi.fn(), check: vi.fn(), install: vi.fn() };
const assertSender = vi.fn();
const handlers = createPiKernelIpc({ assertSender, manager: () => manager });
beforeEach(() => { vi.resetAllMocks(); manager.state.mockResolvedValue({ currentVersion: '0.87.1' }); });
describe('Pi version IPC boundary', () => {
  it('requires the trusted main renderer before any read or write', async () => {
    assertSender.mockImplementation(() => { throw new Error('untrusted'); });
    await expect(handlers.state({}, true)).rejects.toThrow('untrusted');
    await expect(handlers.install({}, { source: 'upstream', version: '0.87.1' })).rejects.toThrow('untrusted');
    expect(manager.check).not.toHaveBeenCalled(); expect(manager.install).not.toHaveBeenCalled();
  });
  it.each([null, [], { source: 'local', version: '0.87.1' }, { source: 'upstream', version: '../pi' }, { source: 'official', version: '0.84.4', url: 'https://example.test' }])('rejects arbitrary targets and malformed requests', async input => {
    await expect(handlers.install({}, input)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(manager.install).not.toHaveBeenCalled();
  });
  it('passes only a source and expected version to the shared manager', async () => {
    await expect(handlers.install({}, { source: 'official', version: '0.84.4' })).resolves.toEqual({ currentVersion: '0.87.1' });
    expect(manager.install).toHaveBeenCalledWith({ source: 'official', version: '0.84.4' });
  });
  it('preserves the changed-target error but never returns internal filesystem details', async () => {
    manager.install.mockRejectedValueOnce(new PiKernelError('version-changed'));
    await expect(handlers.install({}, { source: 'upstream', version: '0.87.1' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: '[PRECONDITION_FAILED] version-changed' });
    manager.install.mockRejectedValueOnce(new Error('/Users/private/secret'));
    await expect(handlers.install({}, { source: 'upstream', version: '0.87.1' })).rejects.toMatchObject({ code: 'INTERNAL', message: '[INTERNAL] Pi kernel installation failed' });
  });
});
