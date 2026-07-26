import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceLinkClientOptions, Envelope } from '@cindy/device-link';
import { HeadlessConfigStore } from './config.js';
import { HeadlessControlService } from './control-service.js';
import { type HeadlessDeviceLinkClient } from './device-link-bridge.js';
import { HeadlessDeviceLinkService } from './device-link-service.js';
import { MemorySecretStore } from './secret-store.js';
import { HeadlessSessionStorage } from './session-storage.js';
import type { HeadlessCindyAccountService } from './cindy-account.js';

type RuntimeFakeClient = HeadlessDeviceLinkClient & {
  start(): void;
  stop(): void;
  getStatus(): 'online';
  getConnectionIssue(): null;
};

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('HeadlessDeviceLinkService', () => {
  it('creates only an outbound relay client after a secure token is configured and passes relay frames to the bridge', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-relay-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    const secrets = new MemorySecretStore();
    const base = await config.read();
    await config.write({
      ...base,
      remoteControlEnabled: true,
      deviceName: 'TownsLinux',
      deviceLink: { deviceId: 'linux-device', tokenRef: 'device_link_test', apiBaseUrl: 'https://relay.example.test', deviceName: 'Linux CI' },
    });
    await secrets.set('device_link_test', 'test-device-token');
    const control = new HeadlessControlService(storage, config, undefined, undefined, secrets);
    let onFrame: ((frame: Envelope) => void) | undefined;
    const accepts: unknown[] = [];
    const start = vi.fn();
    const stop = vi.fn();
    let factoryOptions: DeviceLinkClientOptions | undefined;
    const client: RuntimeFakeClient = {
      onFrame: (listener) => { onFrame = listener; return () => { onFrame = undefined; }; },
      sendInvokeResult: () => undefined,
      sendLinkAccept: (_dst, _id, payload) => accepts.push(payload),
      sendPush: () => undefined,
      getStatus: () => 'online',
      getConnectionIssue: () => null,
      start,
      stop,
    };
    const service = new HeadlessDeviceLinkService(
      storage, control, config, secrets, '0.1.0',
      (options) => { factoryOptions = options; return client; },
    );

    await service.start();
    expect(start).toHaveBeenCalledOnce();
    await expect(factoryOptions!.getToken()).resolves.toBe('test-device-token');
    expect(factoryOptions!.getWsUrl()).toBe('wss://relay.example.test/api/device-link/ws');
    expect(factoryOptions!.getHello()).toMatchObject({ platform: 'linux', remoteControlEnabled: true, deviceName: 'TownsLinux' });

    onFrame?.({ kind: 'link-open', id: 'open-1', src: 'phone-device', payload: { controllerName: 'Phone' } } as Envelope);
    await vi.waitFor(() => expect(accepts).toHaveLength(1));
    expect(accepts).toHaveLength(1);
    service.stop();
    expect(stop).toHaveBeenCalledOnce();
    storage.close();
  });

  it('uses the signed-in Cindy account token for Device Link without importing a second token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-account-relay-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    await config.write({ ...(await config.read()), account: { deviceId: 'linux-device', region: 'cn' } });
    const secrets = new MemorySecretStore();
    const control = new HeadlessControlService(storage, config, undefined, undefined, secrets);
    let options: DeviceLinkClientOptions | undefined;
    const client: RuntimeFakeClient = {
      onFrame: () => () => undefined, sendInvokeResult: () => undefined, sendLinkAccept: () => undefined, sendPush: () => undefined,
      getStatus: () => 'online', getConnectionIssue: () => null,
      start: vi.fn(), stop: vi.fn(),
    };
    const account = {
      getDeviceLinkApiBase: () => 'https://relay.cindy.example.test',
      getRelayToken: async () => 'cindy-access-token',
    } as unknown as HeadlessCindyAccountService;
    const service = new HeadlessDeviceLinkService(storage, control, config, secrets, '0.1.0', (input) => { options = input; return client; }, account);

    await service.start();
    await expect(options!.getToken()).resolves.toBe('cindy-access-token');
    expect(options!.getWsUrl()).toBe('wss://relay.cindy.example.test/api/device-link/ws');
    service.stop();
    storage.close();
  });

  it('rebuilds the outbound relay client when authentication or remote-control state changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-relay-restart-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    const secrets = new MemorySecretStore();
    await config.write({ ...(await config.read()), deviceLink: { deviceId: 'linux-device', tokenRef: 'device-link', apiBaseUrl: 'https://relay.example.test' } });
    await secrets.set('device-link', 'token');
    const control = new HeadlessControlService(storage, config, undefined, undefined, secrets);
    const client: RuntimeFakeClient = {
      onFrame: () => () => undefined, sendInvokeResult: () => undefined, sendLinkAccept: () => undefined, sendPush: () => undefined,
      getStatus: () => 'online', getConnectionIssue: () => null,
      start: vi.fn(), stop: vi.fn(),
    };
    const service = new HeadlessDeviceLinkService(storage, control, config, secrets, '0.1.0', () => client);

    await service.start();
    await service.restart();
    expect(client.start).toHaveBeenCalledTimes(2);
    expect(client.stop).toHaveBeenCalledTimes(1);
    service.stop();
    storage.close();
  });
});
