// Opt-in experiment: real production WebRTC runtime, synthetic bytes, loopback only.
// Usage: node scripts/file-peer-reuse-benchmark.mjs /path/to/chrome
// Installs the same pinned temporary TURN fixture as peer-transfer-acceptance.mjs.
import { createRequire } from "node:module";
import { fork, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createSocket } from "node:dgram";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { terminateTestProcess } from "./shared/terminate-test-process.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const { chromium } = require("playwright-core");
const { build } = require("esbuild");
const chrome = process.argv[2];
const transfersOnly = process.argv.includes("--transfers-only");
const idleOnly = process.argv.includes("--idle-only");
const diagnose = process.argv.includes("--diagnose");
const idleSeconds = Number(
  process.argv
    .find((arg) => arg.startsWith("--idle-seconds="))
    ?.split("=")[1] ?? (diagnose ? 60 : 120),
);
if (!Number.isFinite(idleSeconds) || idleSeconds <= 0 || idleSeconds > 3600)
  throw new Error("idle-seconds must be in (0, 3600]");
const selectedScenario = process.argv
  .find((arg) => arg.startsWith("--scenario="))
  ?.split("=")[1];
if (!chrome) throw new Error("Pass a Chrome executable");
const artifacts = await mkdtemp(
  path.join(tmpdir(), "cindy-file-reuse-results-"),
);
const scratch = await mkdtemp(path.join(tmpdir(), "cindy-file-reuse-fixture-"));
console.log(`Artifacts: ${artifacts}`);
const report = {
  startedAt: new Date().toISOString(),
  transfersOnly,
  idleOnly,
  scenarios: [],
  limitations: [
    "Two endpoints in one isolated headless Chrome; not MacBook-to-Studio WAN.",
    "Production files-v2 runtime with in-memory bridges; excludes disk, IPC, authentication, WSS signalling and UI rendering.",
    "Latency proxy adds delay, not bandwidth limits or packet loss. No production credentials or user files.",
    "CPU and RSS are aggregate Chrome processes for both endpoints; RSS is not private memory or mobile battery use.",
    "UDP counters cover both clients to/from TURN, including control packets; exclude IP/UDP headers and TURN relay-port traffic.",
  ],
};
let browser, turn;
const proxies = new Set();
const abort = async () => {
  for (const proxy of proxies) proxy.close();
  await browser?.close().catch(() => {});
  if (turn) terminateTestProcess(turn);
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void abort().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });

// One UDP forwarding socket per client address preserves TURN allocation identity.
async function proxyTurn(ice, delayMs) {
  const upstreamPort = Number(/:(\d+)\?/.exec(ice.urls)[1]);
  const front = createSocket("udp4");
  const sockets = new Map(),
    timers = new Set();
  let bytes = 0,
    packets = 0,
    closed = false;
  const deliver = (fn) => {
    if (!delayMs) return fn();
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!closed) fn();
    }, delayMs);
    timers.add(timer);
  };
  front.on("message", (msg, remote) => {
    bytes += msg.length;
    packets++;
    const key = `${remote.address}:${remote.port}`;
    let back = sockets.get(key);
    if (!back) {
      back = createSocket("udp4");
      sockets.set(key, back);
      back.on("message", (reply) => {
        bytes += reply.length;
        packets++;
        deliver(() => front.send(reply, remote.port, remote.address));
      });
      back.bind(0, "127.0.0.1");
    }
    deliver(() => back.send(msg, upstreamPort, "127.0.0.1"));
  });
  await new Promise((resolve) => front.bind(0, "127.0.0.1", resolve));
  const proxy = {
    ice: {
      ...ice,
      urls: `turn:127.0.0.1:${front.address().port}?transport=udp`,
    },
    count: () => ({ bytes, packets }),
    close() {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      front.close();
      for (const socket of sockets.values()) socket.close();
      proxies.delete(proxy);
    },
  };
  proxies.add(proxy);
  return proxy;
}

try {
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      scratch,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "node-turn@0.0.6",
    ],
    { stdio: "ignore", timeout: 120_000 },
  );
  turn = fork(
    path.join(root, "scripts/peer-transfer-turn-fixture.cjs"),
    [path.join(scratch, "node_modules/node-turn")],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, CINDY_PEER_TEST_DIAG: diagnose ? "1" : "0" },
    },
  );
  const ice = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("TURN startup timed out")),
      10_000,
    );
    turn.once("message", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    turn.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    turn.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("TURN exited"));
    });
  });
  turn.on("message", (value) => {
    if (value?.diagnostic) console.log(JSON.stringify(value));
  });
  const bundle = await build({
    entryPoints: [
      path.join(root, "packages/device-link/src/filePeerRuntimeSource.ts"),
    ],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "PeerRuntimeSource",
  });
  browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    chromiumSandbox: true,
    args: diagnose
      ? [
          "--enable-logging",
          "--v=1",
          `--log-file=${path.join(artifacts, "chrome.log")}`,
        ]
      : [],
  });
  report.browser = browser.version();
  const browserCdp = await browser.newBrowserCDPSession();
  async function resources() {
    const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
    const rss = execFileSync(
      "ps",
      ["-o", "rss=", "-p", processInfo.map((p) => p.id).join(",")],
      { encoding: "utf8" },
    )
      .trim()
      .split(/\s+/)
      .reduce((sum, n) => sum + Number(n), 0);
    return {
      cpu: Object.fromEntries(processInfo.map((p) => [p.id, p.cpuTime])),
      rssKiB: rss,
    };
  }
  async function idleSample(page, label, seconds, proxy) {
    console.log(`Idle sample: ${label}, ${seconds}s`);
    const before = await resources(),
      wire = proxy?.count(),
      start = performance.now();
    if (label === "connected-idle" && process.argv.includes("--diagnose")) {
      for (let elapsed = 0; elapsed < seconds; elapsed += 10) {
        await sleep(Math.min(10, seconds - elapsed) * 1000);
        console.log(
          JSON.stringify(
            await page.evaluate(async () =>
              Promise.all(
                window.peerStats.map(async (pc) => {
                  const rows = [];
                  (await pc.getStats()).forEach((r) => {
                    if (r.type === "candidate-pair" && r.nominated)
                      rows.push({
                        requestsSent: r.requestsSent,
                        responsesReceived: r.responsesReceived,
                        requestsReceived: r.requestsReceived,
                        responsesSent: r.responsesSent,
                        consentRequestsSent: r.consentRequestsSent,
                      });
                  });
                  return {
                    ice: pc.iceConnectionState,
                    state: pc.connectionState,
                    rows,
                  };
                }),
              ),
            ),
          ),
        );
      }
    } else await sleep(seconds * 1000);
    const after = await resources(),
      endWire = proxy?.count();
    const elapsedMs = performance.now() - start;
    const cpuSeconds = Object.entries(after.cpu).reduce(
      (sum, [pid, n]) =>
        sum +
        (before.cpu[pid] === undefined ? 0 : Math.max(0, n - before.cpu[pid])),
      0,
    );
    const result = {
      label,
      elapsedMs,
      cpuSeconds,
      cpuPercentOneCore: (cpuSeconds * 100000) / elapsedMs,
      rssBeforeKiB: before.rssKiB,
      rssAfterKiB: after.rssKiB,
      states: await page.evaluate(() => window.iceEvents),
      ...(wire
        ? {
            udpBytes: endWire.bytes - wire.bytes,
            udpPackets: endWire.packets - wire.packets,
          }
        : {}),
    };
    console.log(JSON.stringify(result));
    return result;
  }
  for (const scenario of [
    { name: "direct-loopback", delay: null },
    { name: "turn-loopback", delay: 0 },
    { name: "turn-delayed", delay: 75 },
  ]) {
    if (selectedScenario && selectedScenario !== scenario.name) continue;
    console.log(`Scenario: ${scenario.name}`);
    const proxy =
      scenario.delay === null ? null : await proxyTurn(ice, scenario.delay);
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.addScriptTag({
      content: await page.evaluate(
        () => PeerRuntimeSource.FILE_PEER_RUNTIME_SOURCE,
      ),
    });
    await page.evaluate(
      ({ iceServers, relay }) => {
        window.iceEvents = [];
        window.peerStats = [];
        let serial = 0;
        const Native = RTCPeerConnection;
        window.RTCPeerConnection = class extends Native {
          constructor(config) {
            super(relay ? { ...config, iceTransportPolicy: "relay" } : config);
            window.peerStats.push(this);
            const id = ++serial;
            this.addEventListener("connectionstatechange", () =>
              window.iceEvents.push({
                id,
                time: performance.now(),
                state: this.connectionState,
              }),
            );
          }
        };
        const ticket = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        const chunk = Uint8Array.from({ length: 16384 }, (_, i) => i % 251);
        const encoded = btoa(String.fromCharCode(...chunk));
        let size = 0,
          written = 0,
          first = null;
        const write = async (_sink, offset, data) => {
          if (first === null) first = performance.now();
          if (offset !== written) throw new Error("offset differs");
          const bytes = atob(data);
          for (let i = 0; i < bytes.length; i++)
            if (bytes.charCodeAt(i) !== chunk[(offset + i) % 16384])
              throw new Error("bytes differ");
          written += bytes.length;
        };
        const host = CindyFilePeerRuntime.createFilePeerRuntime({
          read: async (_id, t, offset) => {
            if (t !== ticket) throw new Error("ticket differs");
            return offset === size ? "" : encoded;
          },
          write: async () => {
            throw new Error("unexpected host write");
          },
          invoke: async (_id, payload) => payload,
        });
        const client = CindyFilePeerRuntime.createFilePeerRuntime({
          read: async () => {
            throw new Error("unexpected client read");
          },
          write,
          writeBatch: write,
        });
        let generation = 0,
          clientId,
          hostId;
        window.bench = {
          async connect() {
            clientId = `client-${++generation}`;
            hostId = `host-${generation}`;
            const start = performance.now();
            const sdp = await client.offer(clientId, iceServers, true);
            await client.answer(
              clientId,
              await host.accept(hostId, iceServers, sdp),
            );
            return performance.now() - start;
          },
          async transfer(bytes) {
            size = bytes;
            written = 0;
            first = null;
            const start = performance.now();
            await client.receive(clientId, ticket, size, "sink");
            if (written !== size) throw new Error("size differs");
            return {
              firstWriteMs: first - start,
              transferMs: performance.now() - start,
              bytes,
            };
          },
          stats: async () => JSON.parse(await client.stats(clientId)),
          close() {
            client.close(clientId);
            host.close(hostId);
          },
        };
      },
      { iceServers: proxy ? [proxy.ice] : [], relay: !!proxy },
    );
    const result = {
      name: scenario.name,
      proxyDelayPerDirectionMs: scenario.delay,
      transfers: [],
      idle: [],
    };
    report.scenarios.push(result);
    if (!transfersOnly && (idleOnly || scenario.delay === 75))
      result.idle.push(
        await idleSample(page, "disconnected-before", diagnose ? 1 : 60, proxy),
      );
    // Alternate independent cold/warm pairs; never serve bytes from a file cache.
    for (const bytes of idleOnly ? [] : [256 * 1024, 4 * 1024 * 1024])
      for (let i = 0; i < 5; i++) {
        const setupMs = await page.evaluate(() => bench.connect());
        const cold = await page.evaluate(
          (bytes) => bench.transfer(bytes),
          bytes,
        );
        const warm = await page.evaluate(
          (bytes) => bench.transfer(bytes),
          bytes,
        );
        const stats = await page.evaluate(() => bench.stats());
        if (stats.path !== (proxy ? "relay" : "direct"))
          throw new Error("Unexpected ICE path");
        result.transfers.push({
          repeat: i,
          bytes,
          setupMs,
          cold: {
            ...cold,
            totalMs: setupMs + cold.transferMs,
            firstWriteIncludingSetupMs: setupMs + cold.firstWriteMs,
          },
          warm,
          rttMs: stats.rttMs,
        });
        console.log(
          JSON.stringify({
            scenario: scenario.name,
            ...result.transfers.at(-1),
          }),
        );
        await page.evaluate(() => bench.close());
      }
    if (!transfersOnly && (idleOnly || scenario.delay === 75)) {
      await page.evaluate(() => bench.connect());
      result.beforeIdle = await page.evaluate(() => bench.stats());
      await sleep(5000);
      result.idle.push(
        await idleSample(page, "connected-idle", idleSeconds, proxy),
      );
      result.afterIdle = await page.evaluate(async () => ({
        transfer: await bench.transfer(262144),
        stats: await bench.stats(),
      }));
      await page.evaluate(() => bench.close());
      await sleep(5000);
      result.idle.push(
        await idleSample(page, "disconnected-after", diagnose ? 1 : 60, proxy),
      );
    }
    await page.close();
    proxy?.close();
    await writeFile(
      path.join(artifacts, "report.json"),
      JSON.stringify(report, null, 2),
    );
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await abort();
  await rm(scratch, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(artifacts, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `Report: ${path.join(artifacts, "report.json")} (${report.status})`,
  );
}
