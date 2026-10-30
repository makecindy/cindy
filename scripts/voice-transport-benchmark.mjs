#!/usr/bin/env node
// Direct-network, unauthenticated probe. No ASR allocation, audio, or app launch.
// Usage: node scripts/voice-transport-benchmark.mjs wss://voice.cindy.app/api/voice/asr
import https from "node:https";
import WebSocket from "ws";

const target = new URL(process.argv[2]);
if (
  target.protocol !== "wss:" ||
  target.username ||
  target.password ||
  target.search
) {
  throw new Error("Expected a wss URL without credentials or query parameters");
}
const warmupUrl = new URL("/", target);
warmupUrl.protocol = "https:";
const rows = [];
for (const mode of ["cold", "warm", "warm", "cold", "cold", "warm"]) {
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 2,
    maxFreeSockets: 1,
  });
  const row = { mode };
  try {
    if (mode === "warm") {
      const start = performance.now();
      await new Promise((resolve, reject) => {
        const request = https.request(
          warmupUrl,
          { method: "HEAD", agent },
          (response) => {
            response.resume();
            response.on("end", resolve);
            response.on("error", reject);
          },
        );
        const timer = setTimeout(
          () => request.destroy(new Error("Warmup timeout")),
          8_000,
        );
        request.on("close", () => clearTimeout(timer));
        request.on("error", reject);
        request.end();
      });
      row.warmupMs = Math.round(performance.now() - start);
    }
    const start = performance.now();
    await new Promise((resolve, reject) => {
      let handled = false;
      const socket = new WebSocket(target, { agent, handshakeTimeout: 8_000 });
      socket.on("unexpected-response", (request, response) => {
        handled = true;
        row.status = response.statusCode;
        row.reusedSocket = request.reusedSocket;
        row.upgradeResponseMs = Math.round(performance.now() - start);
        // We only need headers; do not retain a response body or wait for it.
        response.destroy();
        socket.terminate();
        resolve();
      });
      socket.on("open", () => {
        handled = true;
        row.status = 101;
        row.upgradeResponseMs = Math.round(performance.now() - start);
        socket.terminate();
        resolve();
      });
      socket.on("error", (error) => {
        if (!handled) reject(error);
      });
    });
    rows.push(row);
  } finally {
    agent.destroy();
  }
}
console.log(
  JSON.stringify({ kind: "UNAUTHENTICATED_UPGRADE_NOT_ASR", rows }, null, 2),
);
