/**
 * Controller side of the transfer baseline: the production `DeviceLinkClient`
 * (reliable transport, invoke transfer cache / gzip / message-body reuse, session tag
 * catalog) plus the shared `HistoryViewController` that both Mobile and Desktop drive
 * their task history with. App shells (React / React Native, disk caches, UI state)
 * are replaced by the scripted request sequences in `scenarios.ts`, each of which
 * cites the controller code it mirrors.
 */
import WebSocket from 'ws';
import {
  DeviceLinkClient,
  DeviceLinkError,
  PROTOCOL_VERSION,
  type DeviceLinkTiming,
  type InvokePayload,
  type LinkOpenPayload,
} from '@cindy/device-link';
import {
  HistoryViewController,
  type HistoryMessageSource,
  type HistoryViewPage,
  type HistoryDetailPage,
  type HistoryWorkReference,
} from '@cindy/maker-shared/message-window';
import { desktopTransferCodec } from '../../main/device-link/transferCodec';
import type { ControllerProfile } from './profiles';
import { QUIET_TIMING } from './hostHarness';
import { pmdOption, readHarnessSwitches, stripTransferFields } from './switches';
import type { WireMeter } from './wireMeter';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

export interface BaselineController {
  profile: ControllerProfile;
  client: DeviceLinkClient;
  invoke<T = unknown>(channel: string, args?: unknown[]): Promise<T>;
  openLink(): Promise<void>;
  subscribe(topics: string[]): Promise<void>;
  /** Shared history controller wired with this profile's `messages:view` transport. */
  createHistoryView(sessionId: string): HistoryViewController<HistoryMessageSource>;
  /**
   * Simulate the controller losing its network: kill only this controller's TCP socket
   * and hold new connection attempts until `restoreNetwork()`. The client's own
   * reconnect loop does the rest.
   */
  dropNetwork(): void;
  restoreNetwork(): void;
  close(): void;
}

export function startBaselineController(options: {
  profile: ControllerProfile;
  wsUrl: string;
  credential: string;
  hostDeviceId: string;
  meter: WireMeter;
  /** Per-request transfer fields to strip before sending (switches.ts TRANSFER_BASELINE_DROP_TRANSFER). */
  dropTransfer?: readonly string[];
}): BaselineController {
  const { profile, hostDeviceId } = options;
  const dropTransfer = options.dropTransfer ?? [];
  const sockets: WebSocket[] = [];
  let networkUp: Promise<void> = Promise.resolve();
  let releaseNetwork: () => void = () => {};
  let networkDown = false;
  const timing: Partial<DeviceLinkTiming> = { ...profile.timing, ...QUIET_TIMING };
  const client = new DeviceLinkClient({
    getWsUrl: () => options.wsUrl,
    getToken: async () => options.credential,
    authorizationScheme: 'CindyRelay',
    getHello: () => ({
      capabilities: profile.helloCapabilities,
      deviceName: profile.deviceName,
      platform: profile.platform,
      appVersion: '0.0.0-baseline',
      remoteControlEnabled: profile.remoteControlEnabled,
      busy: false,
    }),
    // Both controllers declare gunzip support, so the host may gzip results
    // (Mobile: DeviceLinkContext.tsx `transferCodec`, Desktop: index.ts connectionOptions).
    transferCodec: desktopTransferCodec,
    peerFailurePolicy: profile.peerFailurePolicy,
    ...(profile.peerResetReadRetry ? { peerResetReadRetry: true } : {}),
    timing,
    logger: quietLogger,
    createWebSocket: async (url, headers) => {
      await networkUp;
      const ws = options.meter.tap(new WebSocket(url, { headers, ...pmdOption(readHarnessSwitches().pmdController) }), 'controller');
      if (dropTransfer.length) {
        // Rewrite before the meter's send hook, so the meter counts what actually leaves.
        const send = ws.send.bind(ws) as (data: unknown, ...rest: unknown[]) => void;
        (ws as unknown as { send: (...args: unknown[]) => void }).send = (data: unknown, ...rest: unknown[]) =>
          send(typeof data === 'string' ? stripTransferFields(data, dropTransfer) : data, ...rest);
      }
      sockets.push(ws);
      return ws;
    },
  });
  const invoke = async <T,>(channel: string, args: unknown[] = []): Promise<T> => {
    const reply = await client.invoke(hostDeviceId, { channel, args } satisfies InvokePayload);
    if (!reply.ok) throw new DeviceLinkError('INTERNAL', `${channel} rejected: ${reply.error?.message ?? 'unknown'}`);
    return reply.result as T;
  };
  client.start();
  return {
    profile,
    client,
    invoke,
    async openLink() {
      await client.openLink(hostDeviceId, {
        controllerName: profile.deviceName,
        protocolVersion: PROTOCOL_VERSION,
        appVersion: '0.0.0-baseline',
        capabilities: profile.controllerCapabilities,
      } satisfies LinkOpenPayload);
    },
    async subscribe(topics) {
      await invoke('device-link:subscribe', [profile.subscribeArgs(topics, profile.controllerCapabilities)]);
    },
    createHistoryView(sessionId) {
      return new HistoryViewController<HistoryMessageSource>({
        refreshOnResume: false,
        page: (before) => invoke<HistoryViewPage<HistoryMessageSource>>('local-db:messages:view',
          [sessionId, profile.historyViewOptions(before)]),
        details: (ref: HistoryWorkReference, after?: string) => invoke<HistoryDetailPage<HistoryMessageSource>>(
          'local-db:messages:work-details', [sessionId, ref, ...(after ? [{ after }] : [{}])]),
        expanded: async (refs) => { await invoke('local-db:messages:view-intent', [sessionId, refs]); },
      });
    },
    dropNetwork() {
      // A second drop keeps the existing gate so earlier waiters are released together.
      if (!networkDown) {
        networkDown = true;
        networkUp = new Promise<void>((resolve) => { releaseNetwork = resolve; });
      }
      sockets.at(-1)?.terminate();
    },
    restoreNetwork() {
      networkDown = false;
      releaseNetwork();
      networkUp = Promise.resolve();
    },
    close() {
      releaseNetwork();
      client.stop();
      for (const ws of sockets) ws.terminate();
    },
  };
}
