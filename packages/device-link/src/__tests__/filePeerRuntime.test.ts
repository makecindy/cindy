import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFilePeerRuntime } from "../filePeerRuntime.js";

/** Just enough of RTCPeerConnection for `offer()` to open the RPC channel. */
interface FakeChannel {
  label: string;
  readyState: string;
  closed: boolean;
  onmessage?: (event: { data: unknown }) => void;
  send(data: unknown): void;
  close(): void;
}
const channels: FakeChannel[] = [];
class FakePeerConnection {
  async getStats(): Promise<Map<string, Record<string, unknown>>> { return new Map(); }
  localDescription = { sdp: "v=0" };
  iceGatheringState = "complete";
  signalingState = "stable";
  createDataChannel(label: string) {
    const channel: FakeChannel = {
      label,
      readyState: "open",
      closed: false,
      send() {},
      close() {
        this.closed = true;
      },
    };
    channels.push(channel);
    return channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async setLocalDescription() {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

beforeEach(() => {
  channels.length = 0;
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function rpcChannel(invoke: (id: string, payload: string, body?: Uint8Array) => Promise<string>) {
  const runtime = createFilePeerRuntime({ read: async () => "", write: async () => {}, invoke });
  await runtime.offer("peer", [], true);
  return channels.find((channel) => channel.label === "reads-v1")!;
}
const header = (body: number) =>
  JSON.stringify({ key: "1", response: false, data: "{}", last: true, body });

// Unit: the old selected-pair-only diagnostics could not distinguish failed
// direct checks from missing candidates. Exercise the privacy boundary with raw stats.
it("reports bounded candidate check outcomes without leaking network identities", async () => {
  const entries: Record<string, unknown>[] = [
    { id: "private-local", type: "local-candidate", candidateType: "host", protocol: "udp", address: "private-address", port: 12345, url: "private-url" },
    { id: "private-remote", type: "remote-candidate", candidateType: "relay", protocol: "udp", address: "private-address" },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `private-pair-${i}`, type: "candidate-pair", state: i ? "failed" : "succeeded", localCandidateId: "private-local", remoteCandidateId: "private-remote", requestsSent: 3, responsesReceived: i ? 0 : 3 })),
    { id: "private-transport", type: "transport", selectedCandidatePairId: "private-pair-0" },
  ];
  vi.spyOn(FakePeerConnection.prototype, "getStats").mockResolvedValue(new Map(entries.map(e => [e.id as string, e])));
  const runtime = createFilePeerRuntime({ read: async () => "", write: async () => {} });
  try {
    await runtime.offer("peer", []);
    const raw = await runtime.stats("peer");
    const stats = JSON.parse(raw);
    expect(stats.path).toBe("relay");
    expect(stats.checks).toHaveLength(8);
    expect(stats.checks[0]).toMatchObject({ selected: true, responsesReceived: 3 });
    expect(stats.checks[1]).toMatchObject({ state: "failed", responsesReceived: 0, local: { candidateType: "host" } });
    expect(raw).not.toContain("private-");
    expect(raw).not.toContain("12345");
  } finally { runtime.dispose(); }
});

it("accepts a body in the sender's framing: full 16 KiB frames, shorter only at the end", async () => {
  const invoke = vi.fn(async () => "ok");
  const rpc = await rpcChannel(invoke);
  rpc.onmessage!({ data: header(16384 + 3) });
  rpc.onmessage!({ data: new Uint8Array(16384).buffer });
  rpc.onmessage!({ data: new Uint8Array([1, 2, 3]).buffer });
  expect(rpc.closed).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect((invoke.mock.calls[0] as unknown[])[2]).toHaveLength(16384 + 3);
});

it("closes the channel when a peer splits a body into smaller frames", async () => {
  const invoke = vi.fn(async () => "ok");
  const rpc = await rpcChannel(invoke);
  rpc.onmessage!({ data: header(1024 * 1024) });
  // A tiny frame where a full 16 KiB one belongs would let a peer pile up a million parts.
  rpc.onmessage!({ data: new Uint8Array(1).buffer });
  expect(rpc.closed).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
});
