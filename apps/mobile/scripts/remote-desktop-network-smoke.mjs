/** Local real-Chromium RTC smoke (no account, desktop capture, or public network).
 * node --import tsx apps/mobile/scripts/remote-desktop-network-smoke.mjs [chromium-executable]
 * Uses the installed Playwright browser; does not download one or alter app state.
 * This exercises the production WebView script, not WKWebView or cross-NAT/TURN.
 */
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { remoteDesktopViewerHtml } from "../src/remote-desktop/viewerHtml.ts";

const html = remoteDesktopViewerHtml("#222222", "#ffffff");
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    req.url === "/viewer"
      ? html
      : '<!doctype html><canvas width="640" height="360"></canvas>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.argv[2],
  });
  const context = await browser.newContext();
  const host = await context.newPage(),
    viewer = await context.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await host.goto(origin);
  let activeAttempt,
    dropped = false,
    streaming = 0,
    exchanges = 0;
  const errors = [];
  const send = (message) =>
    viewer.evaluate(
      (data) =>
        window.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(data) }),
        ),
      message,
    );
  const stripCandidates = (sdp) =>
    sdp
      .split("\r\n")
      .filter(
        (line) =>
          !line.startsWith("a=candidate:") && line !== "a=end-of-candidates",
      )
      .join("\r\n");
  await viewer.exposeFunction("signal", async (text) => {
    const message = JSON.parse(text);
    try {
      if (message.type === "ready") {
        await send({
          type: "init",
          epoch: "lease",
          width: 640,
          height: 360,
          trickleIce: true,
        });
        await send({ type: "control", enabled: true });
      } else if (message.type === "offer") {
        activeAttempt = message.attemptId;
        const answer = await host.evaluate(async (sdp) => {
          window.rtc?.close();
          clearInterval(window.paint);
          window.inputs = [];
          window.candidates = [];
          window.seen = new Set();
          const rtc = new RTCPeerConnection({ iceServers: [] });
          window.rtc = rtc;
          rtc.onicecandidate = ({ candidate }) => {
            if (candidate?.candidate)
              window.candidates.push(candidate.toJSON());
          };
          rtc.ondatachannel = ({ channel }) => {
            window.channel = channel;
            channel.onmessage = ({ data }) =>
              window.inputs.push(JSON.parse(data));
          };
          const canvas = document.querySelector("canvas"),
            ctx = canvas.getContext("2d");
          let frame = 0;
          window.paint = setInterval(() => {
            ctx.fillStyle = frame++ % 2 ? "#005599" : "#22aadd";
            ctx.fillRect(0, 0, 640, 360);
          }, 33);
          const stream = canvas.captureStream(30);
          stream.getTracks().forEach((track) => rtc.addTrack(track, stream));
          await rtc.setRemoteDescription({ type: "offer", sdp });
          await rtc.setLocalDescription(await rtc.createAnswer());
          return rtc.localDescription.sdp;
        }, stripCandidates(message.sdp));
        await send({
          type: "answer",
          epoch: "lease",
          attemptId: message.attemptId,
          sdp: stripCandidates(answer),
        });
      } else if (
        message.type === "ice" &&
        message.attemptId === activeAttempt
      ) {
        exchanges++;
        const reply = await host.evaluate(async ({ candidates, after }) => {
          for (const candidate of candidates) {
            const key = JSON.stringify(candidate);
            if (window.seen.has(key)) continue;
            await window.rtc.addIceCandidate(candidate);
            window.seen.add(key);
          }
          const batch = window.candidates.slice(after, after + 16);
          return {
            candidates: batch,
            next: after + batch.length,
            complete:
              window.rtc.iceGatheringState === "complete" &&
              after + batch.length === window.candidates.length,
          };
        }, message);
        // Force a lost signaling reply; replay must retain the same candidate cursor.
        if (!dropped) {
          dropped = true;
          return;
        }
        await send({
          type: "ice",
          epoch: "lease",
          attemptId: message.attemptId,
          exchangeId: message.exchangeId,
          ...reply,
        });
        await viewer.evaluate(() => {
          window.receivedIceReply = true;
        });
      } else if (message.type === "streaming") streaming++;
      else if (message.type === "input")
        await send({ type: "ack", epoch: "lease", sequence: message.sequence });
    } catch {
      errors.push(message.type);
    }
  });
  await viewer.addInitScript(() => {
    window.ReactNativeWebView = {
      postMessage: (data) => void window.signal(data),
    };
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(config) {
        super({ ...config, iceServers: [] });
        window.viewerPeer = this;
      }
    };
  });
  await viewer.goto(`${origin}/viewer`);
  await viewer.waitForFunction(
    () =>
      document.querySelector("video")?.videoWidth > 0 &&
      window.viewerPeer?.connectionState === "connected",
    null,
    { timeout: 25_000 },
  );
  // Peer-reflexive discovery can connect from just one side's candidates before
  // the lost reply is replayed. Independently require that signaling also heals.
  await viewer.waitForFunction(() => window.receivedIceReply, null, {
    timeout: 10_000,
  });
  assert.ok(exchanges >= 2, "dropped exchange was retried");
  await send({
    type: "events",
    events: [
      { kind: "key", code: "KeyA", down: true },
      { kind: "key", code: "KeyA", down: false },
    ],
  });
  await host.waitForFunction(
    () => window.inputs.some((m) => m.events?.some((e) => e.code === "KeyA")),
    null,
    { timeout: 5000 },
  );
  const oldAttempt = activeAttempt;
  await host.evaluate(() => window.rtc.close());
  await viewer.waitForFunction(
    () => window.viewerPeer?.connectionState !== "connected",
    null,
    { timeout: 15_000 },
  );
  await viewer.waitForFunction(
    () => window.viewerPeer?.connectionState === "connected",
    null,
    { timeout: 30_000 },
  );
  assert.notEqual(
    activeAttempt,
    oldAttempt,
    "media recovered with a new attempt",
  );
  await viewer.waitForFunction(
    () => document.querySelector("video")?.videoWidth > 0,
  );
  await send({ type: "stop" });
  assert.equal(
    await viewer.evaluate(() => window.viewerPeer.connectionState),
    "closed",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: "PASS",
      exchanges,
      streaming,
      delayedCandidates: true,
      lostReply: true,
      input: true,
      mediaRecovery: true,
    }),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
