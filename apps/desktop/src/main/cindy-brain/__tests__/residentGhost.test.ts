import { describe, expect, it, vi } from 'vitest';
import { RoutineEngine } from '@cindy/maker-scheduler';
import { validateGhostManifest as validateProtocol } from '@cindy/plugin-protocol';
import { validateGhostManifest, type InstalledGhost } from '../../../shared/ghost.js';
import { spawnResidentGhost } from '../residentGhost.js';
import { handleRoutineRequest } from '../routineSlot.js';

const manifest = {
  schemaVersion: 3, minCindyVersion: '0.1.72', id: 'event-publisher', name: 'Events',
  description: 'Local events', version: '1.0.0', kind: 'chip', entry: 'index.html',
  routineEvents: { events: [{ type: 'mail', name: 'Mail', fields: [] }] },
};

describe.each([['desktop', validateGhostManifest], ['protocol', validateProtocol]] as const)(
  '%s publisher startup compatibility', (_name, validate) => {
    it.each([undefined, 'on-demand'])('starts an existing publisher with launch=%s and registers its source', async (launch) => {
      const checked = validate({ ...manifest, ...(launch ? { launch } : {}) });
      if (!checked.ok) throw new Error(checked.reason);
      const ghost = { enabled: true, manifest: checked.manifest } as InstalledGhost;
      const engine = new RoutineEngine({
        load: async () => null, save: async () => {}, execute: async () => ({}),
        now: () => 1, id: () => 'run', changed: () => {}, onError: () => {},
      });
      await engine.start();
      const deps = {
        isAvailable: () => true, startNode: vi.fn(), warn: vi.fn(),
        spawnBrowser: vi.fn(async (installed: InstalledGhost) => {
          const result = await handleRoutineRequest(installed, { action: 'status', status: 'listening' }, async () => engine, () => true);
          expect(result.ok).toBe(true);
          return { ok: true };
        }),
      };
      spawnResidentGhost(ghost, deps);
      await vi.waitFor(() => expect(engine.listSources()).toMatchObject([{ id: 'plugin:event-publisher', status: 'listening' }]));
      expect(deps.spawnBrowser).toHaveBeenCalledOnce();
      expect(deps.startNode).not.toHaveBeenCalled();
      expect(ghost.manifest.launch).toBe(launch);
      await engine.stop();
    });
  },
);

it('preserves disabled/unavailable gates and ordinary on-demand startup behavior', () => {
  const checked = validateGhostManifest(manifest);
  if (!checked.ok) throw new Error(checked.reason);
  const ghost = { enabled: true, manifest: checked.manifest } as InstalledGhost;
  const deps = { isAvailable: () => true, startNode: vi.fn(), spawnBrowser: vi.fn(), warn: vi.fn() };
  spawnResidentGhost({ ...ghost, enabled: false }, deps);
  spawnResidentGhost(ghost, { ...deps, isAvailable: () => false });
  spawnResidentGhost({ ...ghost, manifest: { ...ghost.manifest, routineEvents: undefined } }, deps);
  expect(deps.startNode).not.toHaveBeenCalled();
  expect(deps.spawnBrowser).not.toHaveBeenCalled();
});
