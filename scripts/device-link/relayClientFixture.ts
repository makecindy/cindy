import WebSocket from "ws";
import {
  DeviceLinkClient,
  type DeviceLinkFrameAuth,
  type DeviceLinkTiming,
  type DeviceLinkTransferCodec,
} from "../../packages/device-link/src/index";

export function createClient(
  url: string,
  id: string,
  host = false,
  options: {
    token?: string;
    authorizationScheme?: "Bearer" | "CindyRelay";
    timing?: Partial<DeviceLinkTiming>;
    desktop?: boolean;
    /** 自建中转的设备签名钩子(与 Desktop / Mobile 传给 DeviceLinkClient 的同一选项)。 */
    frameAuth?: () => DeviceLinkFrameAuth | null;
    /** 与 Desktop / Mobile 注入的编解码同一选项；缺省时走未声明压缩能力的旧路径。 */
    transferCodec?: DeviceLinkTransferCodec;
  } = {},
) {
  const sockets: WebSocket[] = [];
  const socketCreatedAt: number[] = [];
  const statuses: string[] = [];
  const client = new DeviceLinkClient({
    getWsUrl: () => url,
    getToken: async () => options.token ?? `fixture-${id}`,
    authorizationScheme: options.authorizationScheme,
    frameAuth: options.frameAuth,
    transferCodec: options.transferCodec,
    getHello: () => ({
      deviceName: `Integration ${id}`,
      platform: host || options.desktop ? "darwin" : "ios",
      appVersion: "0.0.0-test",
      remoteControlEnabled: host,
      busy: false,
    }),
    createWebSocket: (address, headers) => {
      const ws = new WebSocket(address, { headers });
      sockets.push(ws);
      socketCreatedAt.push(performance.now());
      return ws;
    },
    peerFailurePolicy: host || options.desktop ? "legacy" : "isolate-peer",
    // Bounded real-time waits, never fake socket/timer events. Interop overrides these.
    timing: {
      reconnectBaseMs: 30,
      reconnectMaxMs: 100,
      requestTimeoutMs: 2_000,
      pingIntervalMs: 1_000,
      pongMissLimit: 3,
      transportRetryIntervalMs: 100,
      transportMaxRetryAttempts: 5,
      congestionBackoffBaseMs: 300,
      congestionBackoffMaxMs: 600,
      ...options.timing,
    },
    // No raw relay errors or tokens in test output; assertions report stages instead.
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  client.onStatusChange((status) => statuses.push(status));
  return {
    client,
    sockets,
    socketCreatedAt,
    statuses,
    close() {
      client.stop();
      for (const ws of sockets) ws.terminate();
    },
  };
}
