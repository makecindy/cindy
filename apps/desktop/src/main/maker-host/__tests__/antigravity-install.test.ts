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
import * as proxyBridge from '../cli-proxy-bridge';
import { createMakerLogger } from '../logger-adapter';
import { resolveDesktopOutboundProxy } from '../outbound-proxy-resolver';

it.runIf(runtime.supportsAntigravityRuntime())(
  'keeps the working account and CLI until an upgrade passes both verification steps',
  async () => {
    const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'agy-install-test-'));
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
    const spawn = vi.spyOn(transport, 'spawnAcp').mockImplementation(() => ({} as ReturnType<typeof transport.spawnAcp>));
    const probe = vi.spyOn(agent, 'probeAntigravityRuntime').mockResolvedValue(undefined);
    const bridgeUrl = 'http://127.0.0.1:17893';
    const bridge = vi.spyOn(proxyBridge, 'ensureCliProxyBridge').mockResolvedValue(bridgeUrl);
    const proxyKeys = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'];
    if (process.platform !== 'win32') proxyKeys.push('https_proxy', 'http_proxy', 'all_proxy');
    for (const key of proxyKeys) {
      vi.stubEnv(key, undefined);
    }
    const retire = vi.fn(async () => {});
    try {
      const agy = buildAntigravityAgent(directory, createMakerLogger('agy-install-test'), undefined, retire)!;
      const accounts = getAntigravityAccounts()!;
      const initial = await accounts.install();
      const first = await readConfig();
      expect(initial).toMatchObject({ configured: true, connected: false });
      expect(signature.mock.invocationCallOrder[0]).toBeLessThan(probe.mock.invocationCallOrder[0]);

      // Unit: desktop launch with no shell proxy must supply the system proxy
      // bridge to both isolated runtime probes and login (old tests only checked compatibility).
      expect(bridge).toHaveBeenCalledWith(resolveDesktopOutboundProxy);
      expect(spawn.mock.calls[0]?.[3]).toMatchObject({ httpsProxy: bridgeUrl, isolatedHome: expect.any(String) });
      const stopAtSpawn = new Error('test stops before native OAuth');
      spawn.mockImplementationOnce(() => { throw stopAtSpawn; });
      await expect(agy.triggerLogin()).rejects.toThrow(stopAtSpawn);
      expect(spawn.mock.lastCall?.[3]).toMatchObject({ httpsProxy: bridgeUrl, profileStorage: true });

      const explicitKey = process.platform === 'win32' ? 'HTTPS_PROXY' : 'https_proxy';
      vi.stubEnv(explicitKey, 'http://explicit-proxy.example:8080');
      const bridgeCalls = bridge.mock.calls.length;
      spawn.mockImplementationOnce(() => { throw stopAtSpawn; });
      await expect(agy.triggerLogin()).rejects.toThrow(stopAtSpawn);
      expect(spawn.mock.lastCall?.[3]).toMatchObject({ httpsProxy: undefined });
      expect(bridge).toHaveBeenCalledTimes(bridgeCalls);
      vi.stubEnv(explicitKey, undefined);

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
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
