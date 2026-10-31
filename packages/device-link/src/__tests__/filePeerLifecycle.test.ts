import { afterEach, expect, it, vi } from "vitest";
import { createFilePeerRuntime } from "../filePeerRuntime";

class Peer extends EventTarget {
  static instances: Peer[] = [];
  constructor() {
    super();
    Peer.instances.push(this);
  }
  localDescription = { sdp: "v=0" };
  iceGatheringState = "complete";
  connectionState = "connected";
  onconnectionstatechange = () => {};
  createDataChannel() {
    return Object.assign(new EventTarget(), { close() {}, readyState: "open" });
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async setLocalDescription() {}
  close() {
    this.connectionState = "closed";
    this.onconnectionstatechange();
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Peer.instances = [];
});
it("reports transport closure once, leaves other peers alive and ignores stale events after replacement", async () => {
  vi.stubGlobal("RTCPeerConnection", Peer);
  const closed = vi.fn();
  const runtime = createFilePeerRuntime({
    read: async () => "",
    write: async () => {},
    closed,
  });
  await runtime.offer("a", []);
  await runtime.offer("b", []);
  const [a, b] = Peer.instances;
  a.connectionState = "failed";
  a.onconnectionstatechange();
  expect(closed.mock.calls).toEqual([["a", "failed"]]);
  expect(b.connectionState).toBe("connected");
  runtime.close("a");
  expect(closed).toHaveBeenCalledOnce();
  await runtime.offer("a", []);
  a.onconnectionstatechange();
  expect(Peer.instances[2].connectionState).toBe("connected");
  runtime.dispose();
  expect(closed.mock.calls).toEqual([["a", "failed"], ["b"], ["a"]]);
});

// Oct 30: a brief ICE interruption destroyed a working direct file connection.
// Unit: exercise the runtime lifecycle with a second peer and a stale timer;
// existing closure coverage only tested terminal failure, not recovery.
it("retains a briefly disconnected peer, but bounds an unrecovered interruption", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("RTCPeerConnection", Peer);
  const closed = vi.fn();
  const runtime = createFilePeerRuntime({ read: async () => "", write: async () => {}, closed });
  await runtime.offer("a", []);
  await runtime.offer("b", []);
  const [a, b] = Peer.instances;
  a.connectionState = "disconnected";
  a.onconnectionstatechange();
  await vi.advanceTimersByTimeAsync(2000);
  expect(closed).not.toHaveBeenCalled();
  a.connectionState = "connected";
  a.onconnectionstatechange();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(closed).not.toHaveBeenCalled();
  a.connectionState = "disconnected";
  a.onconnectionstatechange();
  await vi.advanceTimersByTimeAsync(10_000);
  a.onconnectionstatechange(); // Duplicate events cannot extend recovery indefinitely.
  a.connectionState = "connecting"; // Restarting checks is not a recovered path yet.
  a.onconnectionstatechange();
  await vi.advanceTimersByTimeAsync(5000);
  expect(closed.mock.calls).toEqual([["a", "disconnect-timeout"]]);
  expect(b.connectionState).toBe("connected");
  b.connectionState = "disconnected";
  b.onconnectionstatechange();
  runtime.dispose();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(closed.mock.calls).toEqual([["a", "disconnect-timeout"], ["b"]]);
});
