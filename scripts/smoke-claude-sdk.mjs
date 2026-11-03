// Explicit runtime regression: real SDK + bundled CLI, loopback model, no account.
// Run: node scripts/smoke-claude-sdk.mjs
// --sdk-module <sdk.mjs> and --entrypoint <name> allow a pre-upgrade baseline.
// --daemon-bundle <cc-mgr.mjs> additionally tests the real remote RPC runtime locally.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), "..");
const arg = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const platform = `${process.platform}-${process.arch}`;
const cli =
  arg("--cli") ??
  path.join(
    repo,
    "apps",
    "claude-code-bin",
    platform,
    process.platform === "win32" ? "claude.exe" : "claude",
  );

// Session helpers read process.env too. Isolate the entire test process, before
// importing the SDK, rather than temporarily mutating the developer's home.
if (!process.argv.includes("--isolated-root")) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cindy-claude-sdk-smoke-"),
  );
  try {
    const env = {};
    for (const key of [
      "PATH",
      "Path",
      "SystemRoot",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
    ]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      APPDATA: root,
      LOCALAPPDATA: root,
      TEMP: root,
      TMP: root,
      TMPDIR: root,
      XDG_CONFIG_HOME: root,
      CLAUDE_CONFIG_DIR: path.join(root, "claude"),
      ANTHROPIC_API_KEY: "invalid-loopback-test-key",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      CLAUDE_CODE_ENTRYPOINT: arg("--entrypoint") ?? "claude-desktop",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      CLAUDE_CODE_DISABLE_CRON: "1",
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      OTEL_SDK_DISABLED: "true",
      DISABLE_AUTOUPDATER: "1",
    });
    if (process.platform === "win32") {
      const bashCandidates = [
        arg("--bash"),
        process.env.CLAUDE_CODE_GIT_BASH_PATH,
        "D:/Git/bin/bash.exe",
        "C:/Program Files/Git/bin/bash.exe",
      ].filter(Boolean);
      for (const candidate of bashCandidates) {
        if (
          await fs.stat(candidate).then(
            () => true,
            () => false,
          )
        ) {
          env.CLAUDE_CODE_GIT_BASH_PATH = candidate;
          break;
        }
      }
      assert.ok(
        env.CLAUDE_CODE_GIT_BASH_PATH,
        "Pass --bash <Git Bash executable> on Windows",
      );
    }
    await fs.mkdir(path.join(root, "work"), { recursive: true });
    const childArgs = process.argv.slice(2);
    for (const key of ["--cli", "--sdk-module", "--daemon-bundle", "--bash"]) {
      const i = childArgs.indexOf(key);
      if (i >= 0 && childArgs[i + 1])
        childArgs[i + 1] = path.resolve(childArgs[i + 1]);
    }
    const child = spawn(
      process.execPath,
      [script, ...childArgs, "--isolated-root", root],
      {
        env,
        cwd: path.join(root, "work"),
        stdio: "inherit",
        windowsHide: true,
      },
    );
    const [code] = await once(child, "exit");
    process.exitCode = code ?? 1;
  } finally {
    assert.ok(
      root.startsWith(path.join(os.tmpdir(), "cindy-claude-sdk-smoke-")),
    );
    await fs.rm(root, { recursive: true, force: true });
  }
} else {
  await run();
}

async function run() {
  const root = arg("--isolated-root");
  const cwd = path.join(root, "work");
  const sdkModule = arg("--sdk-module");
  const sdkLocation = sdkModule
    ? pathToFileURL(path.resolve(sdkModule)).href
    : import.meta.resolve("@anthropic-ai/claude-agent-sdk");
  const sdk = await import(sdkLocation);
  const sdkVersion = JSON.parse(
    await fs.readFile(new URL("./package.json", sdkLocation), "utf8"),
  ).version;
  const { z } = await import("zod");
  const file = path.join(cwd, "fixture.txt");
  const planFile = path.join(cwd, "plan-denied.txt");
  const hookFile = path.join(cwd, "hook-denied.txt");
  const calls = [],
    hooks = [],
    mcpCalls = [],
    requests = [],
    steps = new Map();
  const trace = (...values) => {
    if (process.argv.includes("--verbose")) console.log(...values);
  };
  const queries = new Set();
  let cancelRequested;
  const cancelSeen = new Promise((resolve) => {
    cancelRequested = resolve;
  });
  const tool = (name, input) => ({
    type: "tool_use",
    id: `tool_${randomUUID()}`,
    name,
    input,
  });
  const text = (value) => ({ type: "text", text: value });
  const workflow = [
    () => tool("Write", { file_path: file, content: "before\n" }),
    () =>
      tool("Edit", {
        file_path: file,
        old_string: "before",
        new_string: "after",
      }),
    () => tool("Read", { file_path: file }),
    () =>
      tool("Bash", {
        command: 'printf "BASH_COMPAT_OK %s" "$CINDY_SMOKE_PROJECT"',
        description: "Print isolated test markers",
      }),
    () => tool("mcp__compat__echo", { value: "DENY" }),
    () => tool("mcp__compat__echo", { value: "ALLOW" }),
    () =>
      tool("Agent", {
        subagent_type: "compat-worker",
        description: "Test child event delivery",
        prompt: "CHILD_COMPAT",
      }),
    () => tool("Skill", { skill: "compat-plugin:compat-skill" }),
    () =>
      tool("AskUserQuestion", {
        questions: [
          {
            question: "Fixture question?",
            header: "Compat",
            options: [
              { label: "Yes", description: "Fixture answer" },
              { label: "No", description: "Other fixture answer" },
            ],
            multiSelect: false,
          },
        ],
      }),
    () => [
      {
        type: "thinking",
        thinking: "Fixture reasoning",
        signature: "fixture-signature",
      },
      text("WORKFLOW_OK"),
    ],
  ];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      if (req.url?.includes("count_tokens")) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      assert.equal(req.headers["x-api-key"], "invalid-loopback-test-key");
      requests.push({ body, userAgent: req.headers["user-agent"] });
      const users = body.messages?.filter((m) => m.role === "user") ?? [];
      const prompt = users
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : m.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join(" "),
        )
        .join(" ");
      const tag = prompt
        .match(
          /CHILD_COMPAT|COMPAT_CONTINUE|COMPAT_CANCEL|COMPAT_BACKGROUND|COMPAT_RESUME|COMPAT_FORK|COMPAT_WORKFLOW|COMPAT_PLAN|COMPAT_HOOK_GUARD|COMPAT_REMOTE/g,
        )
        ?.at(-1);
      const step = steps.get(tag) ?? 0;
      trace("model", tag, step);
      steps.set(tag, step + 1);
      if (tag === "COMPAT_CANCEL") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": waiting for interrupt\n\n");
        cancelRequested();
        return;
      }
      let content;
      if (tag === "COMPAT_WORKFLOW")
        content = workflow[Math.min(step, workflow.length - 1)]();
      else if (
        (tag === "COMPAT_PLAN" || tag === "COMPAT_HOOK_GUARD") &&
        step === 0
      )
        content = tool("Write", {
          file_path: tag === "COMPAT_PLAN" ? planFile : hookFile,
          content: "must not be written",
        });
      else if (tag === "COMPAT_BACKGROUND" && step === 0)
        content = tool("Bash", {
          command: "sleep 30",
          run_in_background: true,
          description: "Temporary background task for stopTask regression",
        });
      else if (tag === "COMPAT_REMOTE" && step === 0)
        content = tool("Bash", {
          command: 'test -n "$HOME" && command -v node && printf REMOTE_ENV_OK',
          description: "Check daemon OS environment reaches tool processes",
        });
      else content = text(tag === "CHILD_COMPAT" ? "CHILD_OK" : `${tag}_OK`);
      assert.ok(content, `Unexpected model request at ${tag}/${step}`);
      content = Array.isArray(content) ? content : [content];
      const stop = content.some((b) => b.type === "tool_use")
        ? "tool_use"
        : "end_turn";
      const usage = {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
      const message = {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage,
      };
      if (!body.stream) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(message));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const event = (type, data) =>
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
        );
      event("message_start", {
        message: {
          ...message,
          content: [],
          stop_reason: null,
          usage: { ...usage, output_tokens: 0 },
        },
      });
      content.forEach((block, index) => {
        const empty =
          block.type === "tool_use"
            ? { ...block, input: {} }
            : block.type === "thinking"
              ? { ...block, thinking: "", signature: "" }
              : { type: "text", text: "" };
        event("content_block_start", { index, content_block: empty });
        const delta =
          block.type === "tool_use"
            ? {
                type: "input_json_delta",
                partial_json: JSON.stringify(block.input),
              }
            : block.type === "thinking"
              ? { type: "thinking_delta", thinking: block.thinking }
              : { type: "text_delta", text: block.text };
        event("content_block_delta", { index, delta });
        if (block.type === "thinking")
          event("content_block_delta", {
            index,
            delta: { type: "signature_delta", signature: block.signature },
          });
        event("content_block_stop", { index });
      });
      event("message_delta", {
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: 10 },
      });
      event("message_stop", {});
      res.end();
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { type: "api_error", message: error.message },
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const mcp = sdk.createSdkMcpServer({
    name: "compat",
    version: "1.0.0",
    tools: [
      sdk.tool(
        "echo",
        "Test host MCP bridge",
        { value: z.string() },
        async ({ value }) => {
          mcpCalls.push(value);
          return { content: [{ type: "text", text: `MCP_${value}_OK` }] };
        },
      ),
    ],
  });
  const plugin = path.join(root, "plugin");
  await fs.mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
  await fs.mkdir(path.join(plugin, "skills", "compat-skill"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "compat-plugin", version: "1.0.0" }),
  );
  await fs.writeFile(
    path.join(plugin, "skills", "compat-skill", "SKILL.md"),
    "---\nname: compat-skill\ndescription: Isolated compatibility fixture\n---\nSKILL_FIXTURE_BODY",
  );
  await fs.mkdir(path.join(cwd, ".claude", "skills", "project-fixture"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(cwd, ".claude", "skills", "project-fixture", "SKILL.md"),
    "---\nname: project-fixture\ndescription: Project skill fixture\n---\nProject fixture.",
  );
  await fs.writeFile(path.join(cwd, "CLAUDE.md"), "CLAUDE_MD_FIXTURE_BODY");
  await fs.writeFile(
    path.join(cwd, ".claude", "settings.json"),
    JSON.stringify({
      env: { CINDY_SMOKE_PROJECT: "PROJECT_ENV_OK" },
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "printf NATIVE_HOOK_OK >> native-hooks.log",
              },
            ],
          },
        ],
      },
    }),
  );
  const options = {
    cwd,
    env: { ...process.env },
    pathToClaudeCodeExecutable: cli,
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    allowDangerouslySkipPermissions: true,
    tools: [
      "Write",
      "Read",
      "Edit",
      "Bash",
      "Agent",
      "Skill",
      "AskUserQuestion",
    ],
    includePartialMessages: true,
    enableFileCheckpointing: true,
    strictMcpConfig: true,
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    plugins: [{ type: "local", path: plugin }],
    mcpServers: { compat: mcp },
    agents: {
      "compat-worker": {
        description: "Isolated compatibility worker",
        prompt: "Return CHILD_OK for CHILD_COMPAT.",
        tools: [],
        model: "inherit",
      },
    },
    canUseTool: async (name, input) => {
      calls.push({ name, input });
      if (input.file_path === planFile)
        return { behavior: "deny", message: "Fixture plan write denied" };
      if (name === "AskUserQuestion")
        return {
          behavior: "allow",
          updatedInput: { ...input, answers: { "Fixture question?": "Yes" } },
        };
      return input.value === "DENY"
        ? { behavior: "deny", message: "Fixture denied" }
        : { behavior: "allow", updatedInput: input };
    },
    hooks: Object.fromEntries(
      ["PreToolUse", "PostToolUse", "Stop"].map((event) => [
        event,
        [
          {
            hooks: [
              async (input) => {
                hooks.push(input.hook_event_name);
                if (
                  event === "PreToolUse" &&
                  input.tool_input?.file_path === hookFile
                )
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: "Fixture hook denied",
                    },
                  };
                return {};
              },
            ],
          },
        ],
      ]),
    ),
  };
  const create = (extra = {}) => {
    const queue = [];
    let wake,
      ended = false;
    const prompt = {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!queue.length)
            await new Promise((resolve) => {
              wake = resolve;
            });
          while (queue.length) yield queue.shift();
        }
      },
    };
    const query = sdk.query({ prompt, options: { ...options, ...extra } });
    queries.add(query);
    const events = [];
    const reader = (async () => {
      for await (const message of query) {
        events.push(message);
        trace(
          "event",
          message.type,
          message.subtype ?? "",
          message.task_id ?? "",
          message.status ?? "",
        );
      }
    })();
    // Observe failures while a turn waits, avoiding an unhandled rejection.
    reader.catch(() => {});
    const send = async (value) => {
      const offset = events.length;
      const uuid = randomUUID();
      queue.push({
        type: "user",
        uuid,
        session_id: "",
        parent_tool_use_id: null,
        message: { role: "user", content: value },
      });
      wake?.();
      const result = await waitFor(
        () =>
          events
            .slice(offset)
            .find(
              (m) =>
                m.type === "result" &&
                (m.user_message_uuid === uuid ||
                  m.user_message_uuids?.includes(uuid)),
            ),
        reader,
      );
      return { result, messages: events.slice(offset), uuid };
    };
    const close = async () => {
      ended = true;
      wake?.();
      query.close();
      await reader.catch(() => {});
      queries.delete(query);
    };
    return { query, send, close, events, reader };
  };
  const passed = [];
  const check = (name) => {
    passed.push(name);
    console.log(`PASS ${name}`);
  };
  try {
    const s = create();
    const init = await s.query.initializationResult();
    assert.ok(init);
    assert.ok((await s.query.supportedModels()).length);
    assert.ok(
      (await s.query.supportedCommands()).some((c) =>
        c.name.includes("compat-skill"),
      ),
    );
    assert.ok(
      (await s.query.supportedCommands()).some((c) =>
        c.name.includes("project-fixture"),
      ),
    );
    assert.ok(
      (await s.query.supportedAgents()).some((a) => a.name === "compat-worker"),
    );
    check("initialization, models, plugin skills, agent discovery");
    const first = await s.send([
      { type: "text", text: "COMPAT_WORKFLOW" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=",
        },
      },
    ]);
    assert.equal(first.result.subtype, "success");
    assert.equal(first.result.result, "WORKFLOW_OK");
    assert.equal(await fs.readFile(file, "utf8"), "after\n");
    const serialized = JSON.stringify(first.messages);
    for (const marker of [
      "BASH_COMPAT_OK",
      "PROJECT_ENV_OK",
      "MCP_ALLOW_OK",
      "CHILD_OK",
      "Fixture denied",
      "Fixture reasoning",
    ])
      assert.ok(serialized.includes(marker), marker);
    assert.ok(calls.some((c) => c.name === "AskUserQuestion"));
    assert.ok(
      requests.some((r) =>
        JSON.stringify(r.body).includes("SKILL_FIXTURE_BODY"),
      ),
    );
    assert.ok(
      requests.some((r) =>
        JSON.stringify(r.body).includes("CLAUDE_MD_FIXTURE_BODY"),
      ),
    );
    assert.ok(
      requests.some((r) =>
        r.body.messages.some(
          (m) =>
            Array.isArray(m.content) &&
            m.content.some((b) => b.type === "image"),
        ),
      ),
    );
    assert.ok(
      (await fs.readFile(path.join(cwd, "native-hooks.log"), "utf8")).includes(
        "NATIVE_HOOK_OK",
      ),
    );
    assert.deepEqual(mcpCalls, ["ALLOW"]);
    assert.ok(
      calls.some(
        (c) => c.name === "mcp__compat__echo" && c.input.value === "DENY",
      ),
    );
    for (const event of ["PreToolUse", "PostToolUse", "Stop"])
      assert.ok(hooks.includes(event), event);
    assert.ok(first.messages.some((m) => m.type === "stream_event"));
    assert.ok(first.messages.some((m) => m.parent_tool_use_id));
    assert.ok(first.result.usage.input_tokens > 0);
    assert.ok(Object.keys(first.result.modelUsage).length);
    assert.ok(
      requests.every((r) =>
        r.userAgent?.includes(process.env.CLAUDE_CODE_ENTRYPOINT),
      ),
    );
    check(
      "Write/Edit/Read/Bash, permission allow/deny, SDK MCP, native/SDK hooks, subagent, Skill, AskUserQuestion, project env/CLAUDE.md, thinking/stream/usage, entrypoint",
    );
    assert.ok(
      (await s.query.mcpServerStatus()).some(
        (m) => m.name === "compat" && m.status === "connected",
      ),
    );
    await s.query.setPermissionMode("plan");
    await s.query.setPermissionMode("default");
    await s.query.setModel("claude-sonnet-4-6");
    await s.query.setMaxThinkingTokens(1024);
    await s.query.applyFlagSettings({ effortLevel: "high", fastMode: false });
    assert.ok(await s.query.getContextUsage({ detail: "summary" }));
    check(
      "live MCP status, plan/default mode, model/thinking/effort/fast controls, context usage",
    );
    const rewind = await s.query.rewindFiles(first.uuid, { dryRun: true });
    assert.equal(rewind.canRewind, true);
    assert.ok(rewind.filesChanged.some((p) => path.resolve(cwd, p) === file));
    await s.query.rewindFiles(first.uuid);
    assert.equal(
      await fs.stat(file).then(
        () => true,
        () => false,
      ),
      false,
    );
    check("checkpoint preview and file rewind");
    await s.query.setPermissionMode("plan");
    assert.equal((await s.send("COMPAT_PLAN")).result.subtype, "success");
    assert.ok(calls.some((c) => c.input.file_path === planFile));
    assert.equal(
      await fs.stat(planFile).then(
        () => true,
        () => false,
      ),
      false,
    );
    await s.query.setPermissionMode("bypassPermissions");
    const guarded = await s.send("COMPAT_HOOK_GUARD");
    assert.equal(guarded.result.subtype, "success");
    assert.ok(JSON.stringify(guarded.messages).includes("Fixture hook denied"));
    assert.equal(
      await fs.stat(hookFile).then(
        () => true,
        () => false,
      ),
      false,
    );
    await s.query.setPermissionMode("default");
    check(
      "plan writes require host approval; Full access retains host hook guards",
    );
    const bg = await s.send("COMPAT_BACKGROUND");
    assert.equal(bg.result.subtype, "success");
    const task = bg.messages.find(
      (m) =>
        m.type === "system" &&
        m.subtype === "task_started" &&
        m.task_type === "local_bash",
    );
    assert.ok(task?.task_id, "background shell task");
    await s.query.stopTask(task.task_id);
    await waitFor(
      () =>
        s.events.find(
          (m) =>
            m.subtype === "task_notification" &&
            m.task_id === task.task_id &&
            m.status === "stopped",
        ),
      s.reader,
    );
    check("background task lifecycle and stopTask");
    const cancelling = s.send("COMPAT_CANCEL");
    await cancelSeen;
    await s.query.interrupt();
    await cancelling;
    assert.equal((await s.send("COMPAT_CONTINUE")).result.subtype, "success");
    check("interrupt and subsequent turn");
    const sessionId = first.result.session_id;
    await s.close();
    const history = await sdk.getSessionMessages(sessionId, { dir: cwd });
    assert.ok(history.some((m) => JSON.stringify(m).includes("WORKFLOW_OK")));
    const resumed = create({ resume: sessionId });
    const resumeResult = (await resumed.send("COMPAT_RESUME")).result;
    assert.equal(resumeResult.subtype, "success");
    assert.equal(resumeResult.session_id, sessionId);
    await resumed.close();
    const { sessionId: forkId } = await sdk.forkSession(sessionId, {
      dir: cwd,
    });
    assert.notEqual(forkId, sessionId);
    const forked = create({ resume: forkId });
    const forkResult = (await forked.send("COMPAT_FORK")).result;
    assert.equal(forkResult.subtype, "success");
    assert.equal(forkResult.session_id, forkId);
    await forked.close();
    check("transcript read, persisted resume, fork and resumed fork");
    if (arg("--daemon-bundle")) {
      await smokeManager({
        bundle: path.resolve(arg("--daemon-bundle")),
        root,
        cwd,
      });
      check(
        "bundled remote manager RPC, inherited HOME/PATH, existing permission default and live controls",
      );
    }
    console.log(
      JSON.stringify({
        sdk: sdkVersion,
        cli: execFileSync(cli, ["--version"], {
          env: process.env,
          encoding: "utf8",
          windowsHide: true,
        }).trim(),
        entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
        checks: passed.length,
        modelRequests: requests.length,
      }),
    );
  } finally {
    for (const query of queries) query.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function smokeManager({ bundle, root, cwd }) {
  const socketPath =
    process.platform === "win32"
      ? `${String.fromCharCode(92).repeat(2)}.${String.fromCharCode(92)}pipe${String.fromCharCode(92)}cindy-cc-smoke-${randomUUID()}`
      : path.join(root, "manager.sock");
  const daemon = spawn(
    process.execPath,
    [bundle, "daemon", "--socket", socketPath],
    {
      env: { ...process.env },
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  daemon.stderr.on("data", (data) => {
    stderr += data;
  });
  const exited = once(daemon, "exit");
  const closedEarly = exited.then(() => {
    throw new Error(`Manager exited: ${stderr.slice(-2000)}`);
  });
  closedEarly.catch(() => {});
  let socket;
  try {
    await waitFor(() => stderr.includes("daemon ready"), closedEarly);
    socket = net.connect(socketPath);
    await once(socket, "connect");
    let input = "",
      id = 0;
    const responses = new Map(),
      events = [];
    socket.on("data", (data) => {
      input += data.toString();
      let newline;
      while ((newline = input.indexOf("\n")) >= 0) {
        const message = JSON.parse(input.slice(0, newline));
        input = input.slice(newline + 1);
        if (message.type === "response") responses.set(message.id, message);
        else if (
          message.type === "notification" &&
          message.method === "query/event"
        )
          events.push(message.params.message);
      }
    });
    const request = async (method, params) => {
      const key = ++id;
      socket.write(
        JSON.stringify({ type: "request", id: key, method, params }) + "\n",
      );
      const response = await waitFor(() => responses.get(key), closedEarly);
      responses.delete(key);
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      return response.result;
    };
    const hello = await request("protocol/hello", {
      protocolVersion: 5,
      clientId: "isolated-smoke",
    });
    assert.equal(hello.managerVersion, "0.0.11");
    const sessionId = randomUUID();
    await request("query/start", {
      sessionId,
      cwd,
      model: "claude-sonnet-4-6",
      tools: ["Bash"],
      allowedTools: ["Bash"],
      // Intentionally no OS env or permissionMode: the manager supplies them.
      env: {
        ANTHROPIC_API_KEY: "invalid-loopback-test-key",
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
        CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      },
      extraOptions: {
        pathToClaudeCodeExecutable: cli,
        settingSources: [],
        strictMcpConfig: true,
        includePartialMessages: true,
      },
    });
    await request("query/send", {
      sessionId,
      message: {
        type: "user",
        uuid: randomUUID(),
        session_id: "",
        parent_tool_use_id: null,
        message: { role: "user", content: "COMPAT_REMOTE" },
      },
    });
    const result = await waitFor(
      () => events.find((event) => event.type === "result"),
      closedEarly,
    );
    assert.equal(result.subtype, "success");
    assert.ok(JSON.stringify(events).includes("REMOTE_ENV_OK"));
    assert.equal(
      events.find(
        (event) => event.type === "system" && event.subtype === "init",
      ).permissionMode,
      "acceptEdits",
    );
    await request("query/setPermissionMode", { sessionId, mode: "plan" });
    await request("query/setPermissionMode", { sessionId, mode: "default" });
    await request("query/applyFlagSettings", {
      sessionId,
      settings: { effortLevel: "high" },
    });
    assert.ok(await request("query/getContextUsage", { sessionId }));
    await request("query/close", { sessionId });
  } finally {
    socket?.destroy();
    daemon.kill();
    await exited;
  }
}

async function waitFor(get, reader) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const value = get();
    if (value) return value;
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 25)),
      reader.then(() => {
        throw new Error("Query ended before expected event");
      }),
    ]);
  }
  throw new Error("Timed out waiting for SDK event");
}
