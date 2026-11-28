import { once } from "node:events";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  CONTROL_KINDS,
  PROVIDER_SHARE_RELAY_CAPABILITY,
  ROUTED_KINDS,
  PROTOCOL_VERSION,
  WS_MAX_PAYLOAD_BYTES,
  type Envelope,
  type HelloPayload,
  type PresenceSnapshot,
} from "../../packages/device-link-protocol/src/index";

/** Test-only wire-contract fixture, NOT the independent production relay implementation. */
export async function createRelayFixture(share?: { id: string; host: string; guest: string; member: string }) {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: WS_MAX_PAYLOAD_BYTES,
  });
  const peers = new Map<
    string,
    { ws: WebSocket; presence: PresenceSnapshot }
  >();
  const frames: Envelope[] = [];
  const connections = new Map<string, number>();
  // Opt-in serial ingress fixture for the official relay's documented bounds.
  // pause() cannot stop messages already parsed from one TCP data event.
  const inboundBounds = new Map<string, { queued: number; peak: number; rejected: number }>();
  let drop: (frame: Envelope) => boolean = () => false;
  const send = (ws: WebSocket, frame: Envelope) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const broadcast = (presence: PresenceSnapshot) => {
    for (const peer of peers.values()) {
      send(peer.ws, {
        v: PROTOCOL_VERSION,
        kind: "presence-changed",
        payload: presence,
      });
    }
  };
  server.on("connection", (ws, request) => {
    // Explicitly fake fixture identities; never a JWT or developer credential.
    const id = request.headers.authorization?.replace(/^Bearer fixture-/, "");
    if (!id || request.headers.authorization !== `Bearer fixture-${id}`) {
      ws.close(4401, "fixture identity required");
      return;
    }
    connections.set(id, (connections.get(id) ?? 0) + 1);
    ws.on("error", () => {}); // Socket failures are deliberately injected by tests.
    const receive = (bytes: RawData) => {
      const frame = { ...JSON.parse(bytes.toString()), src: id } as Envelope;
      frames.push(frame);
      if (drop(frame)) return;
      if (frame.v !== PROTOCOL_VERSION) {
        ws.close(4400, "protocol mismatch");
        return;
      }
      if (frame.kind === "hello") {
        const hello = frame.payload as HelloPayload;
        const presence: PresenceSnapshot = {
          ...hello,
          deviceId: id,
          online: true,
          lastSeenAt: Date.now(),
        };
        peers.get(id)?.ws.close(4409, "replaced");
        peers.set(id, { ws, presence });
        send(ws, {
          v: PROTOCOL_VERSION,
          kind: "hello-ack",
          payload: {
            serverProtocolVersion: PROTOCOL_VERSION,
            deviceId: id,
            userId: "fixture-account",
            ...(share ? { capabilities: [PROVIDER_SHARE_RELAY_CAPABILITY] } : {}),
          },
        });
        for (const peer of peers.values()) {
          send(ws, {
            v: PROTOCOL_VERSION,
            kind: "presence-changed",
            payload: peer.presence,
          });
        }
        broadcast(presence);
      } else if (peers.get(id)?.ws !== ws) {
        ws.close(4401, "hello required");
      } else if (frame.kind === "ping") {
        send(ws, { v: PROTOCOL_VERSION, kind: "pong" });
      } else if (frame.kind === "presence-set") {
        const peer = peers.get(id)!;
        peer.presence = { ...peer.presence, ...(frame.payload as object) };
        broadcast(peer.presence);
      } else if (ROUTED_KINDS.has(frame.kind)) {
        const target = peers.get(frame.dst ?? "");
        if (frame.providerShare) {
          const scope = frame.providerShare;
          if (!share || scope.shareId !== share.id || !target) return;
          const guest = { role: "guest", memberId: share.member } as const;
          const host = { role: "host" } as const;
          if (id === share.guest && frame.dst === share.host && scope.target.role === "host")
            send(target.ws, { ...frame, providerShare: { ...scope, source: guest } });
          else if (id === share.host && frame.dst === share.guest
            && scope.target.role === "guest" && scope.target.memberId === share.member)
            send(target.ws, { ...frame, providerShare: { ...scope, source: host } });
          return;
        }
        const code = !target
          ? "DEVICE_OFFLINE"
          : CONTROL_KINDS.has(frame.kind) &&
              !target.presence.remoteControlEnabled
            ? "REMOTE_DISABLED"
            : null;
        if (code) {
          send(ws, {
            v: PROTOCOL_VERSION,
            kind: "relay-error",
            id: frame.id,
            payload: { code, message: code, dst: frame.dst },
          });
        } else {
          send(target!.ws, frame);
        }
      }
    };
    let tail = Promise.resolve();
    ws.on("message", bytes => {
      const bound = inboundBounds.get(id);
      if (!bound) { receive(bytes); return; }
      if (bound.queued >= 128) { bound.rejected++; ws.close(1013, 'inbound backpressure'); return; }
      bound.queued++;
      bound.peak = Math.max(bound.peak, bound.queued);
      if (bound.queued >= 64) ws.pause();
      tail = tail.then(() => {
        receive(bytes);
        bound.queued--;
        if (bound.queued < 32) ws.resume();
      });
    });
    ws.on("close", () => {
      const peer = peers.get(id);
      if (peer?.ws !== ws) return;
      peers.delete(id);
      broadcast({ ...peer.presence, online: false });
    });
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture did not bind TCP");
  return {
    url: `ws://127.0.0.1:${address.port}/api/device-link/ws`,
    frames,
    connections,
    boundInbound(id: string) {
      const bound = { queued: 0, peak: 0, rejected: 0 };
      inboundBounds.set(id, bound);
      return bound;
    },
    dropFrames(predicate: (frame: Envelope) => boolean) {
      drop = predicate;
    },
    disconnect(id: string, code?: number) {
      const peer = peers.get(id);
      if (!peer) throw new Error(`fixture peer not connected: ${id}`);
      if (code) peer.ws.close(code, "injected backpressure");
      else peer.ws.terminate();
    },
    async close() {
      for (const ws of server.clients) ws.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
