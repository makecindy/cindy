// Real browser checks against production transport code. No account or user files required.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const executablePath = process.argv[2];
if (!executablePath) throw new Error("Pass a Chrome executable");
// Acceptance runner supplies temporary loopback TURN credentials, never production secrets.
const iceServers = JSON.parse(process.env.CINDY_PEER_TEST_ICE ?? "[]");
const expectedPath = iceServers.length ? "relay" : "direct";
const output = await build({
  entryPoints: [
    path.join(root, "packages/device-link/src/filePeerRuntimeSource.ts"),
  ],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "PeerRuntimeSource",
});
const browser = await chromium.launch({
  executablePath,
  headless: true,
  chromiumSandbox: true,
});
try {
  const page = await browser.newPage();
  if (iceServers.length) await page.evaluate(() => {
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(config) { super({ ...config, iceTransportPolicy: "relay" }); }
    };
  });
  await page.addScriptTag({ content: output.outputFiles[0].text });
  await page.addScriptTag({
    content: await page.evaluate(
      () => PeerRuntimeSource.FILE_PEER_RUNTIME_SOURCE,
    ),
  });
  for (const streaming of [false, true]) {
    const result = await page.evaluate(
      async ({ large, streaming, benchmark, iceServers, expectedPath }) => {
        const { createFilePeerRuntime } = CindyFilePeerRuntime;
        let sourceSize = 0,
          outputSize = 0,
          sourceOffset = 0,
          failWrite = false;
        const ticket = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        const host = createFilePeerRuntime({
          // Body requests echo a digest of the raw bytes so the client can verify them.
          invoke: async (_id, value, body) =>
            body
              ? JSON.stringify({
                  value,
                  length: body.length,
                  digest: body.reduce((sum, byte) => (sum * 31 + byte) >>> 0, 0),
                })
              : value,
          read: async (_id, t, offset) => {
            if (benchmark) await new Promise(resolve => setTimeout(resolve, 1));
            if (t !== ticket || offset !== sourceOffset)
              throw new Error("source offset");
            const chunk = Uint8Array.from(
              { length: Math.min(16384, sourceSize - offset) },
              (_, i) => ((offset + i) * 31) % 251,
            );
            sourceOffset += chunk.length;
            return btoa(String.fromCharCode(...chunk));
          },
          write: async () => {
            throw new Error("host write");
          },
        });
        const client = createFilePeerRuntime({
          read: async () => {
            throw new Error("client read");
          },
          write: async (_sink, offset, data) => {
            if (benchmark) await new Promise(resolve => setTimeout(resolve, 1));
            if (failWrite) throw new Error("disk full");
            if (offset !== outputSize) throw new Error("sink offset");
            for (const c of atob(data)) {
              if (c.charCodeAt(0) !== (outputSize * 31) % 251)
                throw new Error("bytes differ");
              outputSize++;
            }
          },
        });
        const setupStart = performance.now();
        const offer = await client.offer("client", iceServers, streaming);
        await client.answer("client", await host.accept("host", iceServers, offer));
        const setupMs = Math.round(performance.now() - setupStart);
        const stats = JSON.parse(await client.stats("client"));
        if (stats.path !== expectedPath) throw new Error("unexpected selected ICE path");
        if (streaming) {
          const value = JSON.stringify({ text: "中文🙂".repeat(128 * 1024) });
          if ((await client.invoke("client", value)) !== value)
            throw new Error("fragmented RPC differs");
          const replies = await Promise.all(
            ["a", "b", "c", "d"].map((value) => client.invoke("client", value)),
          );
          if (replies.join("") !== "abcd")
            throw new Error("RPC correlation failed");
          // Binary request bodies around the 16 KiB frame boundary, up to the 1 MiB block.
          const withBody = (value, length) => {
            const bytes = Uint8Array.from({ length }, (_, i) => (i * 7 + length) % 256);
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            const digest = bytes.reduce((sum, byte) => (sum * 31 + byte) >>> 0, 0);
            return client
              .invoke("client", value, undefined, btoa(binary))
              .then((reply) => {
                const r = JSON.parse(reply);
                if (r.value !== value || r.length !== length || r.digest !== digest)
                  throw new Error("RPC body differs");
              });
          };
          for (const length of [1, 16384, 16385, 1048576]) await withBody("body", length);
          // Three bodies in flight beside a plain request stay correlated.
          const [, plain] = await Promise.all([
            withBody("first", 1048576),
            client.invoke("client", "plain"),
            withBody("second", 300000),
            withBody("third", 1048576),
          ]);
          if (plain !== "plain") throw new Error("RPC correlation with bodies failed");
          const stats = JSON.parse(await client.stats("client"));
          if (stats.path !== expectedPath || !stats.streaming)
            throw new Error("selected path missing");
        }
        const sizes = [
          0,
          1,
          16384,
          16385,
          262144,
          262145,
          1048576,
          ...(benchmark ? [8 * 1024 * 1024] : []),
          ...(large
            ? [large === "2g" ? 2 * 1024 * 1024 * 1024 : 101 * 1024 * 1024]
            : []),
        ];
        try {
          const transfers = [];
          for (const size of sizes) {
            sourceSize = size;
            sourceOffset = 0;
            outputSize = 0;
            const start = performance.now();
            await Promise.all([
              client.receive("client", ticket, size, "sink"),
              ...(streaming
                ? [client.invoke("client", "concurrent-read")]
                : []),
            ]);
            if (outputSize !== size) throw new Error("bytes differ");
            const ms = Math.max(1, Math.round(performance.now() - start));
            transfers.push({ size, ms, bytesPerSecond: Math.round(size * 1000 / ms) });
          }
          let diagnostics = null;
          if (streaming) {
            // Progress diagnostics describe the last transfer and carry no addresses or URLs.
            const last = sizes[sizes.length - 1];
            const rawReceiver = await client.stats("client");
            const rawSender = await host.stats("host");
            if (/"(?:address|ip|port|url|relatedAddress|relatedPort|foundation|usernameFragment)"/.test(rawReceiver + rawSender))
              throw new Error("stats expose candidate addresses");
            const receiver = JSON.parse(rawReceiver);
            const sender = JSON.parse(rawSender);
            const r = receiver.receive, s = sender.send;
            if (!r || r.size !== last || r.received !== last || r.written !== last ||
                r.writes !== Math.ceil(last / 16384) || r.queued !== 0 || !(r.queuedMax >= 1))
              throw new Error("receive progress differs");
            if (!s || s.sent !== last || s.reads !== Math.ceil(last / 16384) + 1 || !(s.creditWaitMs >= 0))
              throw new Error("send progress differs");
            if (!(receiver.pair?.bytesReceived >= last) || typeof receiver.channel?.bufferedAmount !== "number")
              throw new Error("transport counters missing");
            if (receiver.local?.candidateType === undefined || receiver.path !== expectedPath ||
                !(receiver.candidates?.local?.[receiver.local.candidateType] >= 1) ||
                !(receiver.candidates?.pairs?.succeeded >= 1) ||
                typeof receiver.candidates?.localRelay !== "object")
              throw new Error("candidate kind missing");
            diagnostics = {
              receive: r, send: s, pair: receiver.pair, local: receiver.local,
              candidates: receiver.candidates,
            };
          }
          sourceSize = 10;
          sourceOffset = 0;
          outputSize = 0;
          failWrite = true;
          let rejected = false;
          try {
            await client.receive("client", ticket, 10, "sink");
          } catch {
            rejected = true;
          }
          if (!rejected) throw new Error("incomplete sink accepted");
          return {
            streaming,
            passedSizes: sizes,
            diskFailureRejected: rejected,
            rpc: streaming,
            setupMs,
            stats,
            transfers,
            diagnostics,
          };
        } finally {
          host.dispose();
          client.dispose();
        }
      },
      {
        large: process.argv.includes("--2g")
          ? "2g"
          : process.argv.includes("--large"),
        streaming,
        benchmark: process.argv.includes('--benchmark'),
        iceServers,
        expectedPath,
      },
    );
    console.log(JSON.stringify(result));
  }
} finally {
  await browser.close();
}
