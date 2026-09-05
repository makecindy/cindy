/**
 * #3914: on non-macOS the module singleton must not try to own the Darwin
 * ownership registry (its writer lease is never granted there), otherwise the
 * Host reports DEVICE_BUSY before the runtime can report UNSUPPORTED_PLATFORM
 * — and no reboot can clear a lease that was never taken.
 *
 * Lives in its own file: the default Host is a module singleton whose disposal
 * is one-way, so it cannot share a module instance with the darwin suites.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { IOSSimulatorOwnershipRegistryFile } from '@cindy/ios-simulator-runtime';

// Same owner-boundary override as ios-simulator.test.ts: these cases exercise
// platform gating, not owner transitions.
vi.mock('../../appSessionState.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../appSessionState.js')>();
  return { ...actual, isAppSessionBoundaryPending: () => false };
});

import { disposeIOSSimulatorHost, initializeIOSSimulatorHost } from '../ios-simulator';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function localSession(id: string) {
  return { id, workDir: `/tmp/${id}`, remoteHostId: null };
}

describe('iOS Simulator host on a non-macOS platform (#3914)', () => {
  beforeAll(() => {
    setPlatform('win32');
  });

  afterAll(async () => {
    await disposeIOSSimulatorHost();
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('reports UNSUPPORTED_PLATFORM without touching the ownership registry or its lock', async () => {
    const acquireWriter = vi.spyOn(IOSSimulatorOwnershipRegistryFile.prototype, 'acquireWriterSync');
    // Point the profile at a fresh directory: the non-macOS Host may still resolve
    // userData for unrelated cache roots (WDA archive cache), but it must never
    // materialise the Darwin ownership registry, its writer lock, device grants or
    // interrupted-create evidence there.
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-ios-sim-win32-'));
    const getPath = vi.spyOn(app, 'getPath').mockReturnValue(root);
    try {
      const host = initializeIOSSimulatorHost({
        getSession: async (id) => localSession(id),
      });

      const environment = await host.callTool('check_environment', {}, {
        sessionId: 'win-session',
        origin: 'user',
      });
      expect(environment).toMatchObject({
        ok: true,
        data: {
          supported: false,
          ready: false,
          issue: 'UNSUPPORTED_PLATFORM',
          error: 'iOS Simulator is available only for local macOS sessions.',
        },
      });
      expect(JSON.stringify(environment)).not.toContain('Another Cindy process');

      const tools = await host.describeTools('win-session');
      expect(tools.ready).toBe(false);
      expect(tools.tools.check_environment).toMatchObject({ state: 'available' });
      expect(tools.tools.list_simulator_devices).toMatchObject({
        state: 'unavailable',
        reasonCode: 'UNSUPPORTED_PLATFORM',
      });

      // The Darwin-only registry must stay untouched: no writer lease attempt and
      // no registry / lock / grants / evidence files under the profile.
      expect(acquireWriter).not.toHaveBeenCalled();
      const profileDir = path.join(root, 'ios-simulator');
      const materialised = existsSync(profileDir) ? readdirSync(profileDir) : [];
      expect(materialised).not.toContain('ownership-registry.json');
      expect(materialised).not.toContain('ownership-registry.json.writer.lock');
      expect(materialised).not.toContain('device-grants.json');
      expect(materialised).not.toContain('pending-create-evidence.json');
    } finally {
      acquireWriter.mockRestore();
      getPath.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
