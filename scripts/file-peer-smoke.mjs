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
          invoke: async (_id, value) => value,
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
