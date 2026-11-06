import { describe, expect, it } from 'vitest';

import {
  MAGPIE_MODELS_URL,
  MAGPIE_PRESET_ID,
  isMagpieCustomProviderConfig,
  magpieModelForAgent,
  magpieOriginPrefix,
  magpieRouteForAgent,
  parseMagpieNativeEndpoints,
} from '../magpie.js';
import { parseModelsListResponse } from '../modelDiscovery.js';

const ORIGIN = 'http://127.0.0.1:3425';

const catalog = (nativeEndpoints?: unknown[]) => parseModelsListResponse({
  data: [{
    id: 'workbuddy/deepseek-v4.1-flash',
    display_name: 'DeepSeek V4.1 Flash',
    owned_by: 'workbuddy',
    magpie_label: 'DeepSeek V4.1 Flash · WorkBuddy',
    ...(nativeEndpoints !== undefined ? { native_endpoints: nativeEndpoints } : {}),
  }],
})!;

describe('Magpie discovery evidence', () => {
  it('keeps native endpoints, the opaque wire id and supplier provenance', () => {
    const [model] = catalog(['/v1/chat/completions', '/v1/unknown']);
    expect(model).toMatchObject({
      id: 'workbuddy/deepseek-v4.1-flash',
      opaqueModelId: true,
      nativeEndpoints: ['/v1/chat/completions'],
      discoveredSource: { kind: 'magpie', providerId: 'workbuddy' },
    });
  });

  it('treats an absent or unusable endpoint list as translated, not as chat-only', () => {
    expect(catalog()[0].nativeEndpoints).toBeUndefined();
    expect(catalog(['/v1/images/generations'])[0].nativeEndpoints).toBeUndefined();
    expect(parseMagpieNativeEndpoints('/v1/messages')).toBeUndefined();
  });
});

describe('Magpie native protocol routing', () => {
  it('uses the declared Responses path for every harness', () => {
    const [model] = catalog(['/v1/responses']);
    expect(magpieRouteForAgent('codex', model.nativeEndpoints, ORIGIN, 'openai-responses'))
      .toBeUndefined();
    expect(magpieRouteForAgent('claude-code', model.nativeEndpoints, ORIGIN, 'anthropic-messages'))
      .toEqual({ baseUrl: `${ORIGIN}/v1`, wireProtocol: 'openai-responses' });
    expect(magpieRouteForAgent('pi', model.nativeEndpoints, ORIGIN, 'openai-chat'))
      .toEqual({ baseUrl: `${ORIGIN}/v1`, wireProtocol: 'openai-responses' });
  });

  it('uses Chat only where the model declares it', () => {
    const [model] = catalog(['/v1/chat/completions']);
    expect(magpieRouteForAgent('claude-code', model.nativeEndpoints, ORIGIN, 'anthropic-messages'))
      .toEqual({ baseUrl: `${ORIGIN}/v1`, wireProtocol: 'openai-chat' });
    expect(magpieRouteForAgent('codex', model.nativeEndpoints, `${ORIGIN}/v1`, 'openai-responses'))
      .toEqual({ baseUrl: `${ORIGIN}/v1`, wireProtocol: 'openai-chat' });
    expect(magpieRouteForAgent('pi', model.nativeEndpoints, `${ORIGIN}/v1`, 'openai-chat'))
      .toBeUndefined();
  });

  it('keeps Messages on the gateway root for Codex and Pi bridges', () => {
    const [model] = catalog(['/v1/messages']);
    expect(magpieRouteForAgent('claude-code', model.nativeEndpoints, ORIGIN, 'anthropic-messages'))
      .toBeUndefined();
    expect(magpieRouteForAgent('codex', model.nativeEndpoints, `${ORIGIN}/v1`, 'openai-responses'))
      .toEqual({ baseUrl: ORIGIN, wireProtocol: 'anthropic-messages' });
    expect(magpieRouteForAgent('pi', model.nativeEndpoints, `${ORIGIN}/v1`, 'openai-chat'))
      .toEqual({ baseUrl: ORIGIN, wireProtocol: 'anthropic-messages' });
  });

  it('leaves translated models on the runtime default', () => {
    const [model] = catalog();
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      expect(magpieRouteForAgent(agent, model.nativeEndpoints, ORIGIN)).toBeUndefined();
    }
  });

  it('applies a native route without changing the wire model id', () => {
    const [model] = catalog(['/v1/responses']);
    const routed = magpieModelForAgent(model, 'claude-code', ORIGIN, 'anthropic-messages');
    expect(routed.route).toEqual({ baseUrl: `${ORIGIN}/v1`, wireProtocol: 'openai-responses' });
    expect(routed.id).toBe(model.id);
  });
});

describe('Magpie connection identity', () => {
  it('recognizes the preset marker and normalizes the gateway root', () => {
    expect(isMagpieCustomProviderConfig({
      runtimes: { codex: { catalogPresetId: MAGPIE_PRESET_ID } },
    })).toBe(true);
    expect(isMagpieCustomProviderConfig({
      runtimes: { codex: { catalogPresetId: 'openrouter' } },
    })).toBe(false);
    expect(isMagpieCustomProviderConfig({ id: 'magpie-2', runtimes: {} })).toBe(true);
    expect(magpieOriginPrefix(`${ORIGIN}/v1`)).toBe(ORIGIN);
    expect(magpieOriginPrefix(`${ORIGIN}/gateway/v1`)).toBe(`${ORIGIN}/gateway`);
    expect(MAGPIE_MODELS_URL).toBe(`${ORIGIN}/v1/models`);
  });
});
