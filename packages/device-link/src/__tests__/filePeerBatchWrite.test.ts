import { afterEach, expect, it, vi } from "vitest";
import { createFilePeerRuntime } from "../filePeerRuntime";

class Channel extends EventTarget {
  readyState = "open";
  sent: string[] = [];
  constructor(public label: string) {
    super();
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
  frame(value: Uint8Array) {
    this.dispatchEvent(new MessageEvent("message", { data: value.buffer }));
  }
}
let channel: Channel;
class Peer extends EventTarget {
  localDescription = { sdp: "v=0" };
  iceGatheringState = "complete";
  signalingState = "stable";
  createDataChannel(label: string) {
    const result = new Channel(label);
    if (label === "files-v2") channel = result;
    return result;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async setLocalDescription() {}
  close() {
    channel?.close();
  }
}
afterEach(() => vi.unstubAllGlobals());
it.each([false, true])(
  "preserves bytes, offsets, credit and EOF with batching=%s",
  async (batching) => {
    vi.stubGlobal("RTCPeerConnection", Peer);
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const output: Buffer[] = [];
    let written = 0;
    const write = vi.fn(
      async (_sink: string, offset: number, base64: string) => {
        if (!output.length) await blocked;
        expect(offset).toBe(written);
        const data = Buffer.from(base64, "base64");
        expect(data.length).toBeLessThanOrEqual(batching ? 256 * 1024 : 16384);
        output.push(data);
        written += data.length;
      },
    );
    const runtime = createFilePeerRuntime({
      read: async () => "",
      write,
      ...(batching ? { writeBatch: write } : {}),
    });
    await runtime.offer("a", [], true);
    const receive = runtime.receive("a", "ticket", 64 * 16384, "sink");
    for (let n = 0; n < 64; n++) channel.frame(new Uint8Array(16384).fill(n));
    expect(write).toHaveBeenCalledOnce();
    expect(channel.sent.map((v) => JSON.parse(v))).toEqual([
      { ticket: "ticket", offset: 0, credit: 64 },
    ]);
    unblock();
    await vi.waitFor(() => expect(written).toBe(64 * 16384));
    expect(channel.sent.map((v) => JSON.parse(v))).toContainEqual({
      credit: 1,
    });
    channel.frame(new Uint8Array());
    await receive;
    // Compare every byte natively; generic deep equality enumerates a million
    // Buffer indices and can consume the whole test timeout on Windows runners.
    const expected = Buffer.concat(
      Array.from({ length: 64 }, (_, n) => Buffer.alloc(16384, n)),
    );
    expect(Buffer.concat(output).equals(expected)).toBe(true);
    expect(write.mock.calls.length).toBe(batching ? 5 : 64);
    runtime.dispose();
  },
);
it("rejects a closed receive without writing queued data after an outstanding bridge write", async () => {
  vi.stubGlobal("RTCPeerConnection", Peer);
  let unblock!: () => void;
  const write = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        unblock = resolve;
      }),
  );
  const runtime = createFilePeerRuntime({
    read: async () => "",
    write,
    writeBatch: write,
  });
  await runtime.offer("a", [], true);
  const receive = runtime.receive("a", "ticket", 32768, "sink");
  const rejected = expect(receive).rejects.toThrow("FILE_PEER_CLOSED");
  channel.frame(new Uint8Array(16384));
  channel.frame(new Uint8Array(16384));
  runtime.close("a");
  unblock();
  await rejected;
  expect(write).toHaveBeenCalledOnce();
});

// Unit: high-bitrate playback must not pay one IPC round trip per 16 KiB frame.
// Batch only the trusted local read; an old receiver still gets identical credit-bound frames.
it('batches source reads while retaining wire framing, credit and EOF', async () => {
  let pc: any;
  class SourcePeer extends Peer {
    ondatachannel?: (event: unknown) => void;
    constructor() { super(); pc = this; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0' }; }
    async setRemoteDescription() {}
  }
  vi.stubGlobal('RTCPeerConnection', SourcePeer);
  const bytes = Buffer.alloc(33 * 16384 + 7, 42);
  const frames: ArrayBuffer[] = [];
  const dc = { label: 'files-v2', readyState: 'open', binaryType: '', onmessage: undefined as any,
    send: (data: ArrayBuffer) => frames.push(data), close() { this.readyState = 'closed'; } };
  const readBatch = vi.fn(async (_id, _ticket, offset, maxBytes) => bytes.subarray(offset, offset + maxBytes).toString('base64'));
  const runtime = createFilePeerRuntime({ read: vi.fn(), readBatch, write: async () => {} });
  try {
    await runtime.accept('a', [], 'v=0'); pc.ondatachannel({ channel: dc });
    dc.onmessage({ data: JSON.stringify({ ticket: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', offset: 0, credit: 16 }) });
    await vi.waitFor(() => expect(frames).toHaveLength(16));
    expect(readBatch).toHaveBeenCalledOnce();
    dc.onmessage({ data: JSON.stringify({ credit: 32 }) });
    await vi.waitFor(() => expect(frames.at(-1)?.byteLength).toBe(0));
    expect(frames.every(frame => frame.byteLength <= 16384)).toBe(true);
    expect(Buffer.concat(frames.map(frame => Buffer.from(frame))).equals(bytes)).toBe(true);
    expect(readBatch).toHaveBeenCalledTimes(4);
  } finally { runtime.dispose(); }
});
