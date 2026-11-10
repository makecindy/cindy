import { describe, expect, it, vi } from 'vitest';
import { setPluginEnabled, type PluginEnableServicePorts } from '../pluginEnableService';
import type { InstalledGhost } from '../../../shared/ghost';

// Desktop parity: caller cancellation after the durable receipt commits must
// not skip resident startup or disable-side projections. Unit: one committed
// write; no process/network/DB. Before-commit cancellation must still reject.
describe('plugin enable commit boundary', () => {
  it.each([true, false])('finishes effects after persisting enabled=%s despite caller cancellation', async enabled => {
    let canceled = false;
    const release = vi.fn();
    const ports: PluginEnableServicePorts = {
      find: () => ({ manifest: { id: 'audit' }, dir: '/plugins/audit' }) as InstalledGhost,
      requireAvailable: vi.fn(), notFound: message => { throw new Error(message); },
      acquire: () => release, stop: vi.fn(async () => undefined),
      persist: vi.fn(async () => { canceled = true; }),
      start: vi.fn(), didChange: vi.fn(async () => undefined),
    };
    const assertCurrent = () => { if (canceled) throw new Error('caller canceled'); };
    await expect(setPluginEnabled(ports, 'audit', enabled, undefined, assertCurrent)).resolves.toEqual({ ok: true });
    expect(ports.start).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(ports.didChange).toHaveBeenCalledWith('audit', enabled);
    expect(release).toHaveBeenCalledOnce();
    await expect(setPluginEnabled(ports, 'audit', enabled, undefined, assertCurrent)).rejects.toThrow('caller canceled');
    expect(ports.persist).toHaveBeenCalledOnce();
  });
});
