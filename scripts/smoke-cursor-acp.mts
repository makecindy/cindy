/** Opt-in account-backed smoke; never runs during CI/unit tests.
 * HOME must select the CLI's native authenticated profile. Credentials are not read here.
 * CINDY_CURSOR_TEST_BINARY=/absolute/agent node --import tsx scripts/smoke-cursor-acp.mts
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { CursorAgent, CURSOR_DEFAULT_MODEL } from '../packages/maker-core/src/agents/cursor/index.js';
import type { AgentSessionHandle } from '../packages/maker-core/src/agents/base-agent.js';
import type { AgentEvent, InteractionRequest } from '../packages/maker-core/src/types/events.js';
import type { Logger } from '../packages/maker-core/src/interfaces/logger.js';
import { createDesktopCursorAuthAdapter } from '../apps/desktop/src/main/maker-host/cursor-auth-adapter.js';

const binaryPath = process.env.CINDY_CURSOR_TEST_BINARY;
if (!binaryPath || !path.isAbsolute(binaryPath)) throw new Error('Set CINDY_CURSOR_TEST_BINARY to the official absolute Cursor CLI executable');
const auth = createDesktopCursorAuthAdapter(binaryPath);
if (!(await auth.getState()).authenticated) throw new Error('Cursor native login required; run agent login with the intended HOME first');
const checkpointPath = process.env.CINDY_CURSOR_SMOKE_STATE;
const selectedStage = process.env.CINDY_CURSOR_SMOKE_STAGE;
if (Boolean(selectedStage) !== Boolean(checkpointPath)) throw new Error('Checkpoint and stage must be provided together');
if (selectedStage && !['context', 'file', 'cancel'].includes(selectedStage)) throw new Error('Unknown smoke stage');
const checkpoint = checkpointPath ? JSON.parse(await readFile(checkpointPath, 'utf8')) : undefined;
if (checkpoint && (checkpoint.kind !== 'cindy-cursor-smoke-v1' || !path.basename(checkpoint.cwd).startsWith('cindy-cursor-live-') || !path.isAbsolute(checkpoint.cwd) || typeof checkpoint.sessionId !== 'string')) throw new Error('Invalid synthetic checkpoint');
const workingDir = checkpoint?.cwd ?? await mkdtemp(path.join(tmpdir(), 'cindy-cursor-live-'));
async function saveCheckpoint(values: Record<string, unknown>) {
  if (!checkpointPath || !checkpoint) return;
  Object.assign(checkpoint, values);
  await writeFile(checkpointPath, JSON.stringify(checkpoint), { mode: 0o600 });
}
// Bound native project discovery to this fixture, not the executor's ancestor .git.
execFileSync('git', ['init', '--quiet', workingDir], { stdio: 'ignore' });
const target = path.join(workingDir, 'probe.txt');
const noop = () => {};
const logger: Logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child() { return this; } };
let mcpUrl = '';
let mcpInitializations = 0;
let mcpToolLists = 0;
let bridgeLeases = 0;
const mcpToken = 'synthetic-smoke-only';
const mcpServer = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${mcpToken}`) { response.writeHead(401).end(); return; }
  if (request.method !== 'POST') { response.writeHead(405).end(); return; }
  let body = '';
  request.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 65_536) request.destroy(); });
  request.on('end', () => {
    try {
      const message = JSON.parse(body);
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      let result: unknown = {};
      if (message.method === 'initialize') {
        mcpInitializations++;
        result = { protocolVersion: message.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'cindy-smoke', version: '1.0.0' } };
      } else if (message.method === 'tools/list') { mcpToolLists++; result = { tools: [] }; }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch { response.writeHead(400).end(); }
  });
});
const agent = new CursorAgent({ binaryPath, auth, runtimeConfig: {}, logger,
  preparePiExtraSpawnConfig: async () => {
    if (!mcpUrl) return null;
    bridgeLeases++;
    return { mcpBridge: { token: mcpToken, servers: [{ name: 'cindy_smoke', url: mcpUrl }] }, disposeSessionCtx: () => { bridgeLeases--; } };
  },
});
let handle: AgentSessionHandle | undefined;
let pump: Promise<void> | undefined;
let permissionRequests = 0;
let permissionAllows = 0;
let current: { text: string; toolEvents: number; cancel?: boolean; cancelledSent: boolean;
  resolve(result: { text: string; toolEvents: number; stopReason: string }): void; reject(error: Error): void } | undefined;
const report = (stage: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ stage, ...data }));

function verifiedTarget(request: InteractionRequest): boolean {
  if (request.kind !== 'permission' || !['Edit', 'Write', 'Read'].includes(request.toolName)) return false;
  const paths: string[] = [];
  const collect = (value: unknown, key = '') => {
    if (typeof value === 'string' && /^(path|filePath|file_path|target_file|targetPath|absolutePath)$/i.test(key)) paths.push(value);
    else if (Array.isArray(value)) value.forEach(item => collect(item));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) collect(item, key);
  };
  collect(request.input);
  return paths.length > 0 && paths.every(value => path.resolve(workingDir, value) === target);
}
async function start(resumeSessionId?: string) {
  handle = await agent.startSession({ workingDir, model: CURSOR_DEFAULT_MODEL, permissionMode: 'ask', makerMemoryEnabled: false, resumeSessionId });
  handle.setInteractionResolver(async request => {
    if (request.kind === 'permission') {
      permissionRequests++;
      const allow = verifiedTarget(request);
      if (allow) permissionAllows++;
      report('permission', { allowed: allow });
      return { kind: 'permission', behavior: allow ? 'allow' : 'deny' };
    }
    if (request.kind === 'plan_review') return { kind: 'plan_review', behavior: 'deny', reason: 'Smoke test does not approve plans' };
    return { kind: 'ask_user_question', answers: {}, dismissed: true };
  });
  pump = (async () => {
    for await (const event of handle!.events()) consume(event);
  })();
  report(resumeSessionId ? 'loaded' : 'created', { nativeIdentityPresent: !!handle.id,
    modelOptions: agent.capabilities.availableModels.length, nativeModels: agent.capabilities.availableModels.filter(model => model.id !== CURSOR_DEFAULT_MODEL).length, imageInput: agent.capabilities.multimodal.image.supported });
}
function consume(event: AgentEvent) {
  if (!current) return;
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
  if (event.type === 'text' && typeof data.text === 'string') {
    current.text = (current.text + data.text).slice(0, 32_768);
    if (current.cancel && !current.cancelledSent) {
      current.cancelledSent = true;
      void handle!.abort().catch(error => current?.reject(error));
    }
  }
  if (event.type === 'tool_use' || event.type === 'tool_result_full') current.toolEvents++;
  if (event.type === 'error') current.reject(new Error(typeof data.message === 'string' ? data.message : 'Cursor error'));
  if (event.type === 'done') current.resolve({ text: current.text, toolEvents: current.toolEvents, stopReason: String(data.stopReason) });
}
async function turn(prompt: string, cancel = false) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const result = new Promise<{ text: string; toolEvents: number; stopReason: string }>((resolve, reject) => {
    current = { text: '', toolEvents: 0, cancel, cancelledSent: false, resolve, reject };
    timer = setTimeout(() => reject(new Error('Native smoke turn exceeded 90 seconds')), 90_000);
  });
  void result.catch(() => {});
  try {
    const sending = handle!.send({ type: 'user', content: prompt });
    if (cancel) cancelTimer = setTimeout(() => { if (current && !current.cancelledSent) { current.cancelledSent = true; void handle!.abort().catch(error => current?.reject(error)); } }, 1500);
    await sending;
    return await result;
  } finally { if (timer) clearTimeout(timer); if (cancelTimer) clearTimeout(cancelTimer); current = undefined; }
}
try {
  try {
    await new Promise<void>((resolve, reject) => { mcpServer.once('error', reject); mcpServer.listen(0, '127.0.0.1', resolve); });
    const address = mcpServer.address();
    assert.ok(address && typeof address === 'object');
    mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
    report('http-mcp', { skipped: 'local_port_binding_denied' });
  }
  if (selectedStage && checkpoint) {
    await saveCheckpoint({ activeStage: selectedStage });
    await start(checkpoint.sessionId);
    if (selectedStage === 'context') {
      const resumed = await turn('What codeword did I give you earlier in this task? Reply only with that word. Do not use tools.');
      assert.ok(resumed.text.includes('PEBBLE'), 'Persisted codeword not retained');
      await saveCheckpoint({ multiTurn: true, load: true, activeStage: null });
      report('persistent-multi-turn', { passed: true });
    } else if (selectedStage === 'file') {
      const file = await turn('Using a file-edit tool, create probe.txt in the current working directory containing exactly cindy-cursor-smoke. Do not execute shell commands, use the network, or modify any other file.');
      assert.equal((await readFile(target, 'utf8')).trim(), 'cindy-cursor-smoke');
      await saveCheckpoint({ file: true, activeStage: null, permissionRequests, permissionAllows });
      report('file-tool', { passed: true, toolEvents: file.toolEvents, permissionRequests, permissionAllows });
    } else {
      const stopped = await turn('Write the numbers 1 through 500, one number per line. Do not use tools.', true);
      assert.equal(stopped.stopReason, 'cancelled', 'Native cancellation not confirmed');
      await saveCheckpoint({ cancel: true, activeStage: null });
      report('cancel', { confirmed: true });
    }
  } else {
    await start();
    const first = await turn('Remember the codeword PEBBLE for this task. Reply only ACK. Do not use tools.');
    assert.ok(/ACK/i.test(first.text), 'Unexpected first reply');
    report('first-turn', { passed: true });
    const second = await turn('What codeword did I give you? Reply only with that word. Do not use tools.');
    assert.ok(second.text.includes('PEBBLE'), 'Multi-turn codeword not retained');
    report('multi-turn', { passed: true });
    const file = await turn('Using a file-edit tool, create probe.txt in the current working directory containing exactly cindy-cursor-smoke. Do not execute shell commands, use the network, or modify any other file.');
    assert.ok((await readFile(target, 'utf8')).trim() === 'cindy-cursor-smoke', 'Scratch file contents mismatch');
    report('file-tool', { passed: true, toolEvents: file.toolEvents, permissionRequests, permissionAllows });
    const nativeId = handle!.id;
    await handle!.close(); await pump;
    await start(nativeId);
    const resumed = await turn('What codeword did I give you earlier in this task? Reply only with that word. Do not use tools.');
    assert.ok(resumed.text.includes('PEBBLE'), 'Persisted codeword not retained');
    report('persistent-load', { passed: true });
    const stopped = await turn('Write the numbers 1 through 500, one number per line. Do not use tools.', true);
    report('cancel', { confirmed: stopped.stopReason === 'cancelled', stopReason: stopped.stopReason });
    assert.equal(stopped.stopReason, 'cancelled', 'Native completion raced cancellation; cancellation is not confirmed');
  }
  if (mcpUrl) {
    assert.ok(mcpInitializations > 0 && mcpToolLists > 0, 'Native HTTP MCP handshake was not observed');
    report('http-mcp', { passed: true, initializations: mcpInitializations, toolLists: mcpToolLists });
  }
  report('complete', { passed: true });
} catch (error) {
  report('failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
  throw new Error('Cursor native smoke failed; no model/account response content was logged');
} finally {
  await handle?.close(); await pump;
  await agent.dispose();
  assert.equal(bridgeLeases, 0, 'MCP bridge lease was not released');
  await new Promise<void>(resolve => mcpServer.close(() => resolve()));
  // Do not remove the cwd if closing the native process failed.
  if (!checkpoint) await rm(workingDir, { recursive: true, force: true });
}
