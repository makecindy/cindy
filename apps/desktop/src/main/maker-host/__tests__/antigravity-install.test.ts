import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as agent from '@cindy/maker-core/agents/antigravity';
import * as transport from '@cindy/maker-core/agents/antigravity-transport';
import * as session from '../../appSessionState';
import * as download from '../antigravity-download';
import * as runtime from '../antigravity-runtime';
import { buildAntigravityAgent, getAntigravityAccounts } from '../antigravity-host';
import { createMakerLogger } from '../logger-adapter';

it.runIf(runtime.supportsAntigravityRuntime())(
  'keeps the working account and CLI until an upgrade passes both verification steps',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-install-test-'));
    const ownerId = 'managed-install-test-owner';
    const storage = path.join(directory, 'google-subscription', createHash('sha256').update(ownerId).digest('hex').slice(0, 24));
    const configPath = path.join(storage, 'connection.json');
    const managed = path.join(storage, 'managed-runtimes', 'antigravity');
    const readConfig = async () => JSON.parse(await fs.readFile(configPath, 'utf8'));
    vi.spyOn(session, 'getActiveAppSession').mockReturnValue({ mode: 'local', dataOwnerId: ownerId, generation: 1 });
    const release = vi.spyOn(download, 'fetchAntigravityRelease').mockResolvedValue({ version: '1.5.13', url: 'test', sha512: 'a'.repeat(128) });
    const fetchBinary = vi.spyOn(download, 'downloadAntigravityRelease').mockImplementation(async (_fetcher, _release, _platform, stage) => {
      const file = path.join(stage, 'agy.exe');
      await fs.writeFile(file, 'mock runtime');
      return file;
    });
    const signature = vi.spyOn(runtime, 'assertVerifiedAntigravityBinary').mockImplementation(file => file);
    vi.spyOn(transport, 'spawnAcp').mockImplementation(() => ({} as ReturnType<typeof transport.spawnAcp>));
    const probe = vi.spyOn(agent, 'probeAntigravityRuntime').mockResolvedValue(undefined);
    const retire = vi.fn(async () => {});
    try {
      buildAntigravityAgent(directory, createMakerLogger('agy-install-test'), undefined, retire);
      const accounts = getAntigravityAccounts()!;
      const initial = await accounts.install();
      const first = await readConfig();
      expect(initial).toMatchObject({ configured: true, connected: false });
      expect(signature.mock.invocationCallOrder[0]).toBeLessThan(probe.mock.invocationCallOrder[0]);

      expect(await accounts.install()).toMatchObject({ activeId: initial.activeId });
      expect(fetchBinary).toHaveBeenCalledTimes(1);
      expect(retire).not.toHaveBeenCalled();

      release.mockResolvedValue({ version: '1.5.14', url: 'test', sha512: 'b'.repeat(128) });
      probe.mockRejectedValueOnce(new Error('incompatible ACP'));
      await expect(accounts.install()).rejects.toThrow('incompatible ACP');
      expect(await readConfig()).toEqual(first);
      expect(await fs.readdir(managed)).toEqual([path.basename(path.dirname(first.binaryPath))]);
      expect(retire).not.toHaveBeenCalled();

      expect(await accounts.install()).toMatchObject({ configured: true, activeId: initial.activeId });
      const last = await readConfig();
      expect(last.binaryPath).not.toBe(first.binaryPath);
      expect(last.managedRelease).toBe('b'.repeat(128));
      expect(last.profiles).toEqual(first.profiles);
      expect(retire).toHaveBeenCalledOnce();

      await accounts.remove(initial.activeId!);
      const callsBeforeReconnect = fetchBinary.mock.calls.length;
      const reconnected = await accounts.install();
      expect(reconnected).toMatchObject({ configured: true, connected: false });
      expect(reconnected.activeId).not.toBe(initial.activeId);
      expect(reconnected.activeId).not.toBeNull();
      expect(fetchBinary).toHaveBeenCalledTimes(callsBeforeReconnect);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
