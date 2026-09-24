import { describe, expect, it, vi } from 'vitest';
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions';
import { PROVIDER_MODEL_CATALOG, BUNDLED_CATALOG, buildUserProvider, parseModelsListResponse, mergeDiscoveredRuntimeModels } from '@cindy/model-providers';
import { createPiProviderFetch, hostCredentialEndpointAllowed, invocationModelRecord, nativeBridgeApiKey, NATIVE_ADAPTER_ERROR_BODY_LIMIT, readBoundedResponseText } from '../pi-provider-transport.js';

vi.mock('@earendil-works/pi-ai/api/openai-completions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@earendil-works/pi-ai/api/openai-completions')>(),
}));

const reply = [
  { id: 'fixture-reply', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] },
  { id: 'fixture-reply', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';

describe('Pi-owned transport for Cindy harnesses', () => {
  it.each([true, false, undefined])('sends discovered Sub2API effort and declared Fast (%s) through the native Chat adapter', async supportsFastMode => {
    const upstream = 'https://sub2api.example/custom/v1';
    const models = parseModelsListResponse({ data: [{ id: 'grok-4.7',
      supportsReasoningEffort: true, reasoningEffort: 'high',
      context_window: 272000, max_context_window: 1050000, supports_fast_mode: supportsFastMode,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map(value => ({ value, label: value })),
    }] })!;
    const stored = JSON.parse(JSON.stringify(mergeDiscoveredRuntimeModels([], models)));
    const provider = buildUserProvider({ id: 'sub2api', name: 'Sub2API', runtimes: {
      codex: { baseUrl: upstream, wireProtocol: 'openai-chat', models: stored },
    } });
    const row = invocationModelRecord(provider.models.codex![0], upstream, 'openai-completions')!;
    expect(row.contextWindow).toBe(1050000);
    let sent: Record<string, unknown> | undefined;
    const send = createPiProviderFetch({ row, providerId: provider.id, apiKey: 'fixture-key', fetchImpl: async (url, init) => {
      expect(String(url)).toBe(`${upstream}/chat/completions`);
      sent = JSON.parse(String(init?.body));
      return new Response(reply, { headers: { 'content-type': 'text/event-stream' } });
    } });
    const response = await send('https://unused.invalid', { body: JSON.stringify({
      model: row.id, input: 'hello', reasoning: { effort: 'xhigh' }, service_tier: 'priority', stream: true,
    }) });
    expect(await response.text()).toContain('response.completed');
    expect(sent).toMatchObject({ model: 'grok-4.7', reasoning_effort: 'xhigh' });
    expect(sent?.service_tier).toBe(supportsFastMode ? 'priority' : undefined);
  });

  it('reconciles saved max when capabilities narrow, disappear and return', async () => {
    const request = { model: 'changing-model', input: 'hello', reasoning: { effort: 'max' }, stream: true };
    for (const efforts of [['high', 'max'], ['high'], [], ['high', 'max']] as const) {
      const provider = buildUserProvider({ id: 'changing-provider', name: 'Changing provider', runtimes: {
        codex: { baseUrl: 'https://fixture.example/v1', wireProtocol: 'openai-chat', models: [{
          id: request.model, name: 'Changing model', reasoning: true, reasoningEfforts: [...efforts],
        }] },
      } });
      const row = invocationModelRecord(provider.models.codex![0], 'https://fixture.example/v1', 'openai-completions')!;
      let sent: Record<string, unknown> | undefined;
      const send = createPiProviderFetch({ row, providerId: provider.id, apiKey: 'fixture-key', fetchImpl: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(reply, { headers: { 'content-type': 'text/event-stream' } });
      } });
      expect(await (await send('https://unused.invalid', { body: JSON.stringify(request) })).text()).toContain('response.completed');
      if (!efforts.length) expect(sent).not.toHaveProperty('reasoning_effort');
      else expect(sent).toHaveProperty('reasoning_effort', efforts[efforts.length - 1]);
      expect(request.reasoning.effort).toBe('max');
    }
  });

  it('omits stale reasoning effort for a model without a capability declaration', async () => {
    const provider = buildUserProvider({ id: 'unknown-provider', name: 'Unknown provider', runtimes: {
      codex: { baseUrl: 'https://unknown.example/v1', wireProtocol: 'openai-chat',
        models: [{ id: 'unknown-model', name: 'Unknown model' }] },
    } });
    const row = invocationModelRecord(provider.models.codex![0], 'https://unknown.example/v1', 'openai-completions')!;
    let sent: Record<string, unknown> | undefined;
    const send = createPiProviderFetch({ row, providerId: provider.id, apiKey: 'fixture-key', fetchImpl: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(reply, { headers: { 'content-type': 'text/event-stream' } });
    } });
    const response = await send('https://unused.invalid', { body: JSON.stringify({
      model: row.id, input: 'hello', reasoning: { effort: 'max' }, stream: true,
    }) });
    expect(await response.text()).toContain('response.completed');
    expect(sent).toMatchObject({ model: row.id });
    expect(sent).not.toHaveProperty('reasoning_effort');
    expect(sent).not.toHaveProperty('thinking');
  });

  it.each(['ant-ling', 'qwen-token-plan', 'zai', 'together'])('sends the actual %s thinking dialect and model limits', async providerId => {
    const row = PROVIDER_MODEL_CATALOG.providers[providerId].find(row => row.reasoning && row.execution.pi.api === 'openai-completions')!;
    const effort = row.efforts.includes('high') ? 'high' : row.efforts[0];
    let sent: Record<string, unknown> | undefined;
    const send = createPiProviderFetch({ row, providerId, apiKey: 'fixture-provider-key', fetchImpl: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-provider-key');
      return new Response(reply, { headers: { 'content-type': 'text/event-stream' } });
    } });
    const response = await send('https://unused.invalid', { body: JSON.stringify({ model: row.id,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      reasoning: { effort }, max_output_tokens: 1024, stream: true,
    }) });
    const text = await response.text();
    expect(text).toContain('Hello');
    expect(text).toContain('response.completed');
    expect(sent).toMatchObject({ model: row.id, stream: true });
    const mapped = row.execution.pi.thinkingLevelMap?.[effort!] ?? effort;
    if (providerId === 'ant-ling') expect(sent).toMatchObject({ reasoning: { effort: mapped } });
    if (providerId === 'qwen-token-plan') expect(sent).toMatchObject({ enable_thinking: true });
    if (providerId === 'zai') expect(sent).toMatchObject({ thinking: { type: 'enabled', clear_thinking: false } });
    if (providerId === 'together') expect(sent).toMatchObject({ reasoning: { enabled: true } });
    expect(sent!.max_tokens ?? sent!.max_completion_tokens).toBe(1024);
  });
});

it('keeps native Gemini tool signatures across two turns through Responses history', async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const sent: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      sent.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const parts = sent.length === 1
        ? [{ functionCall: { id: 'weather-call', name: 'weather', args: { city: 'Shanghai' } }, thoughtSignature: 'c2lnbmF0dXJl' }]
        : [{ text: 'Sunny' }];
      res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } })}\n\n`);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address() as import('node:net').AddressInfo;
    const row = { ...PROVIDER_MODEL_CATALOG.providers.google.find(row => row.id.startsWith('gemini-3'))!,
      upstream: `http://127.0.0.1:${address.port}/v1beta` };
    const send = createPiProviderFetch({ row, providerId: 'user-google-connection', apiKey: 'fixture-key',
      fetchImpl: async () => { throw new Error('Google uses its native SDK transport'); } });
    const firstInput = [{ role: 'user', content: [{ type: 'input_text', text: 'What is the weather?' }] }];
    const tools = [{ type: 'function', name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
    const first = await (await send('https://unused.invalid', { body: JSON.stringify({ model: row.id, input: firstInput, tools, stream: true }) })).text();
    const events = first.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    const final = events.find(event => event.type === 'response.completed')?.response;
    expect(final, first).toBeDefined();
    const tool = final.output.find((item: Record<string, unknown>) => item.type === 'function_call');
    expect(tool).toMatchObject({ name: 'weather' });
    expect(final.output.some((item: Record<string, unknown>) => String(item.encrypted_content).startsWith('cindy-pi-history-v1:'))).toBe(true);
    const second = await (await send('https://unused.invalid', { body: JSON.stringify({ model: row.id, tools, stream: true,
      input: [...firstInput, ...final.output, { type: 'function_call_output', call_id: tool.call_id, output: 'Sunny' }],
    }) })).text();
    expect(second).toContain('Sunny');
    expect(JSON.stringify(sent[1])).toContain('c2lnbmF0dXJl');
    expect(JSON.stringify(sent[1])).toContain('functionResponse');
    expect(JSON.stringify(sent[1])).not.toContain('cindy-pi-history-v1');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('uses Cloudflare gateway authentication without forwarding its token as an upstream API key', async () => {
  const original = PROVIDER_MODEL_CATALOG.providers['cloudflare-ai-gateway'].find(row => row.execution.pi.api === 'openai-completions')!;
  const row = { ...original, upstream: original.upstream.replace('{CLOUDFLARE_ACCOUNT_ID}', 'fixture-account').replace('{CLOUDFLARE_GATEWAY_ID}', 'fixture-gateway') };
  let sent: Headers | undefined;
  const send = createPiProviderFetch({ row, providerId: 'renamed-cloudflare', apiKey: 'fixture-gateway-key',
    fetchImpl: async (_url, init) => { sent = new Headers(init?.headers); return new Response(reply, { headers: { 'content-type': 'text/event-stream' } }); },
  });
  expect(await (await send('https://unused.invalid', { body: JSON.stringify({ model: row.id, input: 'hello', stream: true }) })).text()).toContain('response.completed');
  expect(sent?.get('cf-aig-authorization')).toBe('Bearer fixture-gateway-key');
  expect(sent?.get('authorization')).toBeNull();
  expect(sent?.get('x-api-key')).toBeNull();
});

it('does not invent a fake API key for header-only native bridges', () => {
  expect(nativeBridgeApiKey({ 'cf-aig-authorization': 'Bearer header-only-key' })).toBe('');
  expect(nativeBridgeApiKey({ authorization: 'Bearer real-key' })).toBe('real-key');
});

it('allows official Vertex hosts for Desktop ADC and rejects unofficial ones', () => {
  expect(hostCredentialEndpointAllowed('google-vertex', 'https://aiplatform.googleapis.com')).toBe(true);
  expect(hostCredentialEndpointAllowed('google-vertex', 'https://aiplatform.us.rep.googleapis.com')).toBe(true);
  expect(hostCredentialEndpointAllowed('google-vertex', 'https://europe-west1-aiplatform.googleapis.com')).toBe(true);
  expect(hostCredentialEndpointAllowed('google-vertex', 'https://attacker.example')).toBe(false);
  expect(hostCredentialEndpointAllowed('google-vertex', 'https://evil-aiplatform.googleapis.com')).toBe(false);
});

it('does not let Bedrock execution inherit Desktop IAM against an unrelated host', async () => {
  const row = PROVIDER_MODEL_CATALOG.providers['amazon-bedrock'][0];
  const send = createPiProviderFetch({
    row: { ...row, upstream: 'https://attacker.example' },
    providerId: 'bedrock-attacker',
    apiKey: 'not-an-aws-key',
    upstream: 'https://attacker.example',
    fetchImpl: async () => { throw new Error('must not send'); },
  });
  await expect(send('https://unused.invalid', { body: JSON.stringify({ model: row.id, input: 'hello', stream: true }) }))
    .rejects.toThrow(/approved cloud endpoint/);
});

it('does not let a Pi placeholder key overwrite a saved Cloudflare header', async () => {
  const original = PROVIDER_MODEL_CATALOG.providers['cloudflare-ai-gateway'].find(row => row.execution.pi.api === 'openai-completions')!;
  const row = { ...original, upstream: original.upstream.replace('{CLOUDFLARE_ACCOUNT_ID}', 'fixture-account').replace('{CLOUDFLARE_GATEWAY_ID}', 'fixture-gateway') };
  let sent: Headers | undefined;
  const send = createPiProviderFetch({ row, providerId: 'renamed-cloudflare', apiKey: 'pi-native-keyless',
    headers: { 'cf-aig-authorization': 'Bearer header-only-key' },
    fetchImpl: async (_url, init) => { sent = new Headers(init?.headers); return new Response(reply, { headers: { 'content-type': 'text/event-stream' } }); },
  });
  expect(await (await send('https://unused.invalid', { body: JSON.stringify({ model: row.id, input: 'hello', stream: true }) })).text()).toContain('response.completed');
  expect(sent?.get('cf-aig-authorization')).toBe('Bearer header-only-key');
});

it('keeps a saved Cloudflare gateway header when no API key is stored', async () => {
  const original = PROVIDER_MODEL_CATALOG.providers['cloudflare-ai-gateway'].find(row => row.execution.pi.api === 'openai-completions')!;
  const row = { ...original, upstream: original.upstream.replace('{CLOUDFLARE_ACCOUNT_ID}', 'fixture-account').replace('{CLOUDFLARE_GATEWAY_ID}', 'fixture-gateway') };
  let sent: Headers | undefined;
  const send = createPiProviderFetch({ row, providerId: 'renamed-cloudflare', apiKey: '',
    headers: { 'cf-aig-authorization': 'Bearer header-only-key' },
    fetchImpl: async (_url, init) => { sent = new Headers(init?.headers); return new Response(reply, { headers: { 'content-type': 'text/event-stream' } }); },
  });
  expect(await (await send('https://unused.invalid', { body: JSON.stringify({ model: row.id, input: 'hello', stream: true }) })).text()).toContain('response.completed');
  expect(sent?.get('cf-aig-authorization')).toBe('Bearer header-only-key');
  expect(sent?.get('authorization')).toBeNull();
  expect(sent?.get('x-api-key')).toBeNull();
});

it('honors newly discovered max thinking instead of clamping it to an older table', async () => {
  const base = PROVIDER_MODEL_CATALOG.providers.openrouter.find(row => row.execution.pi.api === 'openai-completions')!;
  const row = { ...base, id: '~new-vendor/new-model', upstream: 'https://supplier.example/v1', reasoning: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as typeof base.efforts,
    execution: { pi: { api: 'openai-completions' } } };
  let sent: Record<string, unknown> | undefined;
  const send = createPiProviderFetch({ row, providerId: 'new-supplier', apiKey: 'fixture-key', fetchImpl: async (_url, init) => {
    sent = JSON.parse(String(init?.body)); return new Response(reply, { headers: { 'content-type': 'text/event-stream' } });
  } });
  await (await send('https://unused.invalid', { body: JSON.stringify({ model: row.id, input: 'hello', stream: true, reasoning: { effort: 'max' } }) })).text();
  expect(sent).toMatchObject({ model: row.id, reasoning_effort: 'max' });
});


it.each(['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'])('sends imported %s through the real Google SDK to the native endpoint', async id => {
  const preset = BUNDLED_CATALOG.presets!.find(p => p.id === 'google-gemini-api')!;
  const provider = buildUserProvider({ id: 'google-import', name: 'Google', runtimes: {
    pi: { ...preset.runtimes.pi!, catalogPresetId: 'google-gemini-api', models: [{ id, name: id }] },
  } }, { presets: [preset] });
  const model = provider.models.pi![0];
  const row = invocationModelRecord(model, model.route?.baseUrl ?? provider.routing.pi!.upstream!)!;
  const requests: Request[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(request);
    expect(new URL(request.url).pathname).toBe(`/v1beta/models/${id}:streamGenerateContent`);
    expect(request.headers.get('x-goog-api-key')).toBe('fixture-key');
    expect(await request.json()).toMatchObject({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }], generationConfig: { maxOutputTokens: 128 } });
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    const send = createPiProviderFetch({ row, providerId: provider.id, apiKey: 'fixture-key', fetchImpl: globalThis.fetch });
    const response = await send('https://unused.invalid', { body: JSON.stringify({ model: id, input: 'hello', max_output_tokens: 128, stream: true }) });
    const output = await response.text();
    expect(output).toContain('response.completed');
    expect(output).toContain('OK');
    expect(requests).toHaveLength(1);
  } finally { vi.unstubAllGlobals(); }
});


it.each(['individual', 'business', 'enterprise'])('sends Copilot Responses editor headers to the %s host', async account => {
  const row = PROVIDER_MODEL_CATALOG.providers['github-copilot'].find(row => row.execution.pi.api === 'openai-responses')!;
  let captured = false;
  const send = createPiProviderFetch({ row, providerId: 'renamed-copilot',
    upstream: `https://api.${account}.githubcopilot.com`, apiKey: 'fixture-token',
    fetchImpl: async (url, init) => {
      captured = true;
      expect(String(url)).toBe(`https://api.${account}.githubcopilot.com/responses`);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer fixture-token');
      expect(headers.get('editor-version')).toBeTruthy();
      expect(headers.get('editor-plugin-version')).toBeTruthy();
      expect(headers.get('copilot-integration-id')).toBe('vscode-chat');
      return new Response('data: {"type":"response.completed","response":{"id":"fixture","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const result = await (await send('https://unused.invalid', { body: JSON.stringify({ model: row.id, input: 'ping', max_output_tokens: 16 }) })).text();
  expect(result).toContain('response.completed');
  expect(captured).toBe(true);
});

it('reads only a prefix of native adapter error bodies', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.alloc(NATIVE_ADAPTER_ERROR_BODY_LIMIT, 97));
      controller.enqueue(Buffer.alloc(NATIVE_ADAPTER_ERROR_BODY_LIMIT, 98));
      controller.close();
    },
  });
  const text = await readBoundedResponseText(new Response(stream));
  expect(text).toHaveLength(NATIVE_ADAPTER_ERROR_BODY_LIMIT);
  expect(text).toBe('a'.repeat(NATIVE_ADAPTER_ERROR_BODY_LIMIT));
});


describe('native provider failure diagnostics', () => {
  const row = PROVIDER_MODEL_CATALOG.providers.together.find(
    row => row.execution.pi.api === 'openai-completions',
  )!;
  const request = () => ({ body: JSON.stringify({ model: row.id, input: 'ping', stream: true }) });

  it.each([
    [401, 'authentication'], [403, 'permission'], [429, 'rate_limit'],
    [503, 'provider_unavailable'], [400, 'request_rejected'],
  ])('reports HTTP %s without exposing the provider response', async (status, category) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: {
      message: 'secret-fixture-key private prompt /Users/private/source.ts',
    } }), { status: Number(status), headers: { 'content-type': 'application/json' } }));
    const send = createPiProviderFetch({ row, providerId: 'together', apiKey: 'fixture-key', fetchImpl });
    const text = await (await send('https://unused.invalid', request())).text();
    expect(text).toContain('response.failed');
    expect(text).toContain(`HTTP ${status}`);
    expect(text).toContain(`category=${category}`);
    expect(text).toContain('phase=adapter-event');
    expect(text).toMatch(/request=[a-f0-9-]{36}/);
    expect(text).not.toMatch(/secret-fixture-key|private prompt|Users\/private/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps unknown transport failures unknown and allows a later request to succeed', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('secret-fixture-key https://private.invalid/credential'))
      .mockResolvedValueOnce(new Response(reply, { headers: { 'content-type': 'text/event-stream' } }));
    const send = createPiProviderFetch({ row, providerId: 'together', apiKey: 'fixture-key', fetchImpl });
    const failed = await (await send('https://unused.invalid', request())).text();
    expect(failed).toContain('category=unknown');
    expect(failed).not.toMatch(/secret-fixture-key|private.invalid|HTTP 401|category=authentication/);
    const succeeded = await (await send('https://unused.invalid', request())).text();
    expect(succeeded).toContain('response.completed');
    expect(succeeded).not.toContain('response.failed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not report HTTP 200 as the cause of a malformed response stream', async () => {
    const fetchImpl = vi.fn(async () => new Response('data: invalid-json\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }));
    const send = createPiProviderFetch({ row, providerId: 'together', apiKey: 'fixture-key', fetchImpl });
    const text = await (await send('https://unused.invalid', request())).text();
    expect(text).toContain('response.failed');
    expect(text).toContain('phase=adapter-event');
    expect(text).toContain('category=unknown');
    expect(text).not.toContain('HTTP 200');
    expect(text).not.toContain('invalid-json');
  });

  it('does not reuse HTTP failure status from an earlier request', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockRejectedValueOnce(new Error('fixture transport failure'));
    const send = createPiProviderFetch({ row, providerId: 'together', apiKey: 'fixture-key', fetchImpl });
    const first = await (await send('https://unused.invalid', request())).text();
    const second = await (await send('https://unused.invalid', request())).text();
    expect(first).toContain('HTTP 401');
    expect(second).toContain('category=unknown');
    expect(second).not.toContain('HTTP 401');
  });
});


it.each([undefined, 200, 302])('keeps iterator exceptions private after HTTP %s and labels the stream-read phase', async (status) => {
  const row = PROVIDER_MODEL_CATALOG.providers.together.find(row => row.execution.pi.api === 'openai-completions')!;
  let adapterFetch: typeof fetch | undefined;
  const iterator = {
    async *[Symbol.asyncIterator]() {
      if (status !== undefined) await adapterFetch!('https://fixture.invalid');
      yield { type: 'text_delta', delta: 'fixture prefix' };
      throw new Error('secret-fixture-key private prompt');
    },
  };
  const stream = vi.spyOn(openaiCompletions, 'streamSimple').mockImplementationOnce((_model, _context, options) => {
    adapterFetch = options?.fetch;
    return iterator as unknown as ReturnType<typeof openaiCompletions.streamSimple>;
  });
  try {
    const send = createPiProviderFetch({ row, providerId: 'together', apiKey: 'fixture-key',
      fetchImpl: async () => new Response(null, { status: status ?? 200 }),
    });
    const response = await send('https://unused.invalid', { body: JSON.stringify({ model: row.id, input: 'ping' }) });
    const error = await response.text().catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('phase=stream-read');
    expect((error as Error).message).toContain('category=unknown');
    expect((error as Error).message).not.toMatch(/secret-fixture-key|private prompt|HTTP/);
  } finally {
    stream.mockRestore();
  }
});
