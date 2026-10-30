import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import {
  CONTROL_KINDS,
  ROUTED_KINDS,
  PROTOCOL_VERSION,
  WS_MAX_PAYLOAD_BYTES,
  type Envelope,
  type HelloPayload,
  type PresenceSnapshot,
} from "../../packages/device-link-protocol/src/index";

/** Test-only wire-contract fixture, NOT the independent production relay implementation. */
export async function createRelayFixture() {
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
    ws.on("message", (bytes) => {
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
