#!/usr/bin/env node
// Opt-in performance experiment, never part of unit tests. No credentials or real providers.
// Collectors/poller are bundled from this checkout. Upload variants reconstruct the pinned
// baseline and measured experiment. Production files are never changed. See the report.
import assert from "node:assert/strict";
import { uploadCandidate } from "./remote-agent-upload-candidate.mjs";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(path.join(repo, "apps/desktop/package.json"));
const { build } = require("esbuild");
const { WebSocket, WebSocketServer } = require("ws");
const root = path.join(repo, "apps/desktop/src/main/remote-agent");
const output = process.argv[2];
if (!output)
  throw new Error(
    "Usage: node scripts/benchmarks/remote-agent-performance.mjs <result.json>",
  );
const sleep = (ms) =>
  ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
const samples = [];
const eventOnly = process.env.CINDY_BENCH_EVENTS_ONLY === "1";
const uploadOnly = process.env.CINDY_BENCH_UPLOAD_ONLY === "1";
const baselineRef = "4538b647a6af841aed5c49f00fa96f581538f7b8";
const serialSource = (
  await promisify(execFile)(
    "git",
    [
      "show",
      `${baselineRef}:apps/desktop/src/main/remote-agent/controller/runClient.ts`,
    ],
    { cwd: repo },
  )
).stdout;
const work = await mkdtemp(path.join(tmpdir(), "cindy-remote-perf-"));
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
    p95Ms: +sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2),
    samples: values.length,
  };
}
async function compare(name, variants, n, meta = {}) {
  const times = Object.fromEntries(Object.keys(variants).map((k) => [k, []]));
  for (const fn of Object.values(variants)) await fn(); // warmup, excluded
  for (let i = 0; i < n; i++) {
    const entries = Object.entries(variants);
    if (i % 2) entries.reverse();
    for (const [key, fn] of entries) {
      const t = performance.now();
      await fn();
      times[key].push(performance.now() - t);
    }
  }
  const result = {
    name,
    ...meta,
    results: Object.fromEntries(
      Object.entries(times).map(([k, v]) => [k, summary(v)]),
    ),
    rawMs: times,
  };
  samples.push(result);
  process.stdout.write(JSON.stringify({ ...result, rawMs: undefined }) + "\n");
}
async function bundle(window) {
  const target = path.join(work, `modules-${window}.mjs`);
  const entry = `export * from ${JSON.stringify(path.join(root, "controller/projectFiles.ts"))};
export * from ${JSON.stringify(path.join(root, "controller/runClient.ts"))};
export * from ${JSON.stringify(path.join(root, "eventLog.ts"))};
export {parseRemoteAgentRequest} from ${JSON.stringify(path.join(repo, "packages/device-link/src/remoteAgent.ts"))};`;
  const facade = path.join(work, "maker-core.mjs");
  await writeFile(
    facade,
    ["skill-activation", "sensitive-credential-paths", "auto-review"]
      .map(
        (name) =>
          `export * from ${JSON.stringify(path.join(repo, "packages/maker-core/src/agents/shared", name + ".ts"))};`,
      )
      .join("\n") +
      `\nexport * from ${JSON.stringify(path.join(repo, "packages/maker-core/src/agents/base-agent.ts"))};`,
  );
  await build({
    stdin: { contents: entry, resolveDir: repo, loader: "ts" },
    outfile: target,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    alias: { "@cindy/maker-core": facade },
    plugins: [
      {
        name: "frozen-upload-experiment",
        setup(b) {
          b.onLoad({ filter: /controller\/runClient\.ts$/ }, () => ({
            contents:
              window === 1 ? serialSource : uploadCandidate(serialSource, window),
            loader: "ts",
          }));
        },
      },
    ],
  });
  return import(pathToFileURL(target).href);
}
// Real persistent loopback WebSocket. Delay is controlled, per-direction latency, NOT a WAN measurement.
async function link(rtt, handler) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => server.once("listening", r));
  let peer;
  server.on("connection", (ws) => {
    peer = ws;
    ws.on("message", async (bytes) => {
      const req = JSON.parse(bytes.toString());
      await sleep(rtt / 2);
      try {
        const value = await handler(req.args);
        await sleep(rtt / 2);
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ id: req.id, value }));
      } catch (e) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ id: req.id, error: String(e) }));
      }
    });
  });
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  await new Promise((r) => client.once("open", r));
  let seq = 0;
  const pending = new Map();
  let notify = () => {};
  client.on("message", (bytes) => {
    const m = JSON.parse(bytes.toString());
    if (m.event) {
      notify(m.event);
      return;
    }
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p?.reject(Error(m.error)) : p?.resolve(m.value);
  });
  return {
    invoke: (args) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        client.send(JSON.stringify({ id, args }));
      }),
    onEvent(fn) {
      notify = fn;
    },
    async push(event) {
      await sleep(rtt / 2);
      peer.send(JSON.stringify({ event }));
    },
    async close() {
      client.terminate();
      peer?.terminate();
      await new Promise((r) => server.close(r));
    },
  };
}
try {
  const baseline = await bundle(1),
    candidate = await bundle(2);
  const home = path.join(work, "home");
  await mkdir(home);
  const git = promisify(execFile);
  for (const count of eventOnly || uploadOnly ? [] : [8, 128]) {
    const project = path.join(work, `project-${count}`);
    await mkdir(project);
    await git("git", ["init", "-q", project]);
    await writeFile(
      path.join(project, "CLAUDE.md"),
      "Benchmark generated fixture.\n",
    );
    for (let i = 0; i < count; i++) {
      const dir = path.join(project, ".claude/skills", `skill-${i}`);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "SKILL.md"),
        `---\nname: skill-${i}\ndescription: fixture\n---\n` +
          "Synthetic instruction.\n".repeat(180),
      );
    }
    const options = { home, env: {}, skipCredentials: true };
    const projectFiles = () =>
      baseline.collectProjectInstructionFiles(project, options);
    const ancestors = () =>
      baseline.collectAncestorInstructionFiles(project, options);
    const markers = () => baseline.collectAncestorMarkers(project);
    const gitProbe = () =>
      git("git", ["-C", project, "rev-parse", "--is-inside-work-tree"]).then(
        (r) => r.stdout.trim() === "true",
      );
    async function collect(parallel) {
      let p, a, m, g;
      if (parallel)
        [p, a, m, g] = await Promise.all([
          projectFiles(),
          ancestors(),
          markers(),
          gitProbe(),
        ]);
      else {
        p = await projectFiles();
        a = await ancestors();
        m = await markers();
      }
      const personal = (
        await baseline.collectPersonalConfig("claude-code", p, options)
      ).personal;
      const imports = await baseline.collectInstructionImports(
        { workingDir: project, projectFiles: p, ancestorFiles: a, personal },
        options,
      );
      if (!parallel) g = await gitProbe();
      return { p, a, m, g, personal, imports };
    }
    const expected = await collect(false);
    // A TMPDIR inside a real project would pull its parent instruction files
    // (and their imports) into the samples; abort instead of mixing them in.
    assert.equal(
      expected.a.length,
      0,
      "fixture picked up instruction files outside the temp dir; set TMPDIR to a directory outside any project",
    );
    assert.deepEqual(await collect(true), expected);
    await compare(
      "collection",
      { serial: () => collect(false), parallel: () => collect(true) },
      25,
      { files: count, wireBytes: Buffer.byteLength(JSON.stringify(expected)) },
    );
    await compare(
      "five-simultaneous-collections",
      {
        independent: () =>
          Promise.all(Array.from({ length: 5 }, () => collect(true))),
        sharedInFlight: async () => {
          const pending = collect(true);
          return Promise.all(
            Array.from({ length: 5 }, async () =>
              structuredClone(await pending),
            ),
          );
        },
      },
      15,
      {
        files: count,
        note: "Experimental in-flight sharing only; no persistent cache or invalidation implementation.",
      },
    );
  }
  for (const rtt of eventOnly ? [] : [0, 50, 150]) {
    const received = new Map();
    const conn = await link(rtt, async (args) => {
      const r = baseline.parseRemoteAgentRequest(args[0]);
      assert.equal(r.op, "upload");
      const chunks = received.get(r.uploadId) ?? [];
      chunks[r.index] = Buffer.from(r.data, "base64");
      received.set(r.uploadId, chunks);
      return {};
    });
    try {
      for (const [name, data] of [
        ["small", "x".repeat(32768)],
        ["compressible", "instruction\n".repeat(180000)],
        ["large", randomBytes(3 * 1024 * 1024).toString("base64")],
      ]) {
        let id = 0;
        let chunkCount = 0;
        let gzBytes = 0;
        const run = (mod) => async () => {
          const client = new mod.RemoteAgentRunClient(
            "bench",
            new mod.RemoteAgentPoller(conn.invoke),
            {},
            () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
          );
          const payload = await client.payload({ data });
          if (payload.uploadId) {
            const chunks = received.get(payload.uploadId);
            const result = Buffer.concat(chunks);
            assert.equal(JSON.parse(gunzipSync(result)).data, data);
            chunkCount = payload.chunks;
            gzBytes = result.length;
            received.delete(payload.uploadId);
          } else assert.equal(payload.json.data, data);
        };
        await compare(
          "upload",
          { serial: run(baseline), candidate: run(candidate) },
          7,
          { rttMs: rtt, fixture: name, sourceBytes: data.length },
        );
        Object.assign(samples.at(-1), {
          chunks: chunkCount,
          gzipBytes: gzBytes,
        });
      }
    } finally {
      await conn.close();
    }
  }
  // Same transport and event bytes; production poller/EventLog vs an experimental push reference.
  // This measures delivery lag under a sustained stream, NOT model/tool-turn latency.
  for (const rtt of uploadOnly ? [] : [0, 50, 150]) {
    const lags = { poll: [], push: [] };
    let requests = 0;
    for (const mode of ["poll", "push"]) {
      const log = new baseline.EventLog(8 * 1024 * 1024);
      let done;
      const complete = new Promise((r) => (done = r));
      let seen = 0;
      const ids = [];
      const conn = await link(rtt, async (args) => {
        requests++;
        const r = baseline.parseRemoteAgentRequest(args[0]);
        const item = r.runs[0];
        const data = await log.read(item.cursor, 1024 * 1024, 1000);
        return {
          runs:
            data.data || data.done
              ? [
                  {
                    runId: "00000000-0000-4000-8000-000000000001",
                    from: data.from,
                    cursor: data.cursor,
                    ...(data.data
                      ? { data: data.data.toString("base64") }
                      : {}),
                    ...(data.done ? { done: true } : {}),
                  },
                ]
              : [],
        };
      });
      let poller;
      const splitter = new baseline.LineSplitter(1024 * 1024);
      function deliver(event) {
        ids.push(event.id);
        lags[mode].push(performance.now() - event.sent);
        if (++seen === 100) done();
      }
      if (mode === "poll") {
        poller = new baseline.RemoteAgentPoller(conn.invoke, {
          warn: (...args) => process.stderr.write(JSON.stringify(args) + "\n"),
        });
        poller.register({
          runId: "00000000-0000-4000-8000-000000000001",
          onData(data) {
            for (const line of splitter.push(data)) deliver(JSON.parse(line));
          },
          onLost(reason, error) {
            throw Error(reason + JSON.stringify(error));
          },
        });
      } else conn.onEvent(deliver);
      const pushes = [];
      try {
        for (let i = 0; i < 100; i++) {
          const event = {
            id: i,
            sent: performance.now(),
            text: "synthetic delta",
          };
          if (mode === "poll") log.append(event);
          else pushes.push(conn.push(event));
          await sleep(10);
        }
        let timeout;
        try {
          await Promise.race([
            complete,
            new Promise((_, reject) => {
              timeout = setTimeout(
                () =>
                  reject(
                    Error(
                      "Event delivery timeout " +
                        mode +
                        " seen=" +
                        seen +
                        " requests=" +
                        requests,
                    ),
                  ),
                5000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        await Promise.all(pushes);
        assert.deepEqual(
          ids,
          Array.from({ length: 100 }, (_, i) => i),
        );
      } finally {
        poller?.unregister("00000000-0000-4000-8000-000000000001");
        log.end();
        await sleep(rtt + 10);
        await conn.close();
      }
    }
    const result = {
      name: "event-delivery",
      rttMs: rtt,
      eventIntervalMs: 10,
      results: Object.fromEntries(
        Object.entries(lags).map(([k, v]) => [k, summary(v)]),
      ),
      pollRequests: requests,
      rawMs: lags,
    };
    samples.push(result);
    process.stdout.write(
      JSON.stringify({ ...result, rawMs: undefined }) + "\n",
    );
  }
  const result = {
    date: new Date().toISOString(),
    node: process.version,
    cpu: cpus()[0].model,
    platform: process.platform,
    arch: process.arch,
    baseline: baselineRef,
    candidate: "frozen two-chunk experiment (production unchanged)",
    method:
      "Warm filesystem collectors; real persistent loopback WebSocket with artificial one-way latency; no real model, WAN, bandwidth cap, loss, UI, or authorization service. Alternating A/B order.",
    samples,
  };
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
} finally {
  await rm(work, { recursive: true, force: true });
}
