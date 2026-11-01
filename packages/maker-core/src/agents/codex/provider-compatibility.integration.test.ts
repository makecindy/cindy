/**
 * Native regression for the 0.166 modelProviderMismatch input/resume guard.
 * Runs the production CodexAgent against a private home and a loopback Responses
 * server; no accounts or external model calls. Existing fake-host tests cannot
 * detect a process default disagreeing with thread/start. Integration tier.
 */
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { CodexAgent } from './index.js';
import type { AgentSessionHandle } from '../base-agent.js';
import type { AgentEvent } from '../../types/events.js';
import type { Logger } from '../../interfaces/logger.js';

const binaryPath = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger,
};

it.skipIf(!binaryPath)('keeps Cindy AI, subscription and custom routes usable across native resume and provider changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cindy-provider-native-'));
  const home = path.join(root, 'codex');
  const work = path.join(root, 'work');
  await Promise.all([mkdir(home), mkdir(work)]);
  const requests: Array<{ provider: string; body: string }> = [];
  let exerciseCompaction = false;
  let seedReported = false;
  let failedCompactions = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    // Both native compaction protocols: legacy endpoint and Responses v2 trigger.
    if (req.url?.endsWith('/responses/compact') || body.includes('"type":"compaction_trigger"')) {
      failedCompactions++;
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
        error: { message: 'HTTP 400 compact endpoint unavailable', code: 'bad_request' },
      }));
      return;
    }
    if (!req.url?.endsWith('/responses')) { res.writeHead(404).end('{}'); return; }
    const provider = req.url.split('/')[1];
    requests.push({ provider, body });
    const tokens = exerciseCompaction && !seedReported ? 5000 : 10;
    if (exerciseCompaction) seedReported = true;
    const item = { type: 'message', id: `msg-${requests.length}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: `ANSWER_FROM_${provider}`, annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    for (const event of [
      { type: 'response.created', response: { id: `r-${requests.length}`, status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `r-${requests.length}`, status: 'completed', output: [item],
        usage: { input_tokens: tokens, output_tokens: 5, total_tokens: tokens + 5 } } },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback address');
  const providers = ['cindy_gateway', 'cindy_codex', 'cindy_openai', 'cindy_custom_probe', 'cindy_summary'];
  const locations = new Map<string, string>();
  const agent = new CodexAgent({
    binaryPath: binaryPath!, logger, runtimeConfig: {}, isolateCodexAccountSessions: true,
    resolveModelContextLimit: () => exerciseCompaction ? 4096 : null,
    recordCodexThreadLocation: async (id, _home, rollout) => { if (rollout) locations.set(id, rollout); },
    prepareCodexResumeSession: async (id) => locations.get(id),
    prepareCodexExtraSpawnConfig: async () => ({
      extraArgs: [
        '-c', 'model_provider="cindy_gateway"',
        ...providers.flatMap((id) => ['-c', `model_providers.${id}={name="${['cindy_codex', 'cindy_openai'].includes(id) ? 'OpenAI' : 'Fixture'}",base_url="http://127.0.0.1:${address.port}/${id}/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,supports_websockets=false}`]),
        '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false',
        '-c', 'mcp_servers.cindy_memory={command="false",enabled=false}',
      ],
      extraEnv: {}, codexProxyActive: true, codexOpenAiWebSocketsEnabled: false,
      codexDefaultModelProviderId: 'cindy_gateway', codexRemoteCompactionProviderId: 'cindy_openai',
      codexCindyRemoteCompactionProviderId: 'cindy_codex', codexLocalCompactionProviderId: 'cindy_summary',
      codexCustomProviderRoutes: [{ providerId: 'custom-probe', modelProviderId: 'cindy_custom_probe',
        capabilities: {}, responseModels: ['custom-model'] }],
    }),
    auth: {
      getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }),
      logout: async () => {}, getAuthEnv: async () => ({
        HOME: root, USERPROFILE: root, CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '',
        NO_PROXY: '127.0.0.1,localhost',
      }),
    },
  });
  const handles = new Set<AgentSessionHandle>();
  const open = async (sessionId: string, providerId: string, model: string, resumeSessionId?: string) => {
    const handle = await agent.startSession({ sessionId, providerId, model, resumeSessionId,
      workingDir: work, permissionMode: 'bypassPermissions', makerMemoryEnabled: false });
    handles.add(handle);
    const events: AgentEvent[] = [];
    let nativeId = resumeSessionId;
    let complete: (() => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    void (async () => {
      for await (const event of handle.events()) {
        events.push(event);
        if (event.type === 'session_id') nativeId = String(event.data);
        if (event.type === 'done') complete?.();
        if (event.type === 'error' && (event.data as { isTerminal?: boolean }).isTerminal) fail?.(new Error(JSON.stringify(event.data)));
      }
    })();
    return {
      async send(text: string, expectedProvider: string, history?: string) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = new Promise<void>((resolve, reject) => {
          complete = resolve; fail = reject;
          // real-wait: native process failure deadline, cancelled on completion.
          timer = setTimeout(() => reject(new Error('Native provider turn timed out')), 15_000);
        });
        try {
          await Promise.all([done, handle.send({ type: 'user', content: text }, { throwOnStartFailure: true })]);
          const request = requests.findLast((entry) => entry.body.includes(text));
          expect(request?.provider).toBe(expectedProvider);
          if (history) expect(request?.body).toContain(history);
          expect(JSON.stringify(events)).toContain(`ANSWER_FROM_${expectedProvider}`);
          expect(nativeId).toBeTruthy();
          return nativeId!;
        } finally { clearTimeout(timer); }
      },
      async close() { await handle.close(); handles.delete(handle); },
    };
  };
  try {
    const cindy = await open('cindy', 'xd', 'codex/gpt-6.1-sol');
    const subscription = await open('subscription', 'openai', 'gpt-6.1-sol');
    const [original] = await Promise.all([
      cindy.send('HISTORY_CINDY_SENTINEL', 'cindy_codex'),
      subscription.send('SUBSCRIPTION_SENTINEL', 'cindy_openai'),
    ]);
    await cindy.close();
    await subscription.close();
    const resumed = await open('cindy', 'xd', 'codex/gpt-6.1-sol', original);
    expect(await resumed.send('RESUME_SENTINEL', 'cindy_codex', 'HISTORY_CINDY_SENTINEL')).toBe(original);
    await resumed.close();
    let previousId = original;
    for (const [provider, model, nativeProvider] of [
      ['openai', 'gpt-6.1-sol', 'cindy_openai'],
      ['xd', 'deepseek/deepseek-v4-pro', 'cindy_gateway'],
      ['custom-probe', 'custom-model', 'cindy_custom_probe'],
      ['xd', 'codex/gpt-6.1-sol', 'cindy_codex'],
    ]) {
      const sourcePath = locations.get(previousId)!;
      const source = await readFile(sourcePath, 'utf8');
      const next = await open('cindy', provider, model, previousId);
      const nextId = await next.send(`SWITCH_TO_${nativeProvider}`, nativeProvider, 'HISTORY_CINDY_SENTINEL');
      await next.close();
      if (nextId !== previousId) expect(await readFile(sourcePath, 'utf8')).toBe(source);
      previousId = nextId;
    }
    exerciseCompaction = true;
    const compacting = await open('compacting', 'xd', 'codex/gpt-6.1-sol');
    await compacting.send('COMPACTION_SEED', 'cindy_codex');
    const summaryId = await compacting.send('CONTINUE_AFTER_COMPACT', 'cindy_summary');
    expect(failedCompactions).toBeGreaterThan(0);
    await compacting.close();
    const restoredSummary = await open('compacting', 'xd', 'codex/gpt-6.1-sol', summaryId);
    expect(await restoredSummary.send('REOPEN_AFTER_COMPACT', 'cindy_summary')).toBe(summaryId);
    await restoredSummary.close();
  } finally {
    for (const handle of handles) await handle.close();
    await agent.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
