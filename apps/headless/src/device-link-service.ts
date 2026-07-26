import os from 'node:os';
import WebSocket from 'ws';
import { DeviceLinkClient, type DeviceLinkConnectionIssue, type DeviceLinkStatus, type HelloPayload } from '@cindy/device-link';
import type { HeadlessConfigStore } from './config.js';
import { HeadlessDeviceLinkBridge, type HeadlessDeviceLinkClient } from './device-link-bridge.js';
import type { HeadlessControlService } from './control-service.js';
import type { HeadlessSecretStore } from './secret-store.js';
import type { HeadlessSessionEventSource, HeadlessSessionEventStorage, HeadlessSessionStorageContract } from './session-types.js';
import { isRemoteWorkdirAllowed } from './workdir-guard.js';
import type { HeadlessCindyAccountService } from './cindy-account.js';
import type { HeadlessInputQueue } from './input-queue.js';
import type { HeadlessMediaService } from './media-service.js';

type DeviceLinkStorage = HeadlessSessionStorageContract & HeadlessSessionEventStorage & Partial<HeadlessSessionEventSource>;
type DeviceLinkClientRuntime = HeadlessDeviceLinkClient & {
  start(): void;
  stop(): void;
  getStatus(): DeviceLinkStatus;
  getConnectionIssue(): DeviceLinkConnectionIssue | null;
};
type DeviceLinkClientFactory = (options: ConstructorParameters<typeof DeviceLinkClient>[0]) => DeviceLinkClientRuntime;
type DeviceLinkLogger = { debug(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };

/**
 * Owns the outbound relay connection for a Linux daemon.  It is deliberately
 * inactive until a user has securely imported a Cindy account token, so a
 * fresh server never opens a network connection merely by being installed.
 */
export class HeadlessDeviceLinkService {
  private client: DeviceLinkClientRuntime | null = null;
  private bridge: HeadlessDeviceLinkBridge | null = null;

  constructor(
    private readonly storage: DeviceLinkStorage,
    private readonly control: HeadlessControlService,
    private readonly config: HeadlessConfigStore,
    private readonly secrets: HeadlessSecretStore,
    private readonly appVersion = '0.1.0',
    private readonly createClient: DeviceLinkClientFactory = (options) => new DeviceLinkClient(options),
    private readonly account?: HeadlessCindyAccountService,
    private readonly inputQueue?: HeadlessInputQueue,
    private readonly logger?: DeviceLinkLogger,
    private readonly media?: HeadlessMediaService,
  ) {}

  async start(): Promise<void> {
    if (this.client) return;
    const config = await this.config.read();
    const deviceLink = config.deviceLink;
    const accountBase = this.account?.getDeviceLinkApiBase();
    if (!accountBase && !deviceLink) return;
    const apiBaseUrl = accountBase ?? deviceLink!.apiBaseUrl;
    const wsUrl = `${trimTrailingSlash(apiBaseUrl).replace(/^http/, 'ws')}/api/device-link/ws`;
    const client = this.createClient({
      getWsUrl: () => wsUrl,
      getToken: () => accountBase ? this.account!.getRelayToken() : this.secrets.get(deviceLink!.tokenRef),
      getHello: (): HelloPayload => ({
        deviceName: config.deviceName ?? deviceLink?.deviceName ?? os.hostname(),
        platform: 'linux',
        appVersion: this.appVersion,
        remoteControlEnabled: config.remoteControlEnabled,
        busy: false,
      }),
      createWebSocket: (url, headers) => new WebSocket(url, { headers }),
      logger: {
        debug: (...args) => this.logger?.debug(...args),
        info: (...args) => this.logger?.info(...args),
        warn: (...args) => this.logger?.warn(...args),
        error: (...args) => this.logger?.error(...args),
      },
    });
    this.bridge = new HeadlessDeviceLinkBridge({
      client,
      control: this.control,
      storage: this.storage,
      remoteControlEnabled: async () => (await this.config.read()).remoteControlEnabled,
      isWorkdirAllowed: (workdir) => isRemoteWorkdirAllowed(this.config, workdir),
      appVersion: this.appVersion,
      inputQueue: this.inputQueue,
      media: this.media,
    });
    this.bridge.start();
    this.client = client;
    this.logger?.info('Device Link client starting', { wsUrl, remoteControlEnabled: config.remoteControlEnabled });
    client.start();
  }

  /** Rebuild hello/token routing after account or remote-control state changes. */
  async restart(): Promise<void> {
    this.stop();
    await this.start();
  }

  status(): { status: DeviceLinkStatus; issue: DeviceLinkConnectionIssue | null } {
    return {
      status: this.client?.getStatus() ?? 'stopped',
      issue: this.client?.getConnectionIssue() ?? null,
    };
  }

  stop(): void {
    this.logger?.info('Device Link client stopping');
    this.bridge?.stop();
    this.bridge = null;
    this.client?.stop();
    this.client = null;
  }
}

function trimTrailingSlash(value: string): string {
  let result = value;
  while (result.endsWith('/')) result = result.slice(0, -1);
  return result;
}
