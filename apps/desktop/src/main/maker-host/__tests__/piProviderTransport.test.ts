import { describe, expect, it } from 'vitest';
import { PROVIDER_MODEL_CATALOG } from '@cindy/model-providers';
import { createPiProviderFetch } from '../pi-provider-transport.js';

const reply = [
  { id: 'fixture-reply', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] },
  { id: 'fixture-reply', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';

describe('Pi-owned transport for Cindy harnesses', () => {
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
