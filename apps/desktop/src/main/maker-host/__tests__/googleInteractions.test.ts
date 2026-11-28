/**
 * Protects the Google AI Ultra Interactions API adapter, error classification,
 * cross-engine bridging (Codex/Claude via `createPiProviderFetch`, probe via
 * `probePiProvider`), and Pi native catalog projection over `oauthProxyEndpoint`.
 * Tier: unit.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BUNDLED_CATALOG,
  buildUserProvider,
  providerPresetOAuth,
  providerPresetOAuthRuntimes,
} from '@cindy/model-providers';
import { classifyGoogleInteractionsError } from '../google-interactions-errors.js';
import {
  buildGoogleInteractionsRequest,
  setGoogleInteractionsAppVersion,
  streamSimple,
} from '../google-interactions.js';
import { buildPiNativeProvidersFromConfigs } from '../pi-native-catalog.js';
import {
  createPiProviderFetch,
  invocationModelRecord,
  probePiProvider,
} from '../pi-provider-transport.js';

function sseResponse(events: Array<Record<string, unknown> | '[DONE]'>): Response {
  const body = events
    .map((event) => `data: ${event === '[DONE]' ? '[DONE]' : JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('Google Interactions API adapter & cross-engine integration', () => {
  it('ships google-ai-plan preset across all three engines with fixed models and thinking ranges', () => {
    const preset = BUNDLED_CATALOG.presets?.find((p) => p.id === 'google-ai-plan');
    expect(preset).toBeDefined();
    expect(preset?.name).toBe('Google AI Ultra');
    expect(Object.keys(preset!.runtimes).sort()).toEqual(['claude-code', 'codex', 'pi']);

    const provider = buildUserProvider(
      {
        id: 'google-ai-plan-test',
        name: preset!.name,
        auth: { method: 'oauth', oauth: providerPresetOAuth('google-ai-plan')! },
        runtimes: providerPresetOAuthRuntimes(preset!),
      },
      { presets: BUNDLED_CATALOG.presets },
    );

    expect(provider.routing['claude-code']?.authStrategy).toBe('oauth-token');
    expect(provider.routing.codex?.authStrategy).toBe('oauth-token');
    expect(provider.routing.pi?.authStrategy).toBe('oauth-token');
    expect(provider.models.pi?.map((m) => m.id)).toEqual([
      'gemini-4-hydrogen',
      'gemini-4-neon',
      'gemini-4-carbon',
      'gemini-3.5-flash-lite',
    ]);
    expect(provider.models.pi?.every((m) => m.api === 'google-interactions')).toBe(true);
    expect(provider.models.pi?.find((m) => m.id === 'gemini-4-neon')?.efforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(provider.models.pi?.find((m) => m.id === 'gemini-4-carbon')?.efforts).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(provider.models.pi?.find((m) => m.id === 'gemini-3.5-flash-lite')?.efforts).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
  });

  it('builds stateless Interactions payloads with thought signature replay and sentinel fallback', () => {
    const model = {
      id: 'gemini-4-neon',
      name: 'Gemini 4 Neon',
      api: 'google-interactions',
      provider: 'google-ai-plan',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: null },
      input: ['text', 'image'] as Array<'text' | 'image'>,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    };

    const payload = buildGoogleInteractionsRequest(
      model,
      {
        systemPrompt: 'Be concise.',
        messages: [
          { role: 'user', content: 'Check weather', timestamp: 0 },
          {
            role: 'assistant',
            api: 'openai-responses',
            provider: 'openai',
            model: 'gpt-6-sol',
            content: [{ type: 'toolCall', id: 'call_1', name: 'get_weather', arguments: { city: 'Auckland' } }],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'toolUse',
            timestamp: 0,
          },
          {
            role: 'toolResult',
            toolCallId: 'call_1',
            toolName: 'get_weather',
            content: [{ type: 'text', text: '18C sunny' }],
            isError: false,
            timestamp: 0,
          },
        ],
        tools: [{ name: 'get_weather', description: 'Read weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } as never }],
      },
      { thinkingLevel: 'xhigh', maxTokens: 99_999 },
    );

    expect(payload.store).toBe(false);
    expect(payload.stream).toBe(true);
    expect(payload.system_instruction).toBe('Be concise.');
    expect(payload.generation_config).toEqual({
      thinking_level: 'xhigh',
      thinking_summaries: 'auto',
      max_output_tokens: 65_536,
    });
    expect(payload.input).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'Check weather' }] },
      { type: 'thought', signature: 'skip_thought_signature_validator' },
      { type: 'function_call', id: 'call_1', name: 'get_weather', arguments: { city: 'Auckland' } },
      { type: 'function_result', call_id: 'call_1', name: 'get_weather', result: '18C sunny' },
    ]);
  });

  it('streams thoughts, signatures, text, and tool calls with Bearer + Cindy User-Agent and strips forbidden headers', async () => {
    setGoogleInteractionsAppVersion('0.2.50');
    let capturedUrl = '';
    let capturedHeaders: Headers | null = null;
    let capturedBody: Record<string, unknown> | null = null;

    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        { event_type: 'step.start', index: 0, step: { type: 'thought' } },
        { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: 'Thinking step' } } },
        { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'sig-abc' } },
        { event_type: 'step.stop', index: 0 },
        { event_type: 'step.start', index: 1, step: { type: 'model_output' } },
        { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'Hello ' } },
        { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'Cindy' } },
        { event_type: 'step.stop', index: 1 },
        { event_type: 'step.start', index: 2, step: { type: 'function_call', id: 'fc_1', name: 'lookup' } },
        { event_type: 'step.delta', index: 2, delta: { type: 'arguments_delta', arguments: '{"q":"ai' } },
        { event_type: 'step.delta', index: 2, delta: { type: 'arguments_delta', arguments: '"}' } },
        { event_type: 'step.stop', index: 2 },
        {
          event_type: 'interaction.completed',
          interaction: {
            id: 'int_1',
            status: 'requires_action',
            usage: {
              total_input_tokens: 120,
              total_cached_tokens: 20,
              total_output_tokens: 30,
              total_thought_tokens: 10,
              total_tokens: 160,
            },
          },
        },
        '[DONE]',
      ]);
    });

    const model = {
      id: 'gemini-4-carbon',
      name: 'Gemini 4 Carbon',
      api: 'google-interactions',
      provider: 'google-ai-plan',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
      input: ['text', 'image'] as Array<'text' | 'image'>,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    };

    const result = await streamSimple(
      model,
      { messages: [{ role: 'user', content: 'Hi', timestamp: 0 }] },
      {
        apiKey: 'ya29.bearer-token',
        reasoning: 'xhigh',
        headers: {
          'x-goog-api-key': 'should-be-stripped',
          'x-goog-user-project': 'should-be-stripped',
          DPoP: 'should-be-stripped',
        },
        fetch: mockFetch,
      },
    ).result();

    expect(capturedUrl).toBe('https://generativelanguage.googleapis.com/v1beta/interactions:createPerUserQuota');
    expect(capturedHeaders!.get('authorization')).toBe('Bearer ya29.bearer-token');
    expect(capturedHeaders!.get('user-agent')).toBe('Cindy/0.2.50');
    expect(capturedHeaders!.get('x-goog-api-key')).toBeNull();
    expect(capturedHeaders!.get('x-goog-user-project')).toBeNull();
    expect(capturedHeaders!.get('dpop')).toBeNull();
    // Carbon clamps xhigh down to high.
    expect((capturedBody!.generation_config as Record<string, unknown>).thinking_level).toBe('high');

    expect(result.stopReason).toBe('toolUse');
    expect(result.responseId).toBe('int_1');
    expect(result.usage).toMatchObject({ input: 100, output: 40, cacheRead: 20, totalTokens: 160 });
    expect(result.content).toEqual([
      { type: 'thinking', thinking: 'Thinking step', thinkingSignature: 'sig-abc' },
      { type: 'text', text: 'Hello Cindy' },
      { type: 'toolCall', id: 'fc_1', name: 'lookup', arguments: { q: 'ai' } },
    ]);
  });

  it('errors when stream closes before interaction.completed', async () => {
    const model = {
      id: 'gemini-4-hydrogen',
      name: 'Gemini 4 Hydrogen',
      api: 'google-interactions',
      provider: 'google-ai-plan',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      reasoning: true,
      thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
      input: ['text'] as Array<'text'>,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    };

    const result = await streamSimple(
      model,
      { messages: [{ role: 'user', content: 'Hi', timestamp: 0 }] },
      {
        apiKey: 'ya29.token',
        fetch: async () =>
          sseResponse([
            { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
            { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Truncated' } },
          ]),
      },
    ).result();

    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('interaction.completed');
  });

  it('classifies per-minute 429, daily 429, not-on-plan 429, kill switch, and ineligible plan errors', () => {
    const perMinute = classifyGoogleInteractionsError({
      status: 429,
      headers: new Headers(),
      body: JSON.stringify({ error: { message: 'Too many requests per minute' } }),
      modelId: 'gemini-4-neon',
    });
    expect(perMinute).toMatchObject({ final: false, kind: 'per-minute-rate-limit' });

    const daily = classifyGoogleInteractionsError({
      status: 429,
      headers: new Headers({ 'retry-after': '3900' }),
      body: JSON.stringify([
        {
          error: {
            message: 'Quota exceeded',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                violations: [{ quotaId: 'GeneratePerDay', quotaValue: '500' }],
              },
            ],
          },
        },
      ]),
      modelId: 'gemini-4-neon',
    });
    expect(daily.final).toBe(true);
    expect(daily.kind).toBe('daily-limit');
    expect(daily.message).toContain('Daily limit reached for gemini-4-neon (resets in 1h 5m)');

    const notOnPlan = classifyGoogleInteractionsError({
      status: 429,
      headers: new Headers(),
      body: `event: error\ndata: ${JSON.stringify({
        error: { message: 'Rate limit exceeded for model gemini-4-carbon (limit: 0 requests per day)' },
      })}\n\n`,
      modelId: 'gemini-4-carbon',
    });
    expect(notOnPlan).toMatchObject({ final: true, kind: 'not-on-plan' });
    expect(notOnPlan.message).toContain('gemini-4-carbon is not available on the Google AI Ultra plan');

    const killSwitch = classifyGoogleInteractionsError({
      status: 403,
      headers: new Headers(),
      body: JSON.stringify({
        error: {
          message: 'OAuth client is not authorized',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }],
        },
      }),
      modelId: 'gemini-4-neon',
    });
    expect(killSwitch).toMatchObject({ final: true, kind: 'client-unauthorized' });

    const ineligible = classifyGoogleInteractionsError({
      status: 403,
      headers: new Headers(),
      body: JSON.stringify({ error: { message: 'Subscription required' } }),
      modelId: 'gemini-4-neon',
    });
    expect(ineligible).toMatchObject({ final: true, kind: 'plan-ineligible' });
    expect(ineligible.message).toContain('https://one.google.com/ai');
  });

  it('bridges google-interactions through pi-provider-transport and projects Pi OAuth models over anthropic-messages proxy', async () => {
    const preset = BUNDLED_CATALOG.presets!.find((p) => p.id === 'google-ai-plan')!;
    const runtimes = providerPresetOAuthRuntimes(preset);
    const oauth = providerPresetOAuth('google-ai-plan')!;
    const provider = buildUserProvider(
      { id: 'google-ai-plan-x', name: preset.name, auth: { method: 'oauth', oauth }, runtimes },
      { presets: BUNDLED_CATALOG.presets },
    );

    const piProjected = buildPiNativeProvidersFromConfigs(
      [{ id: 'google-ai-plan-x', name: preset.name, auth: { method: 'oauth', oauth }, runtimes }],
      () => null,
      undefined,
      undefined,
      { version: 'test', providers: [provider] },
      'http://127.0.0.1:41234',
    );
    expect(piProjected.providers).toHaveLength(1);
    expect(piProjected.providers[0]!.baseUrl).toBe('http://127.0.0.1:41234');
    expect(piProjected.providers[0]!.api).toBe('anthropic-messages');
    expect(piProjected.providers[0]!.models.every((m) => m.api === 'anthropic-messages')).toBe(true);
    expect(piProjected.env).toEqual({});

    const row = invocationModelRecord(provider.models.codex![0]!, provider.routing.codex!.upstream)!;
    const mockFetch = vi.fn<typeof fetch>(async () =>
      sseResponse([
        { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
        { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'pong' } },
        { event_type: 'step.stop', index: 0 },
        { event_type: 'interaction.completed', interaction: { id: 'int_probe', status: 'completed' } },
      ]),
    );

    const probed = await probePiProvider(
      { row, providerId: provider.id, apiKey: 'ya29.probe', fetchImpl: mockFetch },
      AbortSignal.timeout(5_000),
    );
    expect(probed.stopReason).toBe('stop');

    const bridgedFetch = createPiProviderFetch({
      row,
      providerId: provider.id,
      apiKey: 'ya29.bridge',
      fetchImpl: mockFetch,
    });
    const bridgeResponse = await bridgedFetch('https://cindy-native-adapter.invalid', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-4-hydrogen',
        stream: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      }),
    });
    const sseText = await bridgeResponse.text();
    expect(sseText).toContain('response.output_text.delta');
    expect(sseText).toContain('pong');
    expect(sseText).toContain('response.completed');
  });
});
