// Explicit operator probe, not a unit test. Credentials must live outside the checkout.
// node scripts/remote-desktop-turn-smoke.mjs <ice-config.json> <Chrome executable>
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [configPath, executablePath] = process.argv.slice(2);
if (!configPath || !executablePath)
  throw new Error(
    "Usage: node scripts/remote-desktop-turn-smoke.mjs <external-ice-config.json> <Chrome executable>",
  );
const input = await realpath(configPath);
if (input === root || input.startsWith(root + path.sep))
  throw new Error("Keep credential files outside the checkout");
let iceServers;
try {
  ({ iceServers } = JSON.parse(await readFile(input, "utf8")));
} catch {
  // JSON SyntaxError can echo input, including credentials.
  throw new Error("INVALID_ICE_CONFIG");
}
if (!Array.isArray(iceServers) || !iceServers.length)
  throw new Error("No ICE servers");
const require = createRequire(
  new URL("../packages/browser-control-runtime/package.json", import.meta.url),
);
const { chromium } = require("playwright-core");
const browser = await chromium.launch({
  executablePath,
  headless: true,
  chromiumSandbox: true,
});
try {
  const page = await browser.newPage();
  const cases = iceServers.flatMap((server, node) =>
    (Array.isArray(server.urls) ? server.urls : [server.urls])
      .filter((url) => /^turns?:/.test(url))
      .map((url, transport) => ({
        name: `node-${node + 1}-transport-${transport + 1}`,
        servers: [{ ...server, urls: [url] }],
      })),
  );
  cases.push({
    name: "unreachable-primary-with-backup",
    servers: [
      {
        urls: ["turn:192.0.2.1:9?transport=udp"],
        username: "test-only",
        credential: "test-only",
      },
      ...iceServers,
    ],
  });
  for (const test of cases) {
    const result = await page
      .evaluate(async (servers) => {
        const a = new RTCPeerConnection({
          iceServers: servers,
          iceTransportPolicy: "relay",
        });
        const b = new RTCPeerConnection({
          iceServers: servers,
          iceTransportPolicy: "relay",
        });
        const queues = new Map([
          [a, []],
          [b, []],
        ]);
        let timer;
        try {
          const outcome = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("RELAY_TIMEOUT")), 20000);
            const data = new Uint8Array(16384);
            for (let i = 0; i < data.length; i++) data[i] = i % 251;
            b.ondatachannel = ({ channel }) => {
              channel.binaryType = "arraybuffer";
              channel.onmessage = ({ data }) => channel.send(data);
            };
            const channel = a.createDataChannel("probe");
            channel.binaryType = "arraybuffer";
            channel.onopen = () => channel.send(data);
            channel.onmessage = async ({ data: echoed }) => {
              try {
                const received = new Uint8Array(echoed);
                if (
                  received.length !== data.length ||
                  received.some((v, i) => v !== data[i])
                )
                  throw new Error("DATA_MISMATCH");
                const stats = await a.getStats();
                const rows = [...stats.values()];
                const transport = rows.find(
                  (s) => s.type === "transport" && s.selectedCandidatePairId,
                );
                const pair =
                  transport && stats.get(transport.selectedCandidatePairId);
                const local = pair && stats.get(pair.localCandidateId),
                  remote = pair && stats.get(pair.remoteCandidateId);
                if (
                  local?.candidateType !== "relay" ||
                  remote?.candidateType !== "relay"
                )
                  throw new Error("NOT_RELAY");
                resolve({
                  bytesRoundTrip: received.length,
                  local: local.candidateType,
                  remote: remote.candidateType,
                  relayProtocol: local.relayProtocol ?? null,
                });
              } catch (error) {
                reject(error);
              }
            };
          });
          // Attach rejection before negotiation awaits to avoid an unhandled timeout.
          outcome.catch(() => {});
          for (const [from, to] of [
            [a, b],
            [b, a],
          ])
            from.onicecandidate = ({ candidate }) => {
              if (!candidate) return;
              if (to.remoteDescription)
                void to.addIceCandidate(candidate).catch(() => {});
              else queues.get(to).push(candidate);
            };
          await a.setLocalDescription(await a.createOffer());
          await b.setRemoteDescription(a.localDescription);
          for (const candidate of queues.get(b))
            await b.addIceCandidate(candidate);
          await b.setLocalDescription(await b.createAnswer());
          await a.setRemoteDescription(b.localDescription);
          for (const candidate of queues.get(a))
            await a.addIceCandidate(candidate);
          return await outcome;
        } finally {
          clearTimeout(timer);
          a.close();
          b.close();
        }
      }, test.servers)
      .catch(() => ({ error: "RELAY_PROBE_FAILED" }));
    // No URL, IP, username, credential, SDP or raw browser error in probe output.
    process.stdout.write(JSON.stringify({ case: test.name, ...result }) + "\n");
    if (result.error) process.exitCode = 1;
  }
} finally {
  await browser.close();
}
