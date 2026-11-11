import { describe, expect, it, vi } from 'vitest';
import { validateGhostManifest as validateProtocol } from '@cindy/plugin-protocol';
import { validateGhostManifest, type InstalledGhost } from '../../../shared/ghost.js';
import { spawnResidentGhost } from '../residentGhost.js';

const manifest = {
  schemaVersion: 3, minCindyVersion: '0.1.72', id: 'event-publisher', name: 'Events',
  description: 'Local events', version: '1.0.0', kind: 'chip', entry: 'index.html',
  routineEvents: { events: [{ type: 'mail', name: 'Mail', fields: [] }] },
};
const deps = () => ({ isAvailable: () => true, startNode: vi.fn(), spawnBrowser: vi.fn(async () => ({ ok: true })), warn: vi.fn() });

// Routines were removed: an installed event publisher still validates, but `routineEvents`
// alone no longer keeps it running; only `launch: 'resident'` does.
describe.each([['desktop', validateGhostManifest], ['protocol', validateProtocol]] as const)(
  '%s event publisher compatibility', (_name, validate) => {
    it.each([undefined, 'on-demand'] as const)('installs a publisher with launch=%s without starting it', (launch) => {
      const checked = validate({ ...manifest, ...(launch ? { launch } : {}) });
      if (!checked.ok) throw new Error(checked.reason);
      const d = deps();
      spawnResidentGhost({ enabled: true, manifest: checked.manifest } as InstalledGhost, d);
      expect(d.spawnBrowser).not.toHaveBeenCalled();
      expect(d.startNode).not.toHaveBeenCalled();
    });
  },
);

it('preserves disabled/unavailable gates for a resident plugin', () => {
  const checked = validateGhostManifest({ ...manifest, launch: 'resident' });
  if (!checked.ok) throw new Error(checked.reason);
  const ghost = { enabled: true, manifest: checked.manifest } as InstalledGhost;
  const d = deps();
  spawnResidentGhost({ ...ghost, enabled: false }, d);
  spawnResidentGhost(ghost, { ...d, isAvailable: () => false });
  expect(d.startNode).not.toHaveBeenCalled();
  expect(d.spawnBrowser).not.toHaveBeenCalled();
  spawnResidentGhost(ghost, d);
  expect(d.spawnBrowser).toHaveBeenCalledOnce();
});

it('starts a pending resident install without waiting for namespace confirmation', () => {
  const checked = validateGhostManifest({ ...manifest, launch: 'resident' });
  if (!checked.ok) throw new Error(checked.reason);
  const ghost = { enabled: true, manifest: checked.manifest, namespaceState: 'pending' } as InstalledGhost;
  const d = deps();
  spawnResidentGhost(ghost, d);
  expect(d.spawnBrowser).toHaveBeenCalledOnce();
  spawnResidentGhost({ ...ghost, enabled: false }, d);
  expect(d.spawnBrowser).toHaveBeenCalledOnce();
});
