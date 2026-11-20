/**
 * Regression: API-key models omitted native Ultra/Fast capabilities.
 * Production entry: CodexAgent.refreshLocalModels + startSession; asserts both
 * discovery and the emitted Responses request, beyond mocked protocol coverage.
 * Minimal input: Sol/Terra, Ultra, Fast, private HOME and loopback Responses.
 * Integration tier: real child process/socket; no accounts or paid inference.
 * Standalone duration: 1.31s with Codex 0.166.0 (2026-11-06).
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { CodexAgent } from './index.js';
import type { CodexModelListItem } from './app-server/protocol.js';
import type { Logger } from '../../interfaces/logger.js';

const binaryPath = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger,
};

it.skipIf(!binaryPath).each([
  { modelId: 'gpt-6.1-sol', expectedEffort: 'xhigh' },
  { modelId: 'gpt-5.6-terra', expectedEffort: 'max' },
  { modelId: 'gpt-6.1-terra', expectedEffort: 'xhigh' },
])('discovers and routes Ultra/Fast for $modelId on the API route', async ({ modelId, expectedEffort }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cindy-api-capabilities-'));
  const home = path.join(root, 'codex');
  const work = path.join(root, 'work');
  await Promise.all([mkdir(home), mkdir(work)]);
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    if (!req.url?.endsWith('/responses')) { res.writeHead(404).end('{}'); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const item = { type: 'message', id: 'msg-api-capabilities', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'API_CAPABILITIES_OK', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    for (const event of [
      { type: 'response.created', response: { id: 'r-api', status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'r-api', status: 'completed', output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback address');
  let publishedOAuth = false;
  const agent = new CodexAgent({
    binaryPath: binaryPath!, logger, runtimeConfig: {},
    resolveCodexLocalAuthPolicy: () => 'isolated',
    onCodexLocalModelsListed: () => { publishedOAuth = true; },
    prepareCodexExtraSpawnConfig: async () => ({
      extraArgs: [
        '-c', 'model_provider="cindy_custom_probe"',
        '-c', `model_providers.cindy_custom_probe={name="OpenAI",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false,env_key="CINDY_TEST_KEY",request_max_retries=0,supports_websockets=false}`,
        '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false',
        '-c', 'mcp_servers.cindy_memory={command="false",enabled=false}',
      ],
      extraEnv: { CINDY_TEST_KEY: 'fixture-only' },
      codexProxyActive: true, codexOpenAiWebSocketsEnabled: false,
      codexDefaultModelProviderId: 'cindy_custom_probe',
      codexCustomProviderRoutes: [{ providerId: 'openai-api', modelProviderId: 'cindy_custom_probe',
        capabilities: {}, responseModels: [modelId] }],
    }),
    auth: {
      getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }),
      logout: async () => {}, getAuthEnv: async () => ({
        HOME: root, USERPROFILE: root, CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '',
        NO_PROXY: '127.0.0.1,localhost',
      }),
    },
  });
  let handle: Awaited<ReturnType<typeof agent.startSession>> | undefined;
  try {
    let models: readonly CodexModelListItem[] = [];
    expect(await agent.refreshLocalModels({ credentialMode: 'provider-oauth',
      onModelsListed: result => { models = result; } })).toBe(true);
    const discovered = models.find(model => model.model === modelId);
    expect(discovered?.supportedReasoningEfforts?.map(item => item.reasoningEffort)).toContain('ultra');
    expect(discovered?.additionalSpeedTiers).toContain('fast');
    expect(publishedOAuth).toBe(false);
    expect(requests).toHaveLength(0);

    handle = await agent.startSession({ sessionId: 'api-ultra-fast', providerId: 'openai-api',
      model: modelId, effort: 'ultra',
      fastMode: true, workingDir: work, permissionMode: 'bypassPermissions', makerMemoryEnabled: false });
    let complete: (() => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const events: string[] = [];
    const consume = (async () => {
      for await (const event of handle!.events()) {
        events.push(JSON.stringify(event));
        if (event.type === 'done') { complete?.(); break; }
        if (event.type === 'error' && (event.data as { isTerminal?: boolean }).isTerminal) {
          fail?.(new Error(JSON.stringify(event.data))); break;
        }
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<void>((resolve, reject) => {
      complete = resolve; fail = reject;
      // real-wait: cancelled deadline for a native process / loopback failure.
      timer = setTimeout(() => reject(new Error('Native Ultra/Fast turn timed out')), 15_000);
    });
    try {
      await Promise.all([done, handle.send({ type: 'user', content: 'Reply OK' }, { throwOnStartFailure: true })]);
      await consume;
      expect(requests).toHaveLength(1);
      expect(handle.getEffort?.()).toBe('ultra');
      // Native Ultra activates proactive delegation and resolves its HTTP effort
      // through the model's multi_agent_reasoning_effort.
      // https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/protocol/src/openai_models/reasoning_effort.rs
      expect(JSON.stringify(requests[0]!.input)).toContain('Proactive multi-agent delegation is active.');
      expect(JSON.stringify(requests[0]!.input)).not.toContain('Any earlier instruction enabling proactive multi-agent delegation');
      expect(requests[0]).toMatchObject({ model: modelId, reasoning: { effort: expectedEffort }, service_tier: 'priority' });
      expect(events.join('')).toContain('API_CAPABILITIES_OK');
      console.info('CODEX_API_CAPABILITIES', JSON.stringify({ model: discovered?.model,
        selectedEffort: handle.getEffort?.(), nativeProactiveDelegation: true,
        efforts: discovered?.supportedReasoningEfforts?.map(item => item.reasoningEffort),
        speedTiers: discovered?.additionalSpeedTiers,
        request: { model: requests[0]!.model, reasoning: requests[0]!.reasoning, service_tier: requests[0]!.service_tier },
      }));
    } finally { clearTimeout(timer); }
  } finally {
    await handle?.close();
    await agent.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
