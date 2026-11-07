#!/usr/bin/env node
// Explicit opt-in: use the existing Cindy dev CDP bridge to exercise its real authenticated
// Device Link and an unchanged second computer. No app install/restart, model call or auth export.
import assert from "node:assert/strict";
import { uploadCandidate } from "./remote-agent-upload-candidate.mjs";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const { build } = require("esbuild");
const WebSocket = require("ws");
const args = Object.fromEntries(
  process.argv.slice(2).map((x) => {
    const i = x.indexOf("=");
    assert(i > 2, "Use --key=value");
    return [x.slice(2, i), x.slice(i + 1)];
  }),
);
assert(
  args.device && args.out && args.baseline,
  "Required: --device=<id> --out=<json> --baseline=<git-ref>",
);
const kinds = (args.variants ?? "serial,candidate").split(",");
assert(
  kinds.every((k) =>
    ["serial", "candidate", "window2", "window4", "small2", "small4"].includes(
      k,
    ),
  ),
  "Unknown variant",
);
const rounds = Number(args.rounds ?? 5);
assert(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 20);
const sourcePath = "apps/desktop/src/main/remote-agent/controller/runClient.ts";
const oldSource = execFileSync(
  "git",
  ["show", `${args.baseline}:${sourcePath}`],
  { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 },
);
assert(
  oldSource.includes("for (let index = 0; index < chunks; index += 1)"),
  "Baseline must use sequential upload",
);
const scratch = await mkdtemp(path.join(tmpdir(), "cindy-upload-live-"));
const snapshots = [];
const sourceHashes = {};
let socket;
const pending = new Map();
let seq = 0;
const records = [];
let sourceSelf;
let targetInfo;
let stateBefore;
let stateAfter;
const channel = "maker:remote-agent:v1";
function stats(a) {
  if (!a.length) return { n: 0 };
  const s = [...a].sort((a, b) => a - b);
  return {
    medianMs: +s[Math.floor(s.length / 2)].toFixed(2),
    p95Ms: +s[Math.ceil(s.length * 0.95) - 1].toFixed(2),
    n: s.length,
  };
}
// Embed data in evaluated source as an inert literal: JSON plus escapes for
// characters that can end a script context or a JS string line.
const literal = (value) =>
  JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
async function evaluate(expression) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("CDP result uncertain; do not replay writes"));
    }, 60000);
    pending.set(id, { resolve, reject, timer });
    socket.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
}
const call = (request) =>
  evaluate(
    `window.electronAPI.deviceLink.invoke(${literal(args.device)},${literal(channel)},[${literal(request)}])`,
  );
async function expectRejectedOpen(payload) {
  const request = {
    op: "open",
    runId: randomUUID(),
    agentKind: "codex",
    payload,
  };
  const result = await evaluate(
    `(async()=>{try{await window.electronAPI.deviceLink.invoke(${literal(args.device)},${literal(channel)},[${literal(request)}]);return {unexpectedSuccess:true};}catch(e){return {error:String(e.message)}}})()`,
  );
  assert(!result.unexpectedSuccess, "Sentinel unexpectedly started a task");
  return result.error;
}
async function compile(kind) {
  const output = path.join(scratch, kind + ".mjs");
  await build({
    stdin: {
      contents: `export {RemoteAgentRunClient,RemoteAgentPoller} from ${JSON.stringify(path.join(root, sourcePath))}`,
      resolveDir: root,
      loader: "ts",
    },
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "upload-variant",
        setup(b) {
          b.onLoad({ filter: /controller\/runClient\.ts$/ }, () => {
            let source =
              kind === "serial" ? oldSource : uploadCandidate(oldSource);
            if (
              kind === "window2" ||
              kind === "window4" ||
              kind.startsWith("small")
            ) {
              assert(/const UPLOAD_WINDOW = [24];/.test(source));
              source = source.replace(
                /const UPLOAD_WINDOW = [24];/,
                `const UPLOAD_WINDOW = ${kind.endsWith("2") ? 2 : 4};`,
              );
            }
            if (kind.startsWith("small")) {
              const anchor =
                "    const chunks = Math.max(1, Math.ceil(gz.length / REMOTE_AGENT_UPLOAD_CHUNK_BYTES));";
              assert(source.includes(anchor));
              source = source
                .replace(
                  anchor,
                  "    const chunkBytes = gz.length <= REMOTE_AGENT_UPLOAD_CHUNK_BYTES ? REMOTE_AGENT_UPLOAD_CHUNK_BYTES : Math.max(128 * 1024, Math.ceil(gz.length / 128));\n    const chunks = Math.max(1, Math.ceil(gz.length / chunkBytes));",
                )
                .replace(
                  "index * REMOTE_AGENT_UPLOAD_CHUNK_BYTES, (index + 1) * REMOTE_AGENT_UPLOAD_CHUNK_BYTES",
                  "index * chunkBytes, (index + 1) * chunkBytes",
                );
            }
            sourceHashes[kind] = createHash("sha256")
              .update(source)
              .digest("hex");
            return { contents: source, loader: "ts" };
          });
        },
      },
    ],
  });
  return import(pathToFileURL(output).href);
}
try {
  const targets = await fetch(
    `${args.cdp ?? "http://127.0.0.1:9222"}/json/list`,
  ).then((r) => r.json());
  const matching = targets.filter(
    (t) =>
      t.type === "page" &&
      /^http:\/\/(localhost|127\.0\.0\.1):\d+\/#\/cc-agent\//.test(t.url),
  );
  const target = args.target
    ? matching.find((t) => t.id === args.target)
    : matching.length === 1
      ? matching[0]
      : undefined;
  assert(target, "No unambiguous Cindy main window; specify --target");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const rejectPending = (error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };
  socket.on("close", () =>
    rejectPending(
      Error("CDP closed; delivery uncertain, do not replay writes"),
    ),
  );
  socket.on("error", rejectPending);
  socket.on("message", (bytes) => {
    const m = JSON.parse(bytes);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error || m.result?.exceptionDetails)
      p.reject(
        Error(
          m.error?.message ??
            m.result.exceptionDetails.exception?.description ??
            m.result.exceptionDetails.text,
        ),
      );
    else p.resolve(m.result?.result?.value);
  });
  const devices = await evaluate("window.electronAPI.deviceLink.listDevices()");
  sourceSelf = devices.devices.find((d) => d.isSelf);
  targetInfo = devices.devices.find((d) => d.deviceId === args.device);
  assert(
    sourceSelf &&
      targetInfo &&
      !targetInfo.isSelf &&
      targetInfo.online &&
      targetInfo.controlEnabled,
    "Target identity/availability not confirmed",
  );
  stateBefore = await evaluate("window.electronAPI.deviceLink.getState()");
  const caps = await call({ op: "caps" });
  assert(caps.uploadChunkBytes === 524288);
  const variants = Object.fromEntries(
    await Promise.all(kinds.map(async (k) => [k, await compile(k)])),
  );
  const idleProbe = [];
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    await call({ op: "caps" });
    idleProbe.push(performance.now() - t);
  }
  for (const bytes of [3 * 1024 * 1024, 8 * 1024 * 1024]) {
    // Valid transport payload, deliberately invalid open schema. The remote host consumes all
    // chunks, verifies gzip CRC and parses JSON, then rejects before creating any Agent/task.
    const value = { benchmarkPadding: randomBytes(bytes).toString("base64") };
    for (let round = -1; round < rounds; round++) {
      const order = [...kinds];
      for (let i = 0; i < (round + 1) % kinds.length; i++)
        order.push(order.shift());
      for (const kind of order) {
        const mod = variants[kind];
        let active = 0,
          peak = 0,
          sent = 0,
          probing = false;
        const control = [];
        const controls = [];
        let timer;
        const invoke = async ([request]) => {
          active++;
          peak = Math.max(peak, active);
          sent++;
          if (!timer)
            timer = setInterval(() => {
              if (!probing) {
                probing = true;
                const task = probe().finally(() => {
                  probing = false;
                });
                void task.catch(() => undefined);
                controls.push(task);
              }
            }, 50);
          try {
            return await call(request);
          } finally {
            active--;
          }
        };
        const client = new mod.RemoteAgentRunClient(
          randomUUID(),
          new mod.RemoteAgentPoller(invoke),
          {},
          randomUUID,
        );
        // A small read and a no-op close on a fresh run id compete with the upload. Never stop a real task.
        const probe = async () => {
          for (const op of ["caps", "close"]) {
            const t = performance.now();
            await call(
              op === "caps"
                ? { op }
                : {
                    op,
                    runId: randomUUID(),
                    mode: "close",
                    reason: "navigation",
                  },
            );
            control.push({ op, ms: performance.now() - t });
          }
        };
        const started = performance.now();
        let payload, elapsed;
        try {
          payload = await client.payload(value);
          elapsed = performance.now() - started;
        } finally {
          clearInterval(timer);
          await Promise.allSettled(controls);
        }
        await Promise.all(controls);
        assert(payload.uploadId, "Expected a multi-chunk payload");
        const validation = await expectRejectedOpen(payload);
        assert(validation.includes("REMOTE_AGENT_INVALID"), validation);
        const consumed = await expectRejectedOpen(payload);
        assert(
          consumed.includes("REMOTE_AGENT_EXPIRED") &&
            /upload.*(missing|expired)/i.test(consumed),
          consumed,
        );
        const state = await evaluate(
          "window.electronAPI.deviceLink.getState()",
        );
        if (round >= 0) {
          const record = {
            kind,
            round,
            sourceBytes: Buffer.byteLength(JSON.stringify(value)),
            gzipBytes: payload.bytes,
            chunks: payload.chunks,
            uploadMs: elapsed,
            peakUploadRequests: peak,
            uploadRequests: sent,
            controlProbes: control,
            direct: state.directDataDeviceIds?.includes(args.device) === true,
            validatedAndConsumed: true,
          };
          records.push(record);
          process.stdout.write(JSON.stringify(record) + "\n");
        }
      }
    }
  }
  stateAfter = await evaluate("window.electronAPI.deviceLink.getState()");
  for (const bytes of [...new Set(records.map((x) => x.sourceBytes))])
    for (const kind of kinds) {
      const rows = records.filter(
        (x) => x.sourceBytes === bytes && x.kind === kind,
      );
      snapshots.push({
        sourceBytes: bytes,
        kind,
        upload: stats(rows.map((x) => x.uploadMs)),
        control: stats(rows.flatMap((x) => x.controlProbes.map((p) => p.ms))),
        directEverySample: rows.every((x) => x.direct),
        allValidated: rows.every((x) => x.validatedAndConsumed),
      });
    }
  await writeFile(
    args.out,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        baseline: args.baseline,
        sourceHashes,
        invokeScheduling:
          "channel default, same as production remoteBackgroundInvoke",
        probeSchedule:
          "one caps/close pair at a time, every 50ms while uploads are in flight; final pair may finish after upload",
        source: {
          platform: sourceSelf.platform,
          version: sourceSelf.appVersion,
        },
        target: {
          platform: targetInfo.platform,
          version: targetInfo.appVersion,
        },
        directBefore:
          stateBefore.directDataDeviceIds?.includes(args.device) === true,
        directAfter:
          stateAfter.directDataDeviceIds?.includes(args.device) === true,
        idleControl: stats(idleProbe),
        summary: snapshots,
        records,
        limitations: [
          "Actual Cindy-to-Cindy authenticated Device Link. CDP is a local invocation adapter, identical across variants.",
          "Receiver unchanged; invalid-open sentinel exercises reassembly, gzip verification/JSON parsing and cleanup without model/task creation.",
          "Control probes are caps and no-op close, not user-message rendering or interruption of a running model.",
          "No forced relay/network impairment; no restart/update of installed apps.",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(JSON.stringify({ summary: snapshots }) + "\n");
} catch (error) {
  await writeFile(
    args.out,
    JSON.stringify(
      {
        completed: false,
        baseline: args.baseline,
        sourceHashes,
        records,
        failureCode:
          /\[[A-Z_]+\]/.exec(String(error.message))?.[0] ?? "BENCHMARK_FAILED",
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  for (const p of pending.values()) clearTimeout(p.timer);
  socket?.close();
  await rm(scratch, { recursive: true, force: true });
}
