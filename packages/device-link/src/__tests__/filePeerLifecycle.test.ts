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
  a.connectionState = "disconnected";
  a.onconnectionstatechange();
  expect(closed.mock.calls).toEqual([["a"]]);
  expect(b.connectionState).toBe("connected");
  runtime.close("a");
  expect(closed).toHaveBeenCalledOnce();
  await runtime.offer("a", []);
  a.onconnectionstatechange();
  expect(Peer.instances[2].connectionState).toBe("connected");
  runtime.dispose();
  expect(closed.mock.calls).toEqual([["a"], ["b"], ["a"]]);
});
