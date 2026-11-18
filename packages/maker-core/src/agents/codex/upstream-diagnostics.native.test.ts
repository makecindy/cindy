/** #11032 opt-in integration: real CodexAgent + native binary + loopback model.
 * Unlike unit fixtures this verifies native's structured 502 reaches the 120s
 * watchdog. Real retry timing belongs in this opt-in tier, not default unit.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { CodexAgent } from './index.js';
import type { AgentEvent } from '../../types/events.js';
import type { Logger } from '../../interfaces/logger.js';

const binaryPath = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };

it.skipIf(!binaryPath)('retains native upstream 502 through watchdog and accepts the next normal turn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cindy-upstream-diagnostics-'));
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  await mkdir(home);
  await mkdir(work);
  let fail = false;
  let requests = 0;
  const delays = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain without retaining user content. */ }
    requests += 1;
    if (fail) {
      // real-wait: Match the proven 4s upstream failure cadence with unmodified native retries.
      const timer = setTimeout(() => {
        delays.delete(timer);
        if (!res.destroyed) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({
          error: { message: 'upstream EOF PRIVATE_RESPONSE https://private.invalid/?token=synthetic-secret' },
        }));
      }, 4000);
      delays.add(timer);
      return;
    }
    const id = `reply-${requests}`;
    const item = { type: 'message', role: 'assistant', id, content: [{ type: 'output_text', text: 'Normal answer.' }] };
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } } },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  let agent: CodexAgent | undefined;
  let handle: Awaited<ReturnType<CodexAgent['startSession']>> | undefined;
  let consumed: Promise<void> | undefined;
  const seen: AgentEvent[] = [];
  const waiters = new Set<() => void>();
  const until = (predicate: () => boolean, timeoutMs: number) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error('Expected native event not received')); }, timeoutMs);
    const check = () => { if (predicate()) { clearTimeout(timer); waiters.delete(check); resolve(); } };
    waiters.add(check);
    check();
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    await writeFile(path.join(home, 'config.toml'), `check_for_update_on_startup=false\n[analytics]\nenabled=false\n`);
    agent = new CodexAgent({ binaryPath: binaryPath!, logger, runtimeConfig: {},
      auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {},
        getAuthEnv: async () => ({ HOME: home, USERPROFILE: home, CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '', XDT_CODEX_API_KEY: '',
          HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }),
      },
      prepareCodexExtraSpawnConfig: async () => ({ defaultModelProviderId: 'fixture', extraEnv: {}, extraArgs: [
        '-c', 'model_provider="fixture"', '-c', 'model_providers.fixture.name="Fixture"',
        '-c', `model_providers.fixture.base_url="http://127.0.0.1:${address.port}/v1"`,
        '-c', 'model_providers.fixture.wire_api="responses"', '-c', 'model_providers.fixture.requires_openai_auth=false',
        '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false',
      ] }),
    });
    handle = await agent.startSession({ sessionId: 'upstream-diagnostics', model: 'gpt-6.1-sol', workingDir: work });
    consumed = (async () => { for await (const e of handle!.events()) { seen.push(e); for (const check of waiters) check(); } })();
    const doneCount = () => seen.filter(e => e.type === 'done').length;
    await handle.send({ type: 'user', content: 'Answer without tools.' });
    await until(() => doneCount() === 1, 15_000);
    fail = true;
    await handle.send({ type: 'user', content: 'Answer again without tools.' });
    await until(() => seen.some(e => e.type === 'error' && (e.data as { reason?: string }).reason === 'codex_reconnect_stalled'), 175_000);
    const errors = seen.filter(e => e.type === 'error');
    expect(errors).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ errorStatus: 502, isTerminal: false, willRetry: true }) }));
    expect(errors).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ errorStatus: 502, reason: 'codex_reconnect_stalled', isTerminal: true, idleMs: 120_000 }) }));
    expect(JSON.stringify(errors)).not.toMatch(/PRIVATE_RESPONSE|private.invalid|synthetic-secret/);
    expect(handle.isTurnRunning?.()).toBe(false);
    fail = false;
    const priorDone = doneCount();
    await handle.send({ type: 'user', content: 'One last normal answer.' });
    await until(() => doneCount() > priorDone, 15_000);
    expect((seen.findLast(e => e.type === 'done')!.data as { result?: string }).result).toContain('Normal answer.');
  } finally {
    await handle?.close();
    await agent?.dispose();
    await consumed;
    for (const timer of delays) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 210_000);
