import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as appSessionState from '../../appSessionState';
import { buildAntigravityAgent, getAntigravityAccounts } from '../antigravity-host';
import { supportsAntigravityRuntime } from '../antigravity-runtime';
import { createMakerLogger } from '../logger-adapter';

it.runIf(process.env.CINDY_AGY_LIVE_TEST === '1' && supportsAntigravityRuntime())(
  'downloads, verifies and binds the Google stable CLI, then reuses it on update',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-live-install-'));
    const ownerId = 'test-managed-antigravity-owner';
    const owner = vi.spyOn(appSessionState, 'getActiveAppSession')
      .mockReturnValue({ mode: 'local', dataOwnerId: ownerId, generation: 1 });
    try {
      buildAntigravityAgent(directory, createMakerLogger('agy-live-install'));
      const accounts = getAntigravityAccounts()!;
      const root = path.join(directory, 'google-subscription', createHash('sha256').update(ownerId).digest('hex').slice(0, 24));
      const configPath = path.join(root, 'connection.json');
      const installed = await accounts.install();
      expect(installed).toMatchObject({ configured: true, connected: false });
      expect(installed.activeId).toBeTruthy();
      const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as { binaryPath: string; managedRelease: string };
      expect(path.dirname(path.dirname(config.binaryPath))).toBe(path.join(root, 'managed-runtimes', 'antigravity'));
      expect(config.managedRelease).toMatch(/^[a-f0-9]{128}$/);
      expect((await fs.stat(config.binaryPath)).size).toBeGreaterThan(0);

      expect(await accounts.install()).toMatchObject({ configured: true, activeId: installed.activeId });
      const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(updated).toEqual(config);
      console.info('Managed Antigravity release:', path.basename(path.dirname(config.binaryPath)));
    } finally {
      owner.mockRestore();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
  360_000,
);
