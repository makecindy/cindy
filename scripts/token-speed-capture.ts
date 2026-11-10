// Records a real Claude Code or Codex turn exactly as the app receives it (Agent
// SDK messages or app-server notifications, with arrival times), for
// scripts/token-speed-replay.ts. It spends real tokens on your own Claude or
// ChatGPT account; one turn is enough.
//
// Claude:  pnpm exec tsx scripts/token-speed-capture.ts --out turn.jsonl [--model <id>]
//            [--effort <level>] [--thinking summarized|default] [--claude <path to claude>] "<prompt>"
// Codex:   pnpm exec tsx scripts/token-speed-capture.ts --codex <path to codex> --out turn.jsonl
//            [--model <id>] [--effort <level>] "<prompt>"
// Compact: pnpm exec tsx scripts/token-speed-capture.ts --compact turn.jsonl fixture.json "<note>"
//
// A recording holds everything the model wrote, so keep it out of the repository.
// The compact form holds only timing and sizes and can be committed as a fixture.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  compactRecordedStream,
  type TimedSdkMessage,
} from '../packages/maker-core/src/agents/claude-code/recorded-stream-fixture.js';
import {
  compactCodexStream,
  type TimedCodexNotification,
} from '../packages/maker-core/src/agents/codex/recorded-stream-fixture.js';

const DEFAULT_PROMPT =
  'Think it through first, then write a small LRU cache with expiry in TypeScript to lru.ts, ' +
  'read it back, fix any edge case you find, and explain the trade-offs in a few bullet points.';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const [, value] = args.splice(index, 2);
  return value;
}

async function record(args: string[]): Promise<void> {
  const out = option(args, '--out');
  if (!out) throw new Error('--out <file.jsonl> is required');
  const model = option(args, '--model');
  const effort = option(args, '--effort');
  const thinking = option(args, '--thinking') ?? 'summarized';
  const claude = option(args, '--claude') ?? process.env.CLAUDE_CODE_EXECPATH;
  const prompt = args[0] ?? DEFAULT_PROMPT;
  // A session started from inside Claude Code must not inherit its parent's wiring.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AUTOCOMPACT|CLAUDE_ENABLE_STREAM|CLAUDE_STREAM_IDLE)/.test(key)));
  const require = createRequire(new URL('../packages/maker-core/package.json', import.meta.url));
  const sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href) as {
    query(input: { prompt: string; options: Record<string, unknown> }): AsyncIterable<unknown>;
  };
  // The turn works in an empty scratch folder and can only read and write files there.
  const cwd = mkdtempSync(join(tmpdir(), 'cindy-token-speed-'));
  const file = createWriteStream(out);
  const startedAt = Date.now();
  let messages = 0;
  const stream = sdk.query({
    prompt,
    options: {
      cwd,
      env,
      includePartialMessages: true,
      permissionMode: 'acceptEdits',
      allowedTools: ['Read', 'Write', 'Edit', 'Glob'],
      settingSources: [],
      mcpServers: {},
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(claude ? { pathToClaudeCodeExecutable: claude } : {}),
      // The same display the app asks for when it shows thinking.
      ...(thinking === 'summarized' ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
    },
  });
  for await (const msg of stream) {
    file.write(`${JSON.stringify({ t: Date.now() - startedAt, msg })}\n`);
    messages += 1;
  }
  await new Promise<void>((resolve) => file.end(resolve));
  console.log(`${messages} messages over ${((Date.now() - startedAt) / 1_000).toFixed(1)}s -> ${out}`);
}

/** A read-only Codex turn over its app-server, in an empty scratch folder. */
async function recordCodex(codex: string, args: string[]): Promise<void> {
  const out = option(args, '--out');
  if (!out) throw new Error('--out <file.jsonl> is required');
  const model = option(args, '--model');
  const effort = option(args, '--effort');
  const prompt = args[0] ?? DEFAULT_PROMPT;
  const cwd = mkdtempSync(join(tmpdir(), 'cindy-token-speed-'));
  const child = spawn(codex, ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  const file = createWriteStream(out);
  const startedAt = Date.now();
  let messages = 0;
  let nextId = 1;
  const pending = new Map<number, (result: Record<string, unknown>) => void>();
  const send = (message: Record<string, unknown>): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };
  const call = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      pending.set(nextId, resolve);
      send({ id: nextId++, method, params });
    });
  const finished = new Promise<void>((resolve) => {
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: { id?: number; method?: string; result?: Record<string, unknown>; error?: unknown };
      try { msg = JSON.parse(line) as typeof msg; } catch { return; }
      file.write(`${JSON.stringify({ t: Date.now() - startedAt, msg })}\n`);
      messages += 1;
      if (msg.id !== undefined && msg.method === undefined) {
        if (msg.error) throw new Error(JSON.stringify(msg.error));
        pending.get(msg.id)?.(msg.result ?? {});
      } else if (msg.id !== undefined) {
        // The turn only reads: anything that asks for approval is declined.
        send({ id: msg.id, result: { decision: 'denied' } });
      } else if (msg.method === 'turn/completed' || msg.method === 'error') {
        resolve();
      }
    });
    child.on('close', () => resolve());
  });
  await call('initialize', {
    clientInfo: { name: 'cindy-token-speed-capture', title: 'Cindy token speed capture', version: '0.0.0' },
    capabilities: { experimentalApi: true },
  });
  send({ method: 'initialized' });
  const started = await call('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only', ...(model ? { model } : {}) });
  const threadId = (started.thread as { id?: string } | undefined)?.id;
  await call('turn/start', { threadId, input: [{ type: 'text', text: prompt }], summary: 'auto', ...(effort ? { effort } : {}) });
  await finished;
  await new Promise<void>((resolve) => file.end(resolve));
  child.kill();
  console.log(`${messages} messages over ${((Date.now() - startedAt) / 1_000).toFixed(1)}s -> ${out}`);
}

function compact(args: string[]): void {
  const [source, target, note] = args;
  if (!source || !target || !note) throw new Error('--compact <capture.jsonl> <fixture.json> "<note>"');
  const lines = readFileSync(source, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as TimedSdkMessage & TimedCodexNotification & { msg: { result?: { model?: string } } });
  const codexModel = lines.find((line) => line.msg.result?.model)?.msg.result?.model;
  const stream = lines.some((line) => typeof line.msg.method === 'string')
    ? compactCodexStream(lines, codexModel ?? 'codex', note)
    : compactRecordedStream(lines, note);
  const events = stream.events.map((event) => JSON.stringify(event)).join(',\n');
  writeFileSync(target, `{\n  "format": ${JSON.stringify(stream.format)},\n  "model": ${JSON.stringify(stream.model)},\n` +
    `  "note": ${JSON.stringify(stream.note)},\n  "events": [\n${events}\n  ]\n}\n`);
  console.log(`${stream.events.length} events -> ${target}`);
}

const args = process.argv.slice(2);
const codex = option(args, '--codex');
const run = args[0] === '--compact' ? Promise.resolve(compact(args.slice(1)))
  : codex ? recordCodex(codex, args) : record(args);
run.catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
