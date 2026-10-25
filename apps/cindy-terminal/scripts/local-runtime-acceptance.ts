/** Native CI acceptance: official Ollama, real filesystem and child lifecycle.
 * Runs outside the distributed application; no fixture UI or credentials ship. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import path from "node:path";
import os from "node:os";
import {
  RemoteResourceRegistry,
  type RemoteResource,
} from "@cindy/device-link";
import { MANAGED_OLLAMA_PROVIDER_ID } from "@cindy/model-providers/localModelRuntime";
import { MANAGED_LLAMACPP_PROVIDER_ID } from "@cindy/model-providers/llamaCpp";
import { TerminalModelConfig } from "../src/models/config.js";
import { TerminalLocalModels } from "../src/local-models/service.js";
import type { TerminalSecrets } from "../src/contracts.js";

const report = process.env.CINDY_ACCEPTANCE_REPORT;
if (!report) throw new Error("CINDY_ACCEPTANCE_REPORT_REQUIRED");
const initial = await fetch("http://127.0.0.1:11434/api/version", {
  signal: AbortSignal.timeout(1500),
}).catch(() => null);
if (initial) {
  await initial.body?.cancel();
  throw new Error("ACCEPTANCE_PORT_IN_USE");
}
const root = await mkdtemp(path.join(os.tmpdir(), "cindy-native-ollama-"));
const secrets: TerminalSecrets = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
};
const client = { protocolVersion: 1 as const, primitives: ["text", "actions"] };
const context = { controllerDeviceId: "native-acceptance" };
const ref = { collectionId: "local-models", kind: "local-model", id: "ollama" };
const fetchRelease: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const headers = new Headers(init?.headers);
  if (
    new URL(url).origin === "https://api.github.com" &&
    process.env.CINDY_GITHUB_API_TOKEN
  )
    headers.set(
      "Authorization",
      `Bearer ${process.env.CINDY_GITHUB_API_TOKEN}`,
    );
  return fetch(input, {
    ...init,
    headers,
    ...(new URL(url).origin === "https://api.github.com"
      ? { redirect: "error" }
      : {}),
  });
};
let host: TerminalLocalModels | undefined;
try {
  const models = new TerminalModelConfig(root, secrets, async () => ({
    authenticated: false,
  }));
  await models.open();
  const open = () => {
    const registry = new RemoteResourceRegistry();
    host = new TerminalLocalModels({
      root,
      models,
      assertCurrent() {},
      changed() {},
      log: { info() {}, warn() {} },
      runtimeDiagnostic: (message) =>
        process.stderr.write(
          message.replace(/https?:\/\/[^\s]+/g, "[url]").slice(0, 4096),
        ),
      deps: { installFetch: fetchRelease },
      llamaCppDeps: { fetch: fetchRelease },
    });
    host.register(registry);
    return registry;
  };
  const registry = open();
  const result = await registry.invoke(context, {
    client,
    collectionId: "local-models",
    resourceRef: ref,
    actionId: "install",
  });
  const job = result.result as { id: string };
  assert.equal(typeof job.id, "string");
  const deadline = Date.now() + 20 * 60_000;
  let installedVersion: string | undefined;
  for (;;) {
    const resource = (await registry.get(context, {
      client,
      ref,
    })) as RemoteResource;
    const state = resource.blocks![0].data as {
      status: { kind: string; version?: string };
      job: { id: string; state: string; error?: string };
      progress?: { phase?: string; percent?: number; error?: string };
    };
    assert.equal(state.job.id, job.id);
    if (state.job.state === "failed") {
      const detail = state.progress?.error
        ?.replace(/https?:\/\/[^\s]+/g, "[url]")
        .slice(0, 500);
      throw new Error(
        `${state.job.error ?? "LOCAL_RUNTIME_INSTALL_FAILED"}: ${detail ?? state.progress?.phase ?? "unknown phase"}`,
      );
    }
    if (state.job.state === "completed") {
      assert.equal((await host!.service.status()).kind, "ready");
      installedVersion = state.status.version;
      break;
    }
    if (Date.now() >= deadline)
      throw new Error("LOCAL_RUNTIME_INSTALL_TIMED_OUT");
    await wait(2000);
  }
  assert.ok(installedVersion);
  const provider = models
    .snapshot()
    .providers.find((p) => p.id === MANAGED_OLLAMA_PROVIDER_ID);
  assert.ok(provider);
  for (const engine of ["pi", "codex", "claude-code"] as const)
    assert.ok(provider.runtimes[engine]);
  await host!.close();
  host = undefined;
  await assert.rejects(
    fetch("http://127.0.0.1:11434/api/version", {
      signal: AbortSignal.timeout(1500),
    }),
  );
  open();
  await models.prepareLocalModel(MANAGED_OLLAMA_PROVIDER_ID);
  const restarted = (await (
    await fetch("http://127.0.0.1:11434/api/version", {
      signal: AbortSignal.timeout(1500),
    })
  ).json()) as { version: string };
  assert.equal(restarted.version, installedVersion);
  await host!.close();
  host = undefined;
  await assert.rejects(
    fetch("http://127.0.0.1:11434/api/version", {
      signal: AbortSignal.timeout(1500),
    }),
  );
  const llamaInitial = await fetch("http://127.0.0.1:11435/health", {
    signal: AbortSignal.timeout(1500),
  }).catch(() => null);
  if (llamaInitial) {
    await llamaInitial.body?.cancel();
    throw new Error("ACCEPTANCE_LLAMA_PORT_IN_USE");
  }
  const llamaRegistry = open();
  const llamaRef = { ...ref, id: "llamacpp" };
  const llamaAction = async (actionId: string) => {
    const action = await llamaRegistry.invoke(context, {
      client,
      collectionId: ref.collectionId,
      resourceRef: llamaRef,
      actionId,
    });
    const jobId = (action.result as { id: string }).id;
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const resource = await llamaRegistry.get(context, {
        client,
        ref: llamaRef,
      });
      const state = resource.blocks![0].data as {
        job: { id: string; state: string; error?: string };
        installed: boolean;
        running: boolean;
        version?: string;
      };
      assert.equal(state.job.id, jobId);
      if (state.job.state === "failed")
        throw new Error(
          `LLAMACPP_${actionId.toUpperCase()}: ${state.job.error}`,
        );
      if (state.job.state === "completed") return state;
      if (Date.now() >= deadline)
        throw new Error("LLAMACPP_ACCEPTANCE_TIMEOUT");
      await wait(1000);
    }
  };
  const llamaInstalled = await llamaAction("install");
  assert.ok(llamaInstalled.installed);
  const llamaStarted = await llamaAction("start");
  assert.ok(llamaStarted.running);
  await host!.close();
  host = undefined;
  await assert.rejects(
    fetch("http://127.0.0.1:11435/health", {
      signal: AbortSignal.timeout(1500),
    }),
  );
  open();
  await models.prepareLocalModel(MANAGED_LLAMACPP_PROVIDER_ID);
  assert.ok((await host!.llamaCpp.service.snapshot()).running);
  await host!.close();
  host = undefined;
  await assert.rejects(
    fetch("http://127.0.0.1:11435/health", {
      signal: AbortSignal.timeout(1500),
    }),
  );
  await mkdir(report, { recursive: true });
  await writeFile(
    path.join(report, "local-runtime.json"),
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        ollama: installedVersion,
        llamaCpp: llamaInstalled.version,
        installation: "PASS",
        headlessStartup: "PASS",
        persistedModelConfiguration: "PASS",
        ownedChildShutdown: "PASS",
        restart: "PASS",
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS: official Ollama ${installedVersion} and llama.cpp ${llamaInstalled.version} install, headless start, stop and restart (${process.platform}/${process.arch})`,
  );
} finally {
  await host?.close();
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
