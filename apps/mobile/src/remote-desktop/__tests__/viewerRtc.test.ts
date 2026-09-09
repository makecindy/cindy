import vm from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { REMOTE_DESKTOP_NETWORK as net } from "@cindy/device-link";
import { DESKTOP_RTC_SCRIPT } from "../viewerRtc";

// Executes the exact static script embedded in WKWebView, with only RTC/DOM replaced.
function viewer(trickle = true) {
  const messages: any[] = [];
  const peers: any[] = [];
  class Peer {
    connectionState = "new";
    iceGatheringState = "gathering";
    remoteDescription: any = null;
    localDescription = { sdp: "offer" };
    onconnectionstatechange = () => {};
    onicecandidate = (_event: any) => {};
    onicegatheringstatechange = () => {};
    channel = { readyState: "open", close: vi.fn(), send: vi.fn() };
    close = vi.fn(() => {
      this.connectionState = "closed";
      this.onconnectionstatechange();
    });
    addIceCandidate = vi.fn(async (_candidate: any) => {});
    setRemoteDescription = vi.fn(async (value: any) => {
      this.remoteDescription = value;
    });
    constructor() {
      peers.push(this);
    }
    createDataChannel() {
      return this.channel;
    }
    addTransceiver() {}
    async createOffer() {
      return this.localDescription;
    }
    async setLocalDescription() {}
    async getStats() {
      return new Map();
    }
  }
  const video = {
    style: { display: "none" },
    srcObject: null,
    onplaying: null,
    play: async () => {},
  };
  const image = { style: { display: "block" }, removeAttribute() {} };
  const retained = vi.fn();
  const release = vi.fn();
  const context = vm.createContext({
    net,
    iceServers: [],
    window: { RTCPeerConnection: Peer },
    RTCPeerConnection: Peer,
    video,
    image,
    document: {},
    Date,
    Map,
    Set,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    retainFrame: retained,
    release,
    render() {},
    receiveCursor() {},
    networkStats: () => ({ sample: null }),
    post: (message: any) => messages.push(message),
  });
  const api = vm.runInContext(
    `
    let pc=null,dc=null,generation=0,epoch='lease',statsTimer=null,statsSample=null;
    ${DESKTOP_RTC_SCRIPT}
    trickleIce=${trickle};
    ({start:connect,answer:receiveAnswer,ice:receiveIce,fail:failRtc,
      stop:()=>{epoch=null;closeRtc();}})
  `,
    context,
  );
  const latest = (type: string) =>
    messages.filter((m) => m.type === type).at(-1);
  return {
    api,
    peers,
    messages,
    latest,
    video,
    retained,
    release,
    answer: async () => api.answer({ ...latest("offer"), sdp: "answer" }),
    change: (state: string, peer = peers.at(-1)) => {
      peer.connectionState = state;
      peer.onconnectionstatechange();
    },
    reply: async (extra: any = {}) =>
      api.ice({
        ...latest("ice"),
        candidates: [],
        next: latest("ice").after,
        complete: false,
        ...extra,
      }),
  };
}
const candidate = {
  candidate: "candidate:1 1 UDP 100 192.0.2.1 5000 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("sends an early offer, then flushes candidates gathered after the answer", async () => {
  const h = viewer();
  await h.api.start();
  expect(h.latest("offer")).toMatchObject({ attemptId: "1", sdp: "offer" });
  await h.answer();
  await h.reply();
  h.peers[0].onicecandidate({ candidate });
  await vi.advanceTimersByTimeAsync(net.pollMs);
  expect(h.latest("ice").candidates).toEqual([candidate]);
  await h.reply({ candidates: [candidate], next: 1 });
  expect(h.peers[0].addIceCandidate).toHaveBeenCalledWith(candidate);
  h.api.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("retains video on transient disconnection and cancels the grace timeout after recovery", async () => {
  const h = viewer();
  await h.api.start();
  await h.answer();
  h.video.style.display = "block";
  h.change("connected");
  h.change("disconnected");
  expect(h.latest("reconnecting")).toBeDefined();
  await vi.advanceTimersByTimeAsync(net.disconnectedMs - 1);
  expect(h.peers[0].close).not.toHaveBeenCalled();
  expect(h.video.style.display).toBe("block");
  h.change("connected");
  await vi.advanceTimersByTimeAsync(2);
  expect(h.latest("streaming")).toBeDefined();
  expect(h.peers).toHaveLength(1);
  h.api.stop();
});

it("retries only three times, keeps a frame, and cancels every timer on exit", async () => {
  const h = viewer();
  await h.api.start();
  for (const delay of net.retryMs) {
    h.change("failed");
    await vi.advanceTimersByTimeAsync(delay);
  }
  h.change("failed");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.peers).toHaveLength(4);
  expect(h.retained).toHaveBeenCalled();
  h.api.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not replenish retry budget from a brief connection", async () => {
  const h = viewer();
  await h.api.start();
  for (const delay of net.retryMs) {
    h.change("connected");
    await vi.advanceTimersByTimeAsync(1000);
    h.change("failed");
    await vi.advanceTimersByTimeAsync(delay);
  }
  h.change("failed");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.peers).toHaveLength(4);
  h.api.stop();
});

it("accepts a cold-host answer after readiness, Windows probe, sources and offer", async () => {
  const h = viewer();
  await h.api.start();
  await vi.advanceTimersByTimeAsync(10_000 + 21_000 + 5_000 + 18_000);
  expect(h.peers[0].close).not.toHaveBeenCalled();
  await h.answer();
  expect(h.peers[0].setRemoteDescription).toHaveBeenCalled();
  expect(h.peers).toHaveLength(1);
  h.api.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("separates answer wait from connection checks and drops the previous attempt answer", async () => {
  const h = viewer();
  await h.api.start();
  const old = h.latest("offer");
  await vi.advanceTimersByTimeAsync(net.answerMs - 1);
  expect(h.peers[0].close).not.toHaveBeenCalled();
  await h.answer();
  await vi.advanceTimersByTimeAsync(net.connectMs - 1);
  expect(h.peers[0].close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1 + net.retryMs[0]);
  await h.api.answer({ ...old, sdp: "stale" });
  expect(h.peers[1].setRemoteDescription).not.toHaveBeenCalled();
  h.api.stop();
});

it("does not acknowledge unsent candidates when an earlier exchange reply arrives late", async () => {
  const h = viewer();
  await h.api.start();
  await h.answer();
  const old = h.latest("ice");
  h.peers[0].onicecandidate({ candidate });
  await vi.advanceTimersByTimeAsync(4500);
  const next = h.latest("ice");
  expect(next.exchangeId).not.toBe(old.exchangeId);
  await h.api.ice({ ...old, candidates: [], next: 0, complete: true });
  await h.reply({ error: true });
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.latest("ice").candidates).toEqual([candidate]);
  await h.reply();
  await vi.advanceTimersByTimeAsync(net.pollMs);
  expect(h.latest("ice").candidates).toEqual([]);
  h.api.stop();
});

it("preserves the legacy full-SDP path when capability is absent", async () => {
  const h = viewer(false);
  const starting = h.api.start();
  await vi.advanceTimersByTimeAsync(net.legacyGatherMs - 1);
  expect(h.latest("offer")).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await starting;
  await h.answer();
  expect(h.latest("ice")).toBeUndefined();
  h.api.stop();
});

it("cannot let a stopped viewer or stale candidate change a different viewer", async () => {
  const a = viewer(),
    b = viewer();
  await a.api.start();
  await b.api.start();
  await a.answer();
  const old = a.latest("ice");
  a.api.stop();
  await a.api.ice({ ...old, candidates: [candidate], next: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(a.peers[0].addIceCandidate).not.toHaveBeenCalled();
  expect(b.peers[0].close).not.toHaveBeenCalled();
  b.api.stop();
});

it("does not retry an unavailable platform or a permanent host error", async () => {
  const h = viewer();
  await h.api.start();
  h.api.fail("host", false);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.peers).toHaveLength(1);
  h.api.stop();
});
