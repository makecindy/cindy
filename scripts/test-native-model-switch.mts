/**
 * Real Codex regression, local fake provider, isolated homes, no Desktop or real credentials.
 * pnpm exec tsx scripts/test-native-model-switch.mts /absolute/path/to/codex
 * Fails rather than silently skipping when the binary or native protocol is unavailable.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants, promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { assertCodexRolloutRewriteSupported } from '../packages/maker-core/src/agents/codex/rollout-sanitize.ts';
import { buildHandoffText } from '../apps/desktop/src/main/maker-ipc/agentHandoff.ts';

const binary = process.argv[2];
assert(
  binary && path.isAbsolute(binary),
  'Provide an absolute Codex binary path',
);
await fs.access(binary, constants.X_OK);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-native-switch-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
await fs.mkdir(home);
await fs.mkdir(work);
const requests: any[] = [];
const server = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body));
  const item = {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      { type: 'output_text', text: 'fixture complete', annotations: [] },
    ],
  };
  const result = {
    id: 'resp_fixture',
    object: 'response',
    status: 'completed',
    output: [item],
    usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 },
  };
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [
    {
      type: 'response.created',
      response: { ...result, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: 'fixture complete',
    },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: result },
  ])
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
await fs.writeFile(
  path.join(home, 'config.toml'),
  `model = "fixture-model"
model_provider = "route_a"
approval_policy = "never"
sandbox_mode = "read-only"
${['route_a', 'route_b']
  .map(
    (provider) => `[model_providers.${provider}]
name = "Local fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false`,
  )
  .join('\n')}
`,
);

let processHandle: ReturnType<typeof spawn> | undefined;
let sequence = 0;
let notifications: any[] = [];
let stderr = '';
const pending = new Map<
  number,
  {
    resolve(value: any): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function call(method: string, params: unknown): Promise<any> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 20_000);
    pending.set(id, { resolve, reject, timer });
    processHandle!.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
async function start() {
  notifications = [];
  processHandle = spawn(binary, ['app-server'], {
    cwd: work,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: home,
      TMPDIR: root,
      XDG_CONFIG_HOME: home,
      RUST_LOG: 'warn',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  processHandle.on('error', (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  });
  processHandle.stderr!.on('data', (data) => {
    stderr += data;
  });
  createInterface({ input: processHandle.stdout! }).on('line', (line) => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) {
      notifications.push(message);
      return;
    }
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  await call('initialize', {
    clientInfo: { name: 'cindy_native_switch_test', version: '1.0' },
    capabilities: { experimentalApi: true },
  });
  processHandle.stdin!.write(JSON.stringify({ method: 'initialized' }) + '\n');
}
async function stop() {
  if (!processHandle) return;
  const child = processHandle;
  processHandle = undefined;
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = once(child, 'exit');
  child.stdin!.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
async function send(threadId: string, text: string) {
  notifications = [];
  await call('turn/start', { threadId, input: [{ type: 'text', text }] });
  const deadline = Date.now() + 20_000;
  while (
    Date.now() < deadline &&
    !notifications.some((event) => event.method === 'turn/completed')
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const done = notifications.find((event) => event.method === 'turn/completed');
  assert.equal(
    done?.params?.turn?.status,
    'completed',
    'native turn must complete',
  );
}
async function findRollout(
  threadId: string,
  dir = path.join(home, 'sessions'),
): Promise<string> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findRollout(threadId, file).catch(() => null);
      if (nested) return nested;
    } else if (entry.name.includes(threadId) && entry.name.endsWith('.jsonl'))
      return file;
  }
  throw new Error(`No rollout for ${threadId}`);
}

try {
  await start();
  const first = await call('thread/start', {
    model: 'fixture-model',
    modelProvider: 'route_a',
    cwd: work,
    approvalPolicy: 'never',
    sandbox: 'read-only',
  });
  const sourceId = first.thread.id;
  await send(
    sourceId,
    'Remember CINDY_SWITCH_CONTEXT_MARKER. The completed operation must not repeat.',
  );
  await call('thread/unsubscribe', { threadId: sourceId });
  await stop();
  const sourcePath = await findRollout(sourceId);
  const original = await fs.readFile(sourcePath);
  await assert.rejects(assertCodexRolloutRewriteSupported(sourcePath), {
    code: 'CODEX_HISTORY_RECOVERY_REQUIRED',
  });
  assert.deepEqual(await fs.readFile(sourcePath), original);

  const transcript = [
    {
      role: 'user',
      content:
        'Remember CINDY_SWITCH_CONTEXT_MARKER. The completed operation must not repeat.',
      createdAt: 1,
    },
    { role: 'assistant', content: 'fixture complete', createdAt: 2 },
  ];
  for (const [step, provider] of ['route_b', 'route_a', 'route_b'].entries()) {
    const handoff = buildHandoffText(transcript, {
      fromLabel: 'Codex',
      toLabel: 'Codex',
      sessionId: 'fixture-cindy-task',
      reason: 'native-session-recovery',
    });
    // The durable boundary is read back after a process restart before use.
    const boundary = path.join(root, 'boundary.json');
    await fs.writeFile(boundary, JSON.stringify({ handoff, provider }));
    await start();
    const saved = JSON.parse(await fs.readFile(boundary, 'utf8'));
    const fresh = await call('thread/start', {
      model: 'fixture-model',
      modelProvider: saved.provider,
      cwd: work,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
    const nextUserMessage = `Continue without repeating completed work. CINDY_ROUTE_${step}`;
    await send(fresh.thread.id, `${saved.handoff}\n${nextUserMessage}`);
    if (step > 0)
      assert(
        JSON.stringify(requests.at(-1).input).includes(
          `CINDY_RESUME_${step - 1}`,
        ),
      );
    transcript.push(
      {
        role: 'user',
        content: nextUserMessage,
        createdAt: transcript.length + 1,
      },
      {
        role: 'assistant',
        content: 'fixture complete',
        createdAt: transcript.length + 2,
      },
    );
    assert(
      JSON.stringify(requests.at(-1).input).includes(
        'CINDY_SWITCH_CONTEXT_MARKER',
      ),
    );
    await call('thread/unsubscribe', { threadId: fresh.thread.id });
    await stop();
    // A restored target must still support native fork, the path missed by unit tests.
    await start();
    const forked = await call('thread/fork', {
      threadId: fresh.thread.id,
      persistExtendedHistory: true,
      excludeTurns: true,
    });
    const forkPath = await findRollout(forked.thread.id);
    const before = await fs.readFile(forkPath);
    await assert.rejects(assertCodexRolloutRewriteSupported(forkPath), {
      code: 'CODEX_HISTORY_RECOVERY_REQUIRED',
    });
    assert.deepEqual(await fs.readFile(forkPath), before);
    const secondFork = await call('thread/fork', {
      threadId: forked.thread.id,
      persistExtendedHistory: true,
      excludeTurns: true,
    });
    await call('thread/unsubscribe', { threadId: secondFork.thread.id });
    await stop();
    await start();
    await call('thread/resume', {
      threadId: secondFork.thread.id,
      model: 'fixture-model',
      modelProvider: provider,
      cwd: work,
      excludeTurns: true,
    });
    const resumedUserMessage = `Continue after restarting. CINDY_RESUME_${step}`;
    await send(secondFork.thread.id, resumedUserMessage);
    assert(
      JSON.stringify(requests.at(-1).input).includes(`CINDY_ROUTE_${step}`),
    );
    transcript.push(
      {
        role: 'user',
        content: resumedUserMessage,
        createdAt: transcript.length + 1,
      },
      {
        role: 'assistant',
        content: 'fixture complete',
        createdAt: transcript.length + 2,
      },
    );
    assert(
      JSON.stringify(requests.at(-1).input).includes(
        'CINDY_SWITCH_CONTEXT_MARKER',
      ),
    );
    await stop();
    assert.deepEqual(await fs.readFile(sourcePath), original);
  }
  assert(
    !stderr.includes('expected ordinal'),
    'native history index must remain valid',
  );
  assert.equal(
    requests.length,
    7,
    'one seed plus two requested turns per route; no automatic replay',
  );
  console.log(
    'PASS: A → B → A → B; handoff, restart, repeated native fork, source preservation, no replay',
  );
} finally {
  await stop();
  server.close();
  for (const request of pending.values()) clearTimeout(request.timer);
  await fs.rm(root, { recursive: true, force: true });
}
