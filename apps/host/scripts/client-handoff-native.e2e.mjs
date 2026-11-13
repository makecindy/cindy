import { createPlatformClientBridge } from '../src/platform/client-bridge.ts';
// Real native Agent process + production Host assembly + real HTTP proxy.
// Defaults to Codex; CINDY_TEST_AGENT=claude-code|pi selects the other native engines.
// The upstream is a local fixture, not a model or an OAuth provider.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createHostServer } from "../src/server.mjs";
import { createEventHub } from "../src/events.mjs";
import { browserContinuity } from "./fixtures/browser-continuity.mjs";

const kind = process.env.CINDY_TEST_AGENT ?? "codex";
assert.ok(["codex", "claude-code", "pi"].includes(kind));
const binary =
  process.env.CINDY_TEST_AGENT_BINARY ?? process.env.CINDY_TEST_CODEX_BINARY;
if (!binary || !path.isAbsolute(binary))
  throw new Error(
    "Set CINDY_TEST_AGENT_BINARY to the selected native engine binary",
  );
// The production logger installs an uncaught-exception listener. An assertion
// in this executable must still make CI fail, rather than merely log a fatal.
process.on("uncaughtExceptionMonitor", () => {
  process.exitCode = 1;
});
const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "cindy-host-codex-e2e-")),
);
// Reuse package-manager binaries, never account/configuration state. An isolated
// HOME otherwise prompts interactively before the full desktop even starts.
process.env.COREPACK_HOME ??= path.join(
  os.homedir(),
  ".cache",
  "node",
  "corepack",
);
process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
process.env.HOME = path.join(root, "home"); // Isolated process, never the user's CLI home.
process.env.USERPROFILE = process.env.HOME;
process.env.CLAUDE_CONFIG_DIR = path.join(process.env.HOME, ".claude");
await fs.mkdir(process.env.HOME);
for (const key of [
  "XDT_OFFICIAL_SHARED_PROFILE",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "XDT_CODEX_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
])
  delete process.env[key];
const requests = [];
let onNextResponse;
let rejectHandoff;
const handoffFailure = new Promise((_, reject) => {
  rejectHandoff = reject;
});
void handoffFailure.catch(() => {});
function anthropicEvents(tool = false) {
  const name = kind === "pi" ? "bash" : "Bash";
  const events = [
    {
      type: "message_start",
      message: {
        id: "fixture",
        type: "message",
        role: "assistant",
        model: "fixture-model",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: tool
        ? { type: "tool_use", id: "effect-once", name, input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: tool
        ? {
            type: "input_json_delta",
            partial_json: JSON.stringify({
              command: "printf 'once\\n' >> handoff-effect.txt",
            }),
          }
        : { type: "text_delta", text: "synthetic complete" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: {
        stop_reason: tool ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}
const upstream = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (req.url?.includes("count_tokens")) {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end('{"input_tokens":100}');
    return;
  }
  if (
    !req.url?.endsWith("/responses") &&
    !req.url?.split("?")[0].endsWith("/messages")
  ) {
    res
      .writeHead(404, { "content-type": "application/json" })
      .end('{"error":{"message":"No optional endpoint in fixture"}}');
    return;
  }
  const body = JSON.parse(raw);
  if (
    kind !== "codex" &&
    !(body.tools ?? []).some(
      (tool) => tool.name === (kind === "pi" ? "bash" : "Bash"),
    )
  ) {
    res
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(anthropicEvents());
    return;
  }
  requests.push({
    url: req.url,
    authorization:
      req.headers.authorization ?? `Bearer ${req.headers["x-api-key"]}`,
    body,
  });
  const hook = onNextResponse;
  onNextResponse = null;
  try {
    await hook?.();
  } catch (error) {
    rejectHandoff(error);
    res.destroy(error);
    return;
  }
  if (kind !== "codex") {
    res
      .writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
      })
      .end(anthropicEvents(requests.length === 1));
    return;
  }
  const id = `fixture-${requests.length}`;
  const item =
    requests.length === 1
      ? {
          type: "function_call",
          id: "effect-1",
          call_id: "effect-once",
          name: "exec_command",
          status: "completed",
          arguments: JSON.stringify({
            cmd: "printf 'once\\n' >> handoff-effect.txt",
            workdir: root,
          }),
        }
      : {
          type: "message",
          role: "assistant",
          id: `msg-${id}`,
          status: "completed",
          content: [{ type: "output_text", text: "synthetic complete" }],
        };
  const events = [
    {
      type: "response.created",
      response: { id, status: "in_progress", output: [] },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  res.writeHead(200, {
    "content-type": "text/event-stream",
    connection: "close",
  });
  res.end(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
  );
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${upstream.address().port}`;
// Any optional native network probe is kept within the fixture too.
process.env.HTTP_PROXY =
  process.env.HTTPS_PROXY =
  process.env.ALL_PROXY =
    endpoint;
process.env.NO_PROXY = "127.0.0.1,localhost";
const { configureHostOwner } = await import("../src/agent/claude-auth.mjs");
const { createHostProviderConfig } =
  await import("../src/agent/provider-config.ts");
const { createHostModelAccess } = await import("../src/agent/model-access.ts");
const { createHostCodexRuntime } =
  await import("../src/agent/codex-runtime.ts");
const { createHostMcpRuntime } = await import("../src/agent/mcp-runtime.ts");
const { createHostAgentGraph } = await import("../src/agent/runtime.mjs");
const { createCredentialStore } = await import("../src/credentials/store.mjs");
const { hostRuntimeLayout } = await import("../src/runtime-layout.mjs");
const { openOwnerDatabase } =
  await import("../../desktop/src/main/localDb/startupCore.ts");
const { createDbClientForHandle } =
  await import("../../desktop/src/main/localDb/client/createDbClientForHandle.ts");
const { setCurrentDbClient, clearCurrentDbClient, getCurrentDbClientSnapshot } =
  await import("../../desktop/src/main/localDb/client/current.ts");
const { OwnerSessionStorage } =
  await import("../../desktop/src/main/localDb/sessionStorageAdapter.ts");
const { createAvailabilityPolicy } =
  await import("../../desktop/src/main/device-link/providerShareAvailabilityPolicyCore.ts");
const { createCustomProvider } =
  await import("../../desktop/src/main/maker-host/custom-provider-store.ts");
const { setSessionProvider, clearSessionProvider } =
  await import("../../desktop/src/main/maker-host/session-provider-store.ts");
const { customProviderSecretStorageKey } =
  await import("../../desktop/src/shared/providerSecrets.ts");
const { dataOwnerStorageKey } =
  await import("../../desktop/src/main/dataOwnerPath.ts");
const { initLogger } = await import("../../desktop/src/main/logger.ts");
const { createInteractionBroker } =
  await import("../src/agent/interactions.mjs");
initLogger({ logDir: path.join(root, "logs"), isDev: true, level: "debug" });
const desktop =
  process.env.CINDY_TEST_DESKTOP === "1"
    ? await import("./fixtures/desktop-client.mjs")
    : null;
const queued = !!desktop || process.env.CINDY_TEST_QUEUE === "1";
const profile = desktop ? desktop.desktopProfile() : path.join(root, "profile");
const { desktopPorts } = await import("./fixtures/desktop-ports.mjs");
const ownerId = "native-runtime-fixture";
let database, config, modelAccess, mcp, runtime, graph;
const handles = [];
const hub = createEventHub();
const interactions = createInteractionBroker({ hub });
const { createInputQueue } = await import("../src/agent/input-queue.mjs");
const { createHostMessageStore } = await import("../src/message-store.ts");
const { readHostSession } = await import("../src/session-reads.ts");
const {
  saveAgentInputQueueSnapshot,
  loadAgentInputQueueSnapshot,
  getPersistedInputClientIds,
} = await import("../../desktop/src/main/localDb/agentInputQueueSnapshots.ts");
const persistMessage = createHostMessageStore({
  getOwner: getCurrentDbClientSnapshot,
  publish: (event) => hub.publish(event),
});
const queue = createInputQueue({
  getOwner: getCurrentDbClientSnapshot,
  getMaker: () => graph.maker,
  hub,
  interactions,
  readSession: (id) => readHostSession(database.drizzle, id),
  persistMessage,
  persistQueueSnapshot: saveAgentInputQueueSnapshot,
  loadQueueSnapshot: loadAgentInputQueueSnapshot,
  getPersistedClientIds: getPersistedInputClientIds,
});
const clients = new Set();
const platformClient = createPlatformClientBridge({ ownerId, assertCurrent() {} });
const api = createHostServer({
  token: "synthetic-client-token",
  instanceId: "original-host",
  platformClient: () => platformClient,
  events: hub,
  probe: () => ({
    status: "ok",
    pid: process.pid,
    runtime: { state: "ready" },
  }),
  interactions,
  ...(queued
    ? desktopPorts({
        profile,
        ownerId,
        db: () => database,
        graph: () => graph,
        config: () => config,
        modelAccess: () => modelAccess,
        input: queue,
      })
    : {}),
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const clientConfig = {
  baseUrl: `http://127.0.0.1:${api.address().port}`,
  token: "synthetic-client-token",
  instanceId: "original-host",
};
async function attachClient() {
  if (desktop) {
    const client = await desktop.attachDesktop(clientConfig);
    // Exercise the signed Electron executor after every actual window replacement.
    const deadline = Date.now() + 15_000;
    while (!platformClient.status().attached && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(platformClient.status().attached, true, 'New signed client must attach its platform executor');
    const before = await platformClient.call({ method: 'computer.describe' });
    assert.equal(typeof before.screen_locked, 'boolean');
    const { client: identity } = await platformClient.control('status');
    await platformClient.control('prepare', identity);
    const pending = platformClient.call({ method: 'computer.describe' });
    assert.equal(platformClient.status().waiting, 1);
    await platformClient.control('cancel', identity);
    assert.equal(typeof (await pending).screen_locked, 'boolean');
    console.log('PASS actual signed-client platform attachment, freeze and resume');
    const embedded = request => platformClient.call({ method: 'browser.call', request: { ...request, __mcpSessionId: 'queued-task' } });
    const opened = await embedded({ action: 'open', url: 'about:blank' });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    await assert.rejects(platformClient.control('prepare', identity), /STATE_REQUIRES_CLIENT/);
    assert.equal(platformClient.status().paused, false, 'A live page must defer upgrading without disabling browser control');
    const tabId = opened.data?.tabId ?? opened.tabId;
    assert.ok(tabId, JSON.stringify(opened));
    const persistedTabs = async () => {
      const response = await fetch(`${clientConfig.baseUrl}/api/right-sidebar-tabs/list`, {
        method: 'POST', headers: { authorization: `Bearer ${clientConfig.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'queued-task' }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    let rows;
    for (let attempt = 0; attempt < 100; attempt++) {
      rows = await persistedTabs();
      if (rows.tabs.some(tab => tab.id === tabId)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(rows.persistable, true);
    assert.ok(rows.tabs.some(tab => tab.id === tabId), 'Embedded tabs must persist in the Host database');
    const tabs = await embedded({ action: 'tabs' });
    assert.equal(tabs.ok, true);
    const closed = await embedded({ action: 'close', targetId: tabId });
    assert.equal(closed.ok, true, JSON.stringify(closed));
    for (let attempt = 0; ; attempt++) {
      try { await platformClient.control('prepare', identity); break; }
      catch (error) {
        if (attempt >= 100 || !/STATE_REQUIRES_CLIENT/.test(String(error))) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    await platformClient.control('cancel', identity);
    console.log('PASS embedded page persists in Host, blocks handoff while open and permits handoff after close');
    return client;
  }
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./fixtures/attached-client.mjs", import.meta.url)),
      JSON.stringify(clientConfig),
    ],
    { env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  clients.add(child);
  const messages = [];
  child.on("message", (message) => messages.push(message));
  const exited = once(child, "exit").then(() => {
    clients.delete(child);
  });
  const wait = (predicate) =>
    new Promise((resolve, reject) => {
      const found = messages.find(predicate);
      if (found) {
        resolve(found);
        return;
      }
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", receive);
        child.off("exit", ended);
      };
      const receive = (message) => {
        if (predicate(message)) {
          cleanup();
          resolve(message);
        }
      };
      const ended = () => {
        cleanup();
        reject(new Error("Client exited before receipt"));
      };
      child.on("message", receive);
      child.once("exit", ended);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Client receipt timed out"));
      }, 10_000);
    });
  await wait(
    (message) =>
      message.type === "connection" && message.state.status === "connected",
  );
  let id = 0;
  return {
    child,
    exited,
    wait,
    async snapshot() {
      return {
        history: (
          await this.request("/api/messages/list", {
            sessionId: "native-xd-0",
            limit: 20,
          })
        ).result,
        queue: (
          await this.request("/api/input/projection", {
            sessionId: "queued-task",
          })
        ).result,
      };
    },
    async request(path, body) {
      const requestId = ++id;
      child.send({ id: requestId, path, body });
      return wait(
        (message) => message.type === "reply" && message.id === requestId,
      );
    },
  };
}
let client;
let browserFixture;
try {
  await fs.mkdir(profile, { recursive: true });
  configureHostOwner({ userDataDir: profile, ownerId });
  const layout = hostRuntimeLayout();
  const opened = await openOwnerDatabase({
    userDataDir: profile,
    ownerId,
    isPackaged: false,
    drizzleDir: layout.drizzleDir,
    sqliteVecExtPath: layout.sqliteVecPath,
  });
  database = createDbClientForHandle({
    db: opened.db,
    drizzle: opened.drizzle,
    dispose: async () => opened.db.close(),
  });
  setCurrentDbClient(database, ownerId);
  const credentials = await createCredentialStore({
    userDataDir: profile,
    platform: "linux",
    keyPromise: Promise.resolve(Buffer.alloc(16, 9)),
  });
  config = createHostProviderConfig({
    profileDir: profile,
    ownerId,
    credentials,
    getCodexBinary: () => binary,
    gatewayConnected: () => Boolean(modelAccess?.gateway.credential),
    openExternal: async () => {
      throw new Error("Unexpected browser request");
    },
  });
  let gatewayKey = "synthetic-gateway-key";
  modelAccess = createHostModelAccess({
    ownerId,
    region: "global",
    readKey: () => config.builtinStore.get("xd"),
    writeKey: (value) => config.builtinStore.set("xd", value),
    request: async () => ({ endpoint, apiKey: gatewayKey }),
    onKeyChanged: () => graph?.gatewayRestart.schedule(),
    publish: () => {},
  });
  await modelAccess.start();
  await createCustomProvider({
    id: "cprov-fixture",
    name: "Synthetic API",
    auth: { method: "apiKey" },
    runtimes: {
      [kind]: {
        baseUrl: endpoint,
        wireProtocol:
          kind === "codex" ? "openai-responses" : "anthropic-messages",
        models: [
          {
            id: "fixture-model",
            name: "Fixture",
            contextWindow: 8192,
            maxOutput: 1024,
          },
        ],
      },
    },
  });
  credentials.write(
    `owner_${dataOwnerStorageKey(ownerId)}_${customProviderSecretStorageKey("cprov-fixture", kind)}`,
    "synthetic-custom-key",
  );
  await config.list();
  mcp = createHostMcpRuntime({
    appServerIds: () => [],
    getRemoteMcpBridgeToken: config.remoteBridgeToken,
  });
  if (kind === "codex")
    runtime = createHostCodexRuntime({
      profileDir: profile,
      binaryPath: binary,
      config,
      modelAccess,
      mcp,
      availabilityPolicy: createAvailabilityPolicy(async () => {
        throw new Error("Unexpected share mutation");
      }),
      publish: () => {},
    });
  if (process.env.CINDY_TEST_BROWSER === '1') browserFixture = await browserContinuity(profile);
  graph = createHostAgentGraph({
    userDataDir: profile,
    providerConfig: config,
    gateway: modelAccess.gateway,
    ...(kind === "codex"
      ? { codexBinaryPath: binary }
      : kind === "pi"
        ? { piBinaryPath: binary }
        : { binaryPath: binary }),
    codexRuntime: runtime,
    mcpRuntime: mcp,
    mcpProviders: browserFixture?.providers ?? [],
    storage: new OwnerSessionStorage({ db: () => database }),
  });
  if (queued) {
    const storage = new OwnerSessionStorage({ db: () => database });
    assert.equal(
      kind,
      "claude-code",
      "Full desktop fixture uses Claude; other native engines run the process test",
    );
    await storage.create({
      id: "native-xd-0",
      title: "Handoff acceptance",
      agentKind: kind,
      providerId: "xd",
      model: "fixture-model",
      workDir: root,
      permissionMode: "bypassPermissions",
    });
    await persistMessage("native-xd-0", {
      clientId: "before-replacement",
      role: "user",
      content: "History before replacement",
    });
    await storage.create({
      id: "queued-task",
      title: "Queue acceptance",
      agentKind: kind,
      model: "fixture-model",
      workDir: root,
      permissionMode: "ask",
    });
    await queue.setInteractionLock("queued-task", "awaiting-user", true);
    await queue.enqueue("queued-task", {
      clientId: "queued-once",
      text: "Wait for my confirmation",
    });
  }
  client = await attachClient();
  const snapshot = queued ? await client.snapshot() : null;
  if (queued) {
    assert.equal(snapshot.queue.pendingQueue[0].clientId, "queued-once");
    assert.ok(
      JSON.stringify(snapshot.history).includes("History before replacement"),
    );
  }
  for (const [index, providerId] of (kind === "codex"
    ? ["xd", "cprov-fixture", "xd"]
    : [kind === "pi" ? "cprov-fixture" : "xd"]
  ).entries()) {
    const sessionId = `native-${providerId}-${index}`;
    const expectedKey =
      providerId === "xd" ? gatewayKey : "synthetic-custom-key";
    if (index === 0)
      onNextResponse = async () => {
        onNextResponse = async () => {
          gatewayKey = "synthetic-refreshed-gateway-key";
          await modelAccess.sync.sync();
          // Native Codex is waiting on this response. Terminate the entire client,
          // keep the backend and native turn alive, then attach a fresh client.
          await browserFixture?.begin();
          const oldPid = client.child.pid;
          client.child.kill("SIGTERM");
          await client.exited;
          const decision = interactions.requestHost(
            sessionId,
            { kind: "permission", requestId: "across-upgrade" },
            new AbortController().signal,
            { isCurrent: () => true },
          );
          client = await attachClient();
          assert.notEqual(client.child.pid, oldPid);
          if (process.env.CINDY_TEST_DESKTOP_APP) {
            // Also exercise loss of the replacement packaged window while the
            // native task is still awaiting its response. Recovery reattaches a
            // third real window; the Host/queue/approval are not reconstructed.
            const replacementPid = client.child.pid;
            client.child.kill("SIGTERM");
            await client.exited;
            client = await attachClient();
            assert.notEqual(client.child.pid, replacementPid);
            console.log(`PACKAGED_CLIENT_RECOVERED originalHostPid=${process.pid}`);
          }
          await browserFixture?.finish();
          if (queued) {
            const next = await client.snapshot();
            assert.deepEqual(
              next.queue,
              snapshot.queue,
              "pending queue survives full desktop replacement",
            );
            assert.ok(
              JSON.stringify(next.history).includes(
                "History before replacement",
              ),
            );
          }
          const pending = await client.request("/api/interactions/pending", {
            sessionId,
          });
          assert.equal(pending.result[0].requestId, "across-upgrade");
          const body = {
            sessionId,
            requestId: "across-upgrade",
            decision: { kind: "permission", behavior: "allow" },
          };
          assert.equal(
            (await client.request("/api/interactions/respond", body)).result
              .accepted,
            true,
          );
          assert.equal((await decision).behavior, "allow");
          assert.ok(
            (await client.request("/api/interactions/respond", body)).error,
            "an approval cannot be applied twice",
          );
        };
      };
    setSessionProvider(sessionId, providerId);
    const handle = queued
      ? null
      : await graph.instances[kind].startSession({
          sessionId,
          providerId,
          model: "fixture-model",
          workingDir: root,
          permissionMode: "bypassPermissions",
        });
    if (handle) handles.push(handle);
    const events = [];
    let unsubscribe;
    const completed = queued
      ? new Promise((resolve, reject) => {
          unsubscribe = hub.subscribe((event) => {
            if (event.sessionId !== sessionId) return;
            events.push(event);
            if (event.type === "error")
              reject(
                new Error(
                  `Queued native turn failed: ${JSON.stringify(event.data)}`,
                ),
              );
            if (event.type === "done") resolve();
          });
        })
      : (async () => {
          for await (const event of handle.events()) {
            events.push(event);
            hub.publish({ ...event, sessionId });
            if (event.type === "error")
              throw new Error(
                `Native fixture failed: ${JSON.stringify(event.data)}`,
              );
            if (event.type === "done") return;
          }
          throw new Error("Native event stream ended without completion");
        })();
    void completed.catch(() => {}); // Observe early failures while send() is still settling.
    let timer;
    try {
      await Promise.race([
        (async () => {
          if (queued) {
            const result = await client.request("/api/input/enqueue", {
              sessionId,
              item: {
                clientId: "native-turn-once",
                text: "return synthetic complete",
              },
            });
            assert.ok(!result.error, JSON.stringify(result));
          } else
            await handle.send(
              { type: "user", content: "return synthetic complete" },
              { throwOnStartFailure: true },
            );
          await completed;
        })(),
        handoffFailure,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Native turn timed out")),
            desktop ? 600_000 : 45_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      unsubscribe?.();
    }
    assert.ok(events.some((event) => event.type === "done"));
    await client.wait(
      (message) =>
        message.type === "event" &&
        message.payload.sessionId === sessionId &&
        message.payload.type === "done",
    );
    const last = requests.at(-1);
    assert.equal(last.authorization, `Bearer ${expectedKey}`);
    assert.equal(last.body.model, "fixture-model");
    if (queued) {
      for (let i = 0; queue.isTurnRunning(sessionId) && i < 250; i++)
        await delay(10);
      assert.equal(
        queue.isTurnRunning(sessionId),
        false,
        "completion must settle durable output",
      );
      const after = await client.snapshot();
      assert.ok(
        JSON.stringify(after.history).includes("synthetic complete"),
        "completed native output must remain readable through the new window",
      );
      assert.deepEqual(after.queue, snapshot.queue);
      await client.captureCompleted?.();
      console.log(
        `PASS ${desktop ? "full Electron windows" : "client processes"} + real input queue/history: old history retained, pending queue retained, native output persisted`,
      );
    }
    await handle?.close();
    runtime?.closeSession(sessionId);
    clearSessionProvider(sessionId);
    graph.gatewayRestart.onSessionSettled();
  }
  assert.equal(
    requests.length,
    kind === "codex" ? 4 : 2,
    "exact native request count; no replay after client replacement",
  );
  assert.equal(
    await fs.readFile(path.join(root, "handoff-effect.txt"), "utf8"),
    "once\n",
    "native tool effect must not repeat",
  );
  console.log(
    `PASS native ${kind} + production Host: ${kind === "codex" ? "gateway/custom-provider turns and key rotation" : "native turn continues across client replacement"}`,
  );
  console.log(
    "PASS client process replacement: native file write occurs once, new client receives completion, pending approval is recovered and resolved once",
  );
} finally {
  let desktopCleanupError;
  try {
    if (desktop) await desktop.stopDesktop(clientConfig);
  } catch (error) {
    desktopCleanupError = error;
  }
  for (const child of clients) child.kill("SIGTERM");
  await Promise.all([...clients].map((child) => once(child, "exit")));
  interactions.dispose();
  await queue.dispose();
  platformClient.close();
  api.closeAllConnections();
  await new Promise((resolve) => api.close(resolve));
  for (const handle of handles) await handle.close().catch(() => {});
  graph?.gatewayRestart.clear();
  await graph?.maker.shutdown();
  await runtime?.close();
  await mcp?.close();
  await browserFixture?.close();
  modelAccess?.close();
  await config?.close();
  if (database) {
    clearCurrentDbClient(database);
    await database.dispose();
  }
  configureHostOwner({ userDataDir: profile, ownerId: null });
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  // Preserve evidence/profile when an actual desktop could still be using it.
  if (desktopCleanupError) throw desktopCleanupError;
  if (process.env.CINDY_TEST_ARTIFACT_DIR) {
    await fs.mkdir(process.env.CINDY_TEST_ARTIFACT_DIR, { recursive: true });
    await fs.writeFile(path.join(process.env.CINDY_TEST_ARTIFACT_DIR, 'private-evidence-root.txt'), root);
  } else await fs.rm(root, { recursive: true, force: true });
}
