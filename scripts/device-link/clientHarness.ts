import WebSocket from "ws";
import {
  DeviceLinkClient,
  DeviceLinkError,
  PROTOCOL_VERSION,
  type DeviceLinkTiming,
  type Envelope,
  type InvokePayload,
  type LinkOpenPayload,
} from "../../packages/device-link/src/index";
import { PeerRecoveryScheduler } from "../../apps/mobile/src/device-link/peerRecoveryScheduler";
import { rehydrateDeviceLinkPeer } from "../../apps/mobile/src/device-link/rehydrate";
import { DeviceLinkTopicRegistry } from "../../apps/mobile/src/device-link/topicRegistry";

export const SESSION_ID = "fixture-session";
export const TOPICS = [`session:${SESSION_ID}`, "sessions"] as const;

export function createClient(
  url: string,
  id: string,
  host = false,
  options: {
    token?: string;
    timing?: Partial<DeviceLinkTiming>;
    desktop?: boolean;
  } = {},
) {
  const sockets: WebSocket[] = [];
  const socketCreatedAt: number[] = [];
  const statuses: string[] = [];
  const client = new DeviceLinkClient({
    getWsUrl: () => url,
    getToken: async () => options.token ?? `fixture-${id}`,
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

export async function invoke(
  client: DeviceLinkClient,
  hostId: string,
  channel: string,
  args: unknown[] = [],
) {
  const reply = await client.invoke(hostId, { channel, args });
  if (!reply.ok)
    throw new DeviceLinkError("INTERNAL", "fixture invoke rejected");
  return reply.result;
}

/** Host data/IPC fixture. Transport, reliable ordering and request matching are production code. */
export function createHost(client: DeviceLinkClient) {
  const messages = [{ id: "m1", clientId: "m1", content: "initial" }];
  const subscriptions = new Map<string, string[]>();
  const executions = new Map<string, number>();
  const received: Envelope[] = [];
  let paused = false;
  let failNextSubscribe = false;
  let heldResult: (() => void) | undefined;
  const off = client.onFrame((env) => {
    received.push(env);
    if (!env.src || !env.id) return;
    if (env.kind === "link-open") {
      client.sendLinkAccept(env.src, env.id, {
        appVersion: "0.0.0-test",
        allowlistHash: "fixture",
      });
      return;
    }
    if (env.kind !== "invoke") return;
    const { channel, args } = env.payload as InvokePayload;
    executions.set(env.id, (executions.get(env.id) ?? 0) + 1);
    let result: unknown;
    switch (channel) {
      case "device-link:subscribe":
        if (failNextSubscribe) {
          failNextSubscribe = false;
          client.sendInvokeResult(env.src, env.id, {
            ok: false,
            error: {
              code: "INVOKE_TIMEOUT",
              message: "injected transient subscribe failure",
            },
          });
          return;
        }
        subscriptions.set(env.src, (args[0] as { topics: string[] }).topics);
        result = { ok: true };
        break;
      case "device-link:unsubscribe":
        subscriptions.delete(env.src);
        result = { ok: true };
        break;
      case "local-db:messages:list":
        result = [...messages];
        break;
      case "maker:input:get":
        result = { sessionId: SESSION_ID, queuePaused: paused };
        break;
      case "local-db:sessions:list":
        result = [{ id: SESSION_ID, title: "Fixture" }];
        break;
      case "fixture:held": {
        const { src, id } = env;
        heldResult = () =>
          client.sendInvokeResult(src!, id!, { ok: true, result: "released" });
        return;
      }
      default:
        client.sendInvokeResult(env.src, env.id, {
          ok: false,
          error: { code: "CHANNEL_NOT_ALLOWED", message: "fixture channel" },
        });
        return;
    }
    client.sendInvokeResult(env.src, env.id, { ok: true, result });
  });
  return {
    messages,
    subscriptions,
    executions,
    received,
    addMessage(id: string) {
      messages.push({ id, clientId: id, content: id });
    },
    setPaused(value: boolean) {
      paused = value;
    },
    failSubscriptionOnce() {
      failNextSubscribe = true;
    },
    get hasHeldResult() {
      return Boolean(heldResult);
    },
    releaseResult() {
      heldResult?.();
      heldResult = undefined;
    },
    close: off,
  };
}

/** Same production recovery core as Mobile; no React/native lifecycle is simulated here. */
export function createMobileRecovery(client: DeviceLinkClient, hostId: string) {
  const registry = new DeviceLinkTopicRegistry();
  registry.trackOpenLink(hostId);
  registry.trackSubscribe("fixture-screen", hostId, TOPICS);
  const state = {
    messages: [] as { id: string }[],
    queuePaused: false,
    completed: 0,
    reseeds: 0,
  };
  let epoch = 0;
  let active = true;
  const scheduler = new PeerRecoveryScheduler(
    async (id) => {
      const generation = epoch;
      const result = await rehydrateDeviceLinkPeer(
        registry.snapshotDevice(id)!,
        {
          isCancelled: () =>
            !active || generation !== epoch || client.getStatus() !== "online",
          capturePresenceEpoch: () => generation,
          captureResponseEvidenceEpoch: () => generation,
          isPresenceEpochCurrent: (_id, value) => active && value === epoch,
          isResponseEvidenceEpochCurrent: (_id, value) =>
            active && value === epoch,
          createDeviceSendCohort: () => generation,
          openLink: (deviceId) => ({
            capturedPresenceEpoch: generation,
            capturedResponseEvidenceEpoch: generation,
            request: client.openLink(deviceId, {
              controllerName: "Integration controller",
              protocolVersion: PROTOCOL_VERSION,
              appVersion: "0.0.0-test",
            } satisfies LinkOpenPayload),
          }),
          subscribe: async (deviceId, topics) => {
            const reply = await client.invoke(deviceId, {
              channel: "device-link:subscribe",
              args: [{ topics }],
            });
            if (!reply.ok)
              throw new DeviceLinkError(
                "INVOKE_TIMEOUT",
                "fixture subscribe failed",
              );
          },
          requestSessionsReseed: () => {
            state.reseeds++;
          },
          rebuildSessionSnapshot: async (deviceId) => {
            const [messages, projection] = await Promise.all([
              invoke(client, deviceId, "local-db:messages:list", [SESSION_ID]),
              invoke(client, deviceId, "maker:input:get", [SESSION_ID]),
            ]);
            if (!active || generation !== epoch) return;
            state.messages = messages as { id: string }[];
            state.queuePaused = (
              projection as { queuePaused: boolean }
            ).queuePaused;
          },
        },
      );
      if (active && generation === epoch && result.transientFailures === 0)
        state.completed++;
      return { retry: result.transientFailures > 0 };
    },
    { retryBaseMs: 50, retryMaxMs: 200 },
  );
  const off = client.onStatusChange((status) => {
    epoch++;
    if (status === "online") {
      scheduler.resume();
      scheduler.request(hostId);
    } else scheduler.pause();
  });
  const offPresence = client.onPresenceChanged((presence) => {
    if (presence.deviceId !== hostId) return;
    if (presence.online && presence.remoteControlEnabled)
      scheduler.request(hostId);
    else {
      epoch++;
      scheduler.cancel(hostId);
    }
  });
  return {
    state,
    background() {
      epoch++;
      scheduler.pause();
    },
    foreground() {
      scheduler.resume();
      scheduler.request(hostId);
    },
    close() {
      active = false;
      epoch++;
      off();
      offPresence();
      scheduler.pause();
    },
  };
}
