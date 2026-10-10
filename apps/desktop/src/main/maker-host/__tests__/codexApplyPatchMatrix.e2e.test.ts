import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';
import {
  AppServerHost,
  type ThreadSubscription,
} from '../../../../../../packages/maker-core/src/agents/codex/app-server/host.js';
import {
  Method,
  type ItemEnvelope,
  type ThreadStartResponse,
} from '../../../../../../packages/maker-core/src/agents/codex/app-server/protocol.js';
import { createStdioTransport } from '../../../../../../packages/maker-core/src/agents/codex/app-server/stdioTransport.js';

/**
 * Real-session guard for the pinned codex-package's apply_patch execution path
 * on Windows.
 *
 * The pinned codex binary resolves `apply_patch` to a generated `.bat` shim in
 * `$CODEX_HOME/tmp/arg0/...` whose `%*` forwarding mangles any payload with
 * embedded newlines, so every well-formed multi-line patch currently fails with
 * the signature below — while the direct `codex.exe --codex-run-as-apply-patch`
 * channel handles the identical payload fine (cindy#4990, openai/codex#13840).
 *
 * This suite drives the REAL session path (a fake Responses upstream that makes
 * the model run `apply_patch` through `exec_command`, exactly as the model is
 * instructed to), so a future codex-package pin bump that regresses this path
 * turns it red. Until the pin carries a fixed codex, cases that hit the known
 * signature skip with the reason instead of asserting a permanently red matrix;
 * the direct-invocation control case pins the working channel on every platform.
 *
 * NB on CODEX_HOME placement: codex refuses to install its PATH helper binaries
 * (the apply_patch shim) when CODEX_HOME lives under the system temp directory,
 * which would silently take the shim — and this whole failure mode — off the
 * board. The home directory is the supported location, unique per test run so
 * overlapping runs under one user cannot delete each other's live CODEX_HOME.
 */

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../../..');
const codexBinary =
  process.env.CODEX_E2E_BINARY ??
  path.join(
    repoRoot,
    'apps',
    'codex-package-bin',
    `${process.platform}-${process.arch}`,
    'bin',
    process.platform === 'win32' ? 'codex.exe' : 'codex',
  );
const codexBoundaryAvailable = existsSync(codexBinary);

// The upstream failure signature produced when the Windows .bat shim mangles a
// multi-line payload before codex can parse it (openai/codex#13840).
const WINDOWS_SHIM_MANGLE_SIGNATURE = "The last line of the patch must be '*** End Patch'";

// Pins verified to carry the upstream defect. The skip below is scoped to this
// list on purpose: a future pin that still mangles multi-line payloads is NOT
// here, so its cases assert instead of skipping and CI goes red — which is the
// entire point of the guard. When the pin moves past a fix the cases start
// asserting the success path; when a new pin is confirmed broken, add it here.
const KNOWN_BROKEN_CODEX_PINS = new Set(['0.156.0', '0.156.1']);

let cachedPinnedVersion: string | null | undefined;

/** The pinned binary's own version (`codex --version` → `codex-cli 0.156.0`). */
function pinnedCodexVersion(): string | null {
  if (cachedPinnedVersion !== undefined) return cachedPinnedVersion;
  try {
    const result = spawnSync(codexBinary, ['--version'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    cachedPinnedVersion = /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
  } catch {
    cachedPinnedVersion = null;
  }
  return cachedPinnedVersion;
}

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => logger,
};

function sse(events: unknown[]): string {
  return events
    .map((event) => {
      const type = (event as { type: string }).type;
      return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join('');
}

function responseCreated(id: string): unknown {
  return { type: 'response.created', response: { id } };
}

function responseCompleted(id: string): unknown {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface PatchMatrixCase {
  /** Short stable id used for the fixture path and test name. */
  name: string;
  /** Lines written into the created file (joined with \n, trailing newline kept). */
  fileLines: string[];
  /** When set, the patch itself is malformed and the tool output must report it. */
  invalidPatch?: string;
}

/**
 * Payload matrix chosen against the `.bat` `%*` forwarding failure modes:
 * embedded newlines (the reported defect), inline spaces/tabs, double quotes
 * (cmd tokenisation), and non-ASCII UTF-8 (codepage re-encoding).
 */
const PATCH_MATRIX: PatchMatrixCase[] = [
  { name: 'multiline', fileLines: ['first line', 'second line', 'third line'] },
  { name: 'inline-spaces', fileLines: ['she said   hello\tto the world', '  indented  '] },
  { name: 'double-quotes', fileLines: ['console.log("hello, world")', 'name = "cindy"'] },
  { name: 'non-ascii', fileLines: ['中文内容 🎉', 'naïve café — 完了'] },
  {
    name: 'invalid-patch',
    fileLines: [],
    invalidPatch: '*** Begin Patch\n*** Add File: invalid.txt\n+no terminator',
  },
];

function buildPatch(relativePath: string, fileLines: string[]): string {
  const body = fileLines.map((line) => `+${line}`).join('\n');
  return `*** Begin Patch\n*** Add File: ${relativePath}\n${body}\n*** End Patch`;
}

interface ApplyPatchCaseResult {
  toolOutputs: string[];
  fileContents: string | null;
  workingDir: string;
}

describe.skipIf(!codexBoundaryAvailable)('Codex apply_patch payload matrix E2E', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  /**
   * Drives one real codex app-server session whose fake upstream makes the model
   * run `apply_patch '<patch>'` through exec_command — the invocation shape the
   * codex prompt asks for, and the one that resolves to the Windows .bat shim.
   */
  async function runApplyPatchCase(testCase: PatchMatrixCase): Promise<ApplyPatchCaseResult> {
    const providerRequests: Array<Record<string, unknown>> = [];
    const relativePath = `matrix/${testCase.name}.txt`;
    const patch = testCase.invalidPatch ?? buildPatch(relativePath, testCase.fileLines);

    const provider = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      providerRequests.push(body);

      // Turn 1: the model runs the patch through the shell (single-quoted, so
      // the newlines ride inside the argument). Turn 2: it sees the tool output
      // and ends the turn.
      const turn = providerRequests.length;
      const responseBody =
        turn === 1
          ? sse([
              responseCreated('response-1'),
              {
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                  id: 'fc_exec_1',
                  type: 'function_call',
                  status: 'completed',
                  call_id: 'exec-call-1',
                  name: 'exec_command',
                  arguments: JSON.stringify({ cmd: `apply_patch '${patch}'` }),
                },
              },
              responseCompleted('response-1'),
            ])
          : sse([
              responseCreated('response-2'),
              {
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                  id: 'message-1',
                  type: 'message',
                  status: 'completed',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'done' }],
                },
              },
              responseCompleted('response-2'),
            ]);

      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      res.end(responseBody);
    });
    const providerUrl = await listen(provider);
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          provider.closeAllConnections();
          provider.close(() => resolve());
        }),
    );

    // Codex refuses to install its PATH helper binaries (the apply_patch shim
    // this suite exists to exercise) when CODEX_HOME sits under the system temp
    // directory, so the home lives under the user home — unique per run, so
    // overlapping local runs under the same user cannot delete each other's
    // live CODEX_HOME.
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'cindy-apply-patch-matrix-'));
    const caseHome = mkdtempSync(path.join(homedir(), '.cindy-codex-apply-patch-e2e-'));
    const codexHome = path.join(caseHome, 'codex-home');
    const workingDir = path.join(tempRoot, 'workdir');
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(workingDir, { recursive: true });
    writeFileSync(
      path.join(codexHome, 'config.toml'),
      `
model = "stealth/ox-alpha"
model_provider = "mock_provider"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.mock_provider]
name = "apply_patch matrix loopback fake Provider"
base_url = "${providerUrl}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`,
    );
    cleanups.push(async () => {
      // Async with retries: the codex child may still be releasing its sqlite
      // handles under CODEX_HOME when afterEach runs.
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      await rm(caseHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    });

    const host = new AppServerHost({
      createTransport: () =>
        createStdioTransport({
          binaryPath: codexBinary,
          cwd: workingDir,
          env: {
            ...process.env,
            CODEX_HOME: codexHome,
            OPENAI_API_KEY: 'test-key',
          },
        }),
      logger,
      clientInfo: { name: 'cindy-apply-patch-matrix-e2e', version: '0.0.0' },
    });
    let subscription: ThreadSubscription | undefined;
    cleanups.push(async () => {
      await host.shutdown();
      await subscription?.release();
    });

    const thread = await withTimeout(
      host.request<ThreadStartResponse>(
        Method.ThreadStart,
        {
          model: 'stealth/ox-alpha',
          modelProvider: 'mock_provider',
          cwd: workingDir,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
        },
        { timeoutMs: 60_000 },
      ),
      70_000,
      'thread/start',
    );

    let resolveTurnCompleted!: () => void;
    const turnCompleted = new Promise<void>((resolve) => {
      resolveTurnCompleted = resolve;
    });
    subscription = host.subscribeThread(thread.thread.id, {
      turnCompleted: () => resolveTurnCompleted(),
      itemStarted: () => {},
      itemCompleted: ({ item }: { item: ItemEnvelope }) => {
        void item;
      },
    });

    await withTimeout(
      host.request(
        Method.TurnStart,
        {
          threadId: thread.thread.id,
          input: [{ type: 'text', text: 'Create the requested file with apply_patch.' }],
        },
        { timeoutMs: 60_000 },
      ),
      70_000,
      'turn/start',
    );
    await withTimeout(turnCompleted, 90_000, 'turn/completed');

    const toolOutputs: string[] = [];
    for (const request of providerRequests) {
      const items = Array.isArray(request.input) ? request.input : [];
      for (const item of items) {
        const output = (item as { output?: unknown }).output;
        if (typeof output === 'string') toolOutputs.push(output);
      }
    }

    return {
      toolOutputs,
      fileContents: existsSync(path.join(workingDir, relativePath))
        ? readFileSync(path.join(workingDir, relativePath), 'utf8')
        : null,
      workingDir,
    };
  }

  for (const testCase of PATCH_MATRIX) {
    it(
      testCase.invalidPatch
        ? `reports the validation error for a malformed patch (${testCase.name})`
        : `creates the file byte-exact through a real session (${testCase.name})`,
      async (ctx) => {
        const result = await runApplyPatchCase(testCase);
        const joinedOutput = result.toolOutputs.join('\n');

        // Known upstream defect, scoped to the pins verified broken: the
        // generated apply_patch.bat shim mangles the payload before codex
        // parses it, so even a malformed patch surfaces with the same
        // signature. Skip the case (do not assert the red matrix) until the
        // pin ships a fixed codex; the direct-invocation control still pins
        // the working channel, and a fixed pin simply starts asserting the
        // success path. A pin NOT in the known-broken list that still shows
        // the signature falls through to the assertions and fails.
        const pinnedVersion = pinnedCodexVersion();
        if (
          process.platform === 'win32' &&
          pinnedVersion !== null &&
          KNOWN_BROKEN_CODEX_PINS.has(pinnedVersion) &&
          joinedOutput.includes(WINDOWS_SHIM_MANGLE_SIGNATURE)
        ) {
          ctx.skip();
          return;
        }

        if (testCase.invalidPatch) {
          expect(joinedOutput.toLowerCase()).toContain('invalid patch');
          // The malformed patch names `invalid.txt`: assert THAT path stays
          // absent, not the success fixture's path.
          expect(existsSync(path.join(result.workingDir, 'invalid.txt'))).toBe(false);
          expect(result.fileContents).toBeNull();
          return;
        }

        expect(result.fileContents).toBe(`${testCase.fileLines.join('\n')}\n`);
        expect(joinedOutput.toLowerCase()).toContain('success');
      },
      150_000,
    );
  }

  it('applies the same multi-line payload through a direct codex invocation (control)', async () => {
    // The issue's own control: bypassing the .bat shim and calling the pinned
    // binary directly must succeed with the identical payload, which pins the
    // shim (not the payload, the workspace, or the provider) as the defect.
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'cindy-apply-patch-control-'));
    const codexHome = path.join(tempRoot, 'codex-home');
    const workingDir = path.join(tempRoot, 'workdir');
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(workingDir, { recursive: true });
    cleanups.push(() =>
      rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
    );

    const relativePath = 'matrix/control.txt';
    const fileLines = ['control "quoted" line', '中文 🎉 second line'];
    const patch = buildPatch(relativePath, fileLines);

    const direct = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(codexBinary, ['--codex-run-as-apply-patch', patch], {
          cwd: workingDir,
          env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: 'test-key' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.stderr?.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      },
    );

    const directOutput = `${direct.stdout}\n${direct.stderr}`;
    // If the direct channel itself regresses, fail loudly: every channel is
    // broken and the matrix above cannot distinguish the shim from the payload.
    expect(directOutput).not.toContain(WINDOWS_SHIM_MANGLE_SIGNATURE);
    expect(direct.code).toBe(0);
    expect(readFileSync(path.join(workingDir, relativePath), 'utf8')).toBe(
      `${fileLines.join('\n')}\n`,
    );
  }, 90_000);
});
