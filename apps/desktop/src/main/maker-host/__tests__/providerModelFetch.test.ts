/**
 * provider-model-fetch 单测：URL 推导（modelsUrl 优先 / baseUrl 推导）、cc vs codex 鉴权头、
 * 响应三形状解析（{data} / {models} / 字符串数组）与错误分类。fetch 注入不联网
 * （模式同 providerDiagnostics.test.ts）。
 */

import { describe, it, expect, vi } from 'vitest';
import { acceptsModelSourceSnapshot, modelSourceRequestSignature } from '../model-source-snapshots.js';

import {
  buildModelsFetchRequest,
  fetchProviderModels,
  type ProviderModelsFetchSpec,
} from '../provider-model-fetch.js';

function spec(over: Partial<ProviderModelsFetchSpec> = {}): ProviderModelsFetchSpec {
  return {
    agent: 'claude-code',
    baseUrl: 'https://api.acme.example/anthropic',
    apiKey: 'sk-test',
    ...over,
  };
}

function fakeResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

// Unit regression: real fetch entry, legacy saved /v1/models plus three inference
// protocols. Prior account tests passed an already-correct /models URL and missed this.
it.each(['claude-code', 'codex', 'pi'] as const)('discovers Copilot models independently of the %s inference API', async agent => {
  const result = await fetchProviderModels(spec({ agent,
    baseUrl: 'https://api.enterprise.githubcopilot.com',
    modelsUrl: 'https://api.enterprise.githubcopilot.com/v1/models',
    wireProtocol: agent === 'claude-code' ? 'anthropic-messages' : agent === 'codex' ? 'openai-responses' : 'openai-chat',
  }), async (url, init) => {
    expect(String(url)).toBe('https://api.enterprise.githubcopilot.com/models');
    const headers = new Headers(init?.headers);
    expect(headers.get('copilot-integration-id')).toBe('vscode-chat');
    expect(headers.get('authorization')).toBe('Bearer sk-test');
    expect(headers.has('x-api-key')).toBe(false);
    expect(headers.has('anthropic-version')).toBe(false);
    return fakeResponse(200, '{"data":[{"id":"future-account-model"}]}');
  });
  expect(result).toMatchObject({ ok: true, models: [{ id: 'future-account-model' }] });
});

it.each(['https://api.individual.githubcopilot.com.evil.test', 'https://custom.example'])('keeps custom discovery semantics at %s', baseUrl => {
  const request = buildModelsFetchRequest(spec({ baseUrl }));
  expect(request.url).toBe(`${baseUrl}/v1/models`);
  expect(new Headers(request.init.headers).has('copilot-integration-id')).toBe(false);
});

describe('import discovery limits', () => {
  // #9101 review regression: three identical Chat runtimes must perform one
  // HTTP read, while each consumer still issues its own agent-bound receipt.
  it('coalesces concurrent Hinoki reads without sharing agent provenance', async () => {
    const agents = ['claude-code', 'codex', 'pi'] as const;
    const request = spec({ baseUrl: 'https://inference.hinoki.security/v1',
      modelsUrl: 'https://inference.hinoki.security/v1/models', wireProtocol: 'openai-chat' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetcher = vi.fn(async () => {
      await gate;
      // Controlled provenance-marker counterexample, not an observed Hinoki payload.
      return fakeResponse(200, JSON.stringify({ data: [{ id: 'future-model',
        owned_by: 'fake-source', magpie_label: 'Model · fake-source' }] }));
    });
    const pending = agents.map(agent => fetchProviderModels({ ...request, agent }, fetcher));
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledOnce();
    release();
    const results = await Promise.all(pending);
    const { url, init } = buildModelsFetchRequest(request);
    const signature = modelSourceRequestSignature(url, init);
    const snapshotIds = new Set<string>();
    results.forEach((result, index) => {
      expect(result.ok).toBe(true);
      const model = result.models![0];
      expect(model.id).toBe('future-model');
      snapshotIds.add(model.discoverySnapshotId!);
      expect(acceptsModelSourceSnapshot(model.id, model.discoveredSource, 'new', agents[index], signature)).toBe(true);
      expect(acceptsModelSourceSnapshot(model.id, model.discoveredSource, 'new', agents[(index + 1) % agents.length], signature)).toBe(false);
    });
    expect(snapshotIds.size).toBe(3);
    expect(results[0].models).not.toBe(results[1].models);
    expect(results[0].models![0]).not.toBe(results[1].models![0]);
  });

  it('isolates Hinoki reads by credentials, headers, redirect policy, view and transport', async () => {
    const request = spec({ agent: 'pi', baseUrl: 'https://inference.hinoki.security/v1',
      modelsUrl: 'https://inference.hinoki.security/v1/models', wireProtocol: 'openai-chat' });
    const fetcher = vi.fn(async () => fakeResponse(200, '{"data":[{"id":"future-model"}]}'));
    const otherOwner = vi.fn(async () => fakeResponse(200, '{"data":[{"id":"future-model"}]}'));
    const results = await Promise.all([
      fetchProviderModels(request, fetcher),
      fetchProviderModels({ ...request, apiKey: 'sk-other-fake' }, fetcher),
      fetchProviderModels({ ...request, headers: { 'X-Account': 'other-fake' } }, fetcher),
      fetchProviderModels({ ...request, redirect: 'error' }, fetcher),
      fetchProviderModels({ ...request, modelsUrl: request.modelsUrl + '?filter=chat' }, fetcher),
      fetchProviderModels({ ...request, wireProtocol: 'anthropic-messages' }, fetcher),
      fetchProviderModels(request, otherOwner),
    ]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(otherOwner).toHaveBeenCalledOnce();
    const before = fetcher.mock.calls.length;
    expect(await fetchProviderModels({ ...request, authMethod: 'none' }, fetcher)).toMatchObject({ ok: false });
    expect(fetcher).toHaveBeenCalledTimes(before);
  });

  it.each(['network', 'http', 'invalid-json', 'business-error', 'empty'] as const)
  ('releases shared Hinoki %s reads and keeps failures distinct from empty success', async kind => {
    const request = spec({ baseUrl: 'https://inference.hinoki.security/v1',
      modelsUrl: 'https://inference.hinoki.security/v1/models', wireProtocol: 'openai-chat' });
    let recovered = false;
    const fetcher = vi.fn(async () => {
      if (recovered) return fakeResponse(200, '{"data":[{"id":"recovered"}]}');
      if (kind === 'network') throw new TypeError('fake network failure');
      return fakeResponse(kind === 'http' ? 401 : 200, kind === 'invalid-json' ? 'not-json'
        : JSON.stringify(kind === 'business-error' ? { error: 'fake invalid key', data: [] } : { data: [] }));
    });
    const results = await Promise.all((['claude-code', 'codex', 'pi'] as const)
      .map(agent => fetchProviderModels({ ...request, agent }, fetcher)));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(results.every(result => result.ok === (kind === 'empty'))).toBe(true);
    if (kind === 'http') expect(results.every(result => result.status === 401)).toBe(true);
    if (kind === 'empty') expect(results.map(result => result.models)).toEqual([[], [], []]);
    recovered = true;
    expect(await fetchProviderModels({ ...request, agent: 'pi' }, fetcher))
      .toMatchObject({ ok: true, models: [{ id: 'recovered' }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  // #9101, unit: saved refresh omits allowEmpty. Exercise the production fetch
  // contract, including raw empty vs parser-filtered empty and business errors;
  // existing generic/Ollama cases do not cover Hinoki's authenticated view.
  it.each(['claude-code', 'codex', 'pi'] as const)
  ('keeps Hinoki %s discovery authenticated and distinguishes empty from failure', async agent => {
    const request = spec({ agent, baseUrl: 'https://inference.hinoki.security/v1',
      modelsUrl: 'https://inference.hinoki.security/v1/models', wireProtocol: 'openai-chat' });
    for (const [status, body, ok] of [
      [200, { data: [{ id: 'hinoki-offensive' }, { id: 'future-model' }] }, true],
      [200, { data: [] }, true],
      [200, { data: [{}] }, false],
      [200, { error: { message: 'invalid key' }, data: [] }, false],
      [401, { error: { message: 'invalid key' } }, false],
    ] as const) {
      const result = await fetchProviderModels(request, async (url, init) => {
        expect(url).toBe(request.modelsUrl);
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Bearer sk-test');
        expect(headers.has('x-api-key') || headers.has('anthropic-version')).toBe(false);
        return fakeResponse(status, JSON.stringify(body));
      });
      expect(result.ok).toBe(ok);
      if (ok) expect(result.models?.map(m => m.id)).toEqual('data' in body ? body.data.map(m => 'id' in m ? m.id : undefined) : []);
    }
    for (const modelsUrl of [request.modelsUrl + '?filter=chat', 'https://inference.hinoki.security.evil.test/v1/models']) {
      expect(await fetchProviderModels({ ...request, baseUrl: new URL(modelsUrl).origin + '/v1', modelsUrl },
        async () => fakeResponse(200, '{"data":[]}'))).toMatchObject({ ok: false });
    }
  });
  // Provider onboarding contract: real discovery entry, no new preset/schema flag.
  // Previously a valid empty Magpie catalog was indistinguishable from malformed data.
  it.each(['claude-code', 'codex', 'pi'] as const)
  ('recognizes an empty Magpie catalog for %s without sending credentials to hello', async agent => {
    const result = await fetchProviderModels(spec({ agent,
      baseUrl: agent === 'claude-code' ? 'http://127.0.0.1:3425' : 'http://127.0.0.1:3425/v1',
    }), async (url, init) => {
      if (url === 'http://127.0.0.1:3425/v1/models') {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test');
        return fakeResponse(200, JSON.stringify({ object: 'list', data: [] }));
      }
      expect(url).toBe('http://127.0.0.1:3425/api/hello');
      expect(init?.headers).toBeUndefined();
      expect(init?.redirect).toBe('error');
      return fakeResponse(200, JSON.stringify({ name: 'magpie' }));
    });
    expect(result).toEqual({ ok: true, models: [] });
  });

  it.each([
    { data: [{}] }, { models: [] }, { error: 'unavailable', data: [] },
    { error_code: 401, data: [] },
  ])('does not identify malformed or business-error empty catalogs as Magpie: %j', async body => {
    const fetcher = vi.fn(async () => fakeResponse(200, JSON.stringify(body)));
    expect(await fetchProviderModels(spec({ baseUrl: 'http://127.0.0.1:3425/v1' }), fetcher))
      .toMatchObject({ ok: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 200, body: { name: 'other' } },
    { status: 401, body: { name: 'magpie' } },
    { status: 200, body: { name: 'magpie', error: 'unavailable' } },
  ])('keeps an unconfirmed gateway empty response conservative: %j', async hello => {
    expect(await fetchProviderModels(spec({ baseUrl: 'https://relay.example/v1' }), async url =>
      fakeResponse(String(url).endsWith('/api/hello') ? hello.status : 200,
        JSON.stringify(String(url).endsWith('/api/hello') ? hello.body : { data: [] }))))
      .toMatchObject({ ok: false });
  });

  it.each(['claude-code', 'codex', 'pi'] as const)
  ('accepts an empty official Ollama Cloud catalog for %s without a caller opt-in', async agent => {
    const request = spec({ agent, baseUrl: agent === 'claude-code' ? 'https://ollama.com' : 'https://ollama.com/v1',
      modelsUrl: 'https://ollama.com/v1/models',
      wireProtocol: agent === 'claude-code' ? 'anthropic-messages' : 'openai-chat' });
    expect(request.allowEmpty).toBeUndefined();
    const result = await fetchProviderModels(request, async (url, init) => {
      expect(url).toBe('https://ollama.com/v1/models');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test');
      return fakeResponse(200, JSON.stringify({ object: 'list', data: [] }));
    });
    expect(result).toEqual({ ok: true, models: [] });
  });

  it.each([{}, { data: [{}] }, { data: [null] }, { data: [{ id: '' }] }, { models: [] },
    { error: 'invalid key' }, { error: 'invalid key', data: [] },
    { error: { message: 'service unavailable' }, data: [] }])
  ('does not turn an Ollama Cloud malformed or business-error response into empty success: %j', async body => {
    for (const allowEmpty of [undefined, true]) {
      const request = spec({ baseUrl: 'https://ollama.com/v1', modelsUrl: 'https://ollama.com/v1/models', allowEmpty });
      expect(await fetchProviderModels(request, async () => fakeResponse(200, JSON.stringify(body))))
        .toMatchObject({ ok: false, code: 'UNKNOWN', status: 200 });
    }
  });

  it('keeps Ollama Cloud HTTP errors and filtered/other-host empty views distinct', async () => {
    expect(await fetchProviderModels(spec({ baseUrl: 'https://ollama.com/v1', modelsUrl: 'https://ollama.com/v1/models' }),
      async () => fakeResponse(401, JSON.stringify({ error: 'invalid key', data: [] }))))
      .toMatchObject({ ok: false, status: 401 });
    for (const modelsUrl of ['https://ollama.com/v1/models?filter=chat', 'https://relay.example/v1/models']) {
      expect(await fetchProviderModels(spec({ baseUrl: new URL(modelsUrl).origin + '/v1', modelsUrl }),
        async () => fakeResponse(200, JSON.stringify({ data: [] }))))
        .toMatchObject({ ok: false, code: 'UNKNOWN', status: 200 });
    }
  });

  it('distinguishes an empty OpenHubs account inventory from HTTP 200 business failures', async () => {
    const request = spec({ agent: 'pi', baseUrl: 'https://openhubs.zhidemai.com/v1',
      modelsUrl: 'https://openhubs.zhidemai.com/v1/models', wireProtocol: 'openai-chat', allowEmpty: true });
    for (const body of [{ error_code: 0, data: [] }, { error_code: 401, data: [] }, { error: { message: 'invalid key' }, data: [] }]) {
      const result = await fetchProviderModels(request, async (_url, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Bearer sk-test');
        expect(headers.has('anthropic-version')).toBe(false);
        return fakeResponse(200, JSON.stringify(body));
      });
      expect(result.ok).toBe(body.error_code === 0);
      if (result.ok) expect(result.models).toEqual([]);
    }
  });
  it('passes redirect rejection with all credentials to the transport', async () => {
    const fetcher = vi.fn(async (_url, init) => {
      expect(init.redirect).toBe('error');
      expect(init.headers).toMatchObject({ 'x-api-key': 'sk-test', 'x-secret': 'fake-secret' });
      throw new TypeError('redirect rejected');
    });
    expect(await fetchProviderModels(spec({ redirect: 'error', headers: { 'X-Secret': 'fake-secret' } }), fetcher)).toMatchObject({ ok: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([200, 400])('cancels oversized streamed %i responses even with a false content length', async (status) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(9)); },
      cancel,
    });
    const response = new Response(body, { status, headers: { 'content-length': '1' } });
    const result = await fetchProviderModels(spec({ responseByteLimit: 16 }), vi.fn(async () => response));
    expect(result.ok).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects oversized declared bodies without reading and accepts bounded JSON', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '100' } });
    expect((await fetchProviderModels(spec({ responseByteLimit: 32 }), vi.fn(async () => response))).ok).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(await fetchProviderModels(spec({ responseByteLimit: 32 }), vi.fn(async () => fakeResponse(200, '{"data":["model"]}')))).toMatchObject({ ok: true, models: [{ id: 'model' }] });
  });
});

describe('buildModelsFetchRequest', () => {
  it('discovers ElevenLabs speech capabilities through the existing custom-header connection', async () => {
    const result = await fetchProviderModels(spec({ agent: 'codex', apiKey: undefined,
      baseUrl: 'https://api.elevenlabs.io/v1', headers: { 'xi-api-key': 'fake-elevenlabs-key' },
    }), async (url, init) => {
      expect(url).toBe('https://api.elevenlabs.io/v1/models');
      expect(init?.headers).toEqual({ 'xi-api-key': 'fake-elevenlabs-key' });
      return fakeResponse(200, JSON.stringify([
        { model_id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2', can_do_text_to_speech: true },
        { model_id: 'voice-conversion', can_do_text_to_speech: false, can_do_voice_conversion: true },
      ]));
    });
    expect(result).toMatchObject({ ok: true, models: [
      { id: 'eleven_multilingual_v2', discoveredMetadata: { mode: 'audio_speech' } },
      { id: 'voice-conversion', discoveredMetadata: { mode: 'other' } },
    ] });
  });

  it('discovers Sub2API Codex capabilities at the backend path', async () => {
    const result = await fetchProviderModels(spec({ agent: 'codex',
      baseUrl: 'https://sub2api.example/backend-api/codex', wireProtocol: 'openai-responses',
    }), async (url, init) => {
      expect(url).toBe('https://sub2api.example/backend-api/codex/models');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer sk-test' });
      return fakeResponse(200, JSON.stringify({ models: [{ slug: 'gpt-6-sol',
        supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }], default_reasoning_level: 'high',
      }] }));
    });
    expect(result).toMatchObject({ ok: true, models: [{ id: 'gpt-6-sol',
      discoveredMetadata: { efforts: ['high', 'max'], defaultEffort: 'high' },
    }] });
  });

  it.each(['claude-code', 'codex', 'pi'] as const)('uses the complete OpenRouter catalog for %s without Anthropic ID rewriting', async (agent) => {
    const request = buildModelsFetchRequest(spec({
      agent,
      baseUrl: agent === 'claude-code' ? 'https://openrouter.ai/api' : 'https://openrouter.ai/api/v1',
      headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'old-test-key' },
    }));
    expect(request.url).toBe('https://openrouter.ai/api/v1/models');
    expect(request.init.headers).toEqual({ authorization: 'Bearer sk-test' });
    const result = await fetchProviderModels(spec({ agent, baseUrl: 'https://openrouter.ai/api' }),
      async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        return fakeResponse(200, JSON.stringify({ data: headers['anthropic-version']
          ? [{ id: 'anthropic/openai/model[1m]' }]
          : [{ id: 'openai/model', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, pricing: { prompt: '0.000001', completion: '0.000002' } }] }));
      });
    expect(result.models?.[0]).toMatchObject({ id: 'openai/model', discoveredCost: { input: 1, output: 2 },
      discoveredMetadata: { supportsImageInput: true } });
  });
  it.each(
    (['baseUrl', 'modelsUrl'] as const).flatMap((field) =>
      ['user@', ':secret@', 'user:secret@', 'us%65r:s%65cret@'].map((userinfo) => ({
        field,
        userinfo,
      })),
    ),
  )('rejects credentials in $field before building a request: $userinfo', ({ field, userinfo }) => {
    expect(() =>
      buildModelsFetchRequest(
        spec({
          [field]: `https://${userinfo}api.acme.example/anthropic/v1/models`,
        }),
      ),
    ).toThrow('model discovery requires HTTP(S) URLs without embedded credentials');
  });

  it('derives {base}/v1/models for non-/vN baseUrl; appends /models when baseUrl ends with /vN', () => {
    expect(buildModelsFetchRequest(spec()).url).toBe(
      'https://api.acme.example/anthropic/v1/models',
    );
    expect(
      buildModelsFetchRequest(spec({ agent: 'codex', baseUrl: 'https://openrouter.ai/api/v1' }))
        .url,
    ).toBe('https://openrouter.ai/api/v1/models');
  });

  it('preserves base URL query parameters while appending the discovery pathname', () => {
    expect(
      buildModelsFetchRequest(
        spec({ agent: 'codex', baseUrl: 'https://openrouter.ai/api/v1?tenant=a#ignored' }),
      ).url,
    ).toBe('https://openrouter.ai/api/v1/models?tenant=a');
  });

  it('explicit modelsUrl wins over derivation only when same-host as baseUrl', () => {
    // 同主机（Moonshot 形态：baseUrl …/anthropic，列模型在同 host 的 /v1/models）→ 采用。
    expect(
      buildModelsFetchRequest(
        spec({
          baseUrl: 'https://api.moonshot.cn/anthropic',
          modelsUrl: 'https://api.moonshot.cn/v1/models',
        }),
      ).url,
    ).toBe('https://api.moonshot.cn/v1/models');
    // 跨主机（用户改了 baseUrl、快照仍指旧主机）→ 忽略隐藏字段，回退 baseUrl 推导，防 key 误投。
    expect(
      buildModelsFetchRequest(spec({ modelsUrl: 'https://api.moonshot.cn/v1/models' })).url,
    ).toBe('https://api.acme.example/anthropic/v1/models');
  });

  it('cc wire sends anthropic-version + x-api-key + Bearer; codex wire sends Bearer only', () => {
    const cc = buildModelsFetchRequest(
      spec({
        headers: {
          Authorization: 'Bearer stale',
          'X-API-Key': 'stale',
          'x-extra': '1',
        },
      }),
    ).init.headers as Record<string, string>;
    expect(cc['anthropic-version']).toBe('2023-06-01');
    expect(cc['x-api-key']).toBe('sk-test');
    expect(cc['authorization']).toBe('Bearer sk-test');
    expect(cc.Authorization).toBeUndefined();
    expect(cc['X-API-Key']).toBeUndefined();
    expect(cc['x-extra']).toBe('1');

    const codex = buildModelsFetchRequest(spec({ agent: 'codex' })).init.headers as Record<
      string,
      string
    >;
    expect(codex['anthropic-version']).toBeUndefined();
    expect(codex['x-api-key']).toBeUndefined();
    expect(codex['authorization']).toBe('Bearer sk-test');
  });

  it('Codex Anthropic Messages bridge sends provider-owned x-api-key and Bearer', () => {
    const headers = buildModelsFetchRequest(
      spec({
        agent: 'codex',
        wireProtocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        headers: { 'Anthropic-Version': 'custom-version' },
      }),
    ).init.headers as Record<string, string>;
    expect(headers['anthropic-version']).toBe('custom-version');
    expect(headers['Anthropic-Version']).toBeUndefined();
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers.authorization).toBe('Bearer sk-test');
  });

  it('omits auth headers without apiKey and keeps custom headers', () => {
    const h = buildModelsFetchRequest(spec({ apiKey: null, headers: { 'x-extra': '1' } })).init
      .headers as Record<string, string>;
    expect(h['x-api-key']).toBeUndefined();
    expect(h['authorization']).toBeUndefined();
    expect(h['x-extra']).toBe('1');
  });

  it.each(['none', 'oauth'] as const)(
    'strips legacy credential headers for %s auth even without an apiKey',
    (authMethod) => {
      const h = buildModelsFetchRequest(
        spec({
          authMethod,
          apiKey: null,
          headers: {
            Authorization: 'Bearer legacy',
            'X-API-Key': 'legacy',
            'x-extra': '1',
          },
        }),
      ).init.headers as Record<string, string>;

      expect(h.Authorization).toBeUndefined();
      expect(h['X-API-Key']).toBeUndefined();
      expect(h.authorization).toBeUndefined();
      expect(h['x-api-key']).toBeUndefined();
      expect(h['x-extra']).toBe('1');
    },
  );
});

describe('fetchProviderModels', () => {
  it.each(
    (['baseUrl', 'modelsUrl'] as const).flatMap((field) =>
      ['user@', ':secret@', 'user:secret@', 'us%65r:s%65cret@'].map((userinfo) => ({
        field,
        userinfo,
      })),
    ),
  )(
    'does not dispatch a request with credentials in $field: $userinfo',
    async ({ field, userinfo }) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const result = await fetchProviderModels(
        spec({
          [field]: `https://${userinfo}api.acme.example/anthropic/v1/models`,
          authMethod: 'apiKey',
        }),
        fetchImpl,
      );
      expect(result).toEqual({
        ok: false,
        code: 'UNKNOWN',
        detail: 'model discovery requires HTTP(S) URLs without embedded credentials',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      baseUrl: 'https://remote.example/v1',
      modelsUrl: null,
    },
    {
      baseUrl: 'http://127.0.0.1:4000/v1',
      modelsUrl: 'https://remote.example/v1/models',
    },
  ])('returns a structured failure for non-loopback no-auth discovery: %j', async (urls) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await fetchProviderModels(
      spec({
        ...urls,
        authMethod: 'none',
        apiKey: null,
      }),
      fetchImpl,
    );

    expect(result).toEqual({
      ok: false,
      code: 'UNKNOWN',
      detail: 'no-auth provider model discovery requires loopback URLs',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('parses OpenAI {data:[{id}]} shape, preferring display_name/name for labels', async () => {
    const r = await fetchProviderModels(spec(), async () =>
      fakeResponse(
        200,
        JSON.stringify({
          data: [
            { id: 'kimi-k3', display_name: 'Kimi K3' },
            { id: 'kimi-k2.6', name: 'Kimi K2.6' },
            { id: 'kimi-k2.6' }, // 重复 id 去重
            { id: 'bare-id' },
          ],
        }),
      ),
    );
    expect(r.ok).toBe(true);
    expect(r.models).toEqual([
      { id: 'kimi-k3', name: 'Kimi K3', discoveredMetadata: { name: 'Kimi K3' } },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', discoveredMetadata: { name: 'Kimi K2.6' } },
      { id: 'bare-id', name: 'bare-id', discoveredMetadata: {} },
    ]);
  });

  it('parses {models:[...]} and plain string-array shapes', async () => {
    const a = await fetchProviderModels(spec(), async () =>
      fakeResponse(200, JSON.stringify({ models: [{ id: 'm1' }] })),
    );
    expect(a.models).toEqual([{ id: 'm1', name: 'm1', discoveredMetadata: {} }]);

    const b = await fetchProviderModels(spec(), async () =>
      fakeResponse(200, JSON.stringify({ data: ['m1', 'm2'] })),
    );
    expect(b.models).toEqual([
      { id: 'm1', name: 'm1', discoveredMetadata: {} },
      { id: 'm2', name: 'm2', discoveredMetadata: {} },
    ]);
  });

  it('parses GLM Responses catalog entries keyed by slug', async () => {
    const result = await fetchProviderModels(spec({ agent: 'codex' }), async () =>
      fakeResponse(
        200,
        JSON.stringify({
          models: [{ slug: 'glm-5.3', display_name: 'GLM-5.3', context_window: 202_752 }],
        }),
      ),
    );

    expect(result.models).toEqual([
      {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        contextWindow: 202_752,
        discoveredMetadata: { name: 'GLM-5.3', contextWindow: 202_752 },
      },
    ]);
  });

  it('classifies 401 as AUTH_INVALID with status', async () => {
    const r = await fetchProviderModels(spec(), async () =>
      fakeResponse(401, JSON.stringify({ error: { message: 'invalid api key' } })),
    );
    expect(r).toMatchObject({ ok: false, code: 'AUTH_INVALID', status: 401 });
  });

  it('classifies network failure as UPSTREAM_UNREACHABLE', async () => {
    const r = await fetchProviderModels(spec(), async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    expect(r).toMatchObject({ ok: false, code: 'UPSTREAM_UNREACHABLE' });
  });

  it('returns non-ok UNKNOWN for 200 with unrecognized / empty payload', async () => {
    const empty = await fetchProviderModels(spec(), async () =>
      fakeResponse(200, JSON.stringify({ data: [] })),
    );
    expect(empty).toMatchObject({ ok: false, code: 'UNKNOWN' });
    const weird = await fetchProviderModels(spec(), async () => fakeResponse(200, '"not-a-list"'));
    expect(weird).toMatchObject({ ok: false, code: 'UNKNOWN' });
    const notJson = await fetchProviderModels(spec(), async () => fakeResponse(200, '<html>'));
    expect(notJson).toMatchObject({ ok: false, code: 'UNKNOWN' });
  });

  it('end-to-end asserts the request URL and auth headers reach fetch', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    await fetchProviderModels(
      spec({
        baseUrl: 'https://api.moonshot.cn/anthropic',
        modelsUrl: 'https://api.moonshot.cn/v1/models',
      }),
      async (url, init) => {
        seenUrl = String(url);
        seenHeaders = (init?.headers ?? {}) as Record<string, string>;
        return fakeResponse(200, JSON.stringify({ data: [{ id: 'kimi-k3' }] }));
      },
    );
    expect(seenUrl).toBe('https://api.moonshot.cn/v1/models');
    expect(seenHeaders['x-api-key']).toBe('sk-test');
    expect(seenHeaders['anthropic-version']).toBe('2023-06-01');
  });

  it('end-to-end Codex Anthropic discovery uses the Messages authentication headers', async () => {
    let seenHeaders: Record<string, string> = {};
    const result = await fetchProviderModels(
      spec({
        agent: 'codex',
        wireProtocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
      }),
      async (_url, init) => {
        seenHeaders = (init?.headers ?? {}) as Record<string, string>;
        return fakeResponse(200, JSON.stringify({ data: [{ id: 'claude-opus-5' }] }));
      },
    );
    expect(result.ok).toBe(true);
    expect(seenHeaders['x-api-key']).toBe('sk-test');
    expect(seenHeaders.authorization).toBe('Bearer sk-test');
    expect(seenHeaders['anthropic-version']).toBe('2023-06-01');
  });
});


it('discovers native Google models with Google auth and exact declared limits', async () => {
  const result = await fetchProviderModels(spec({ agent: 'pi', wireProtocol: 'google-generative-ai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    headers: { authorization: 'Bearer stale', 'x-goog-api-key': 'stale' },
  }), async (url, init) => {
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(init?.headers).toEqual({ 'x-goog-api-key': 'sk-test' });
    return fakeResponse(200, JSON.stringify({ models: [{ name: 'models/new-gemini', displayName: 'New Gemini',
      supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536 }] }));
  });
  expect(result).toMatchObject({ ok: true, models: [{ id: 'new-gemini', name: 'New Gemini', contextWindow: 1048576,
    discoveredMetadata: { contextWindow: 1048576, maxOutputTokens: 65536 } }] });
});


it('uses Bearer discovery for LongCat Messages without moving its inference endpoint', () => {
  const result = buildModelsFetchRequest(spec({ baseUrl: 'https://api.longcat.chat/anthropic',
    modelsUrl: 'https://api.longcat.chat/openai/v1/models', wireProtocol: 'anthropic-messages',
    headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'fixture-beta' } }));
  expect(result.url).toBe('https://api.longcat.chat/openai/v1/models');
  const headers = new Headers(result.init.headers);
  expect(headers.get('authorization')).toBe('Bearer sk-test');
  expect(headers.has('anthropic-version')).toBe(false);
  expect(headers.has('x-api-key')).toBe(false);
});


it('retains LongCat legacy header-only credentials when selecting its Bearer catalog', () => {
  const result = buildModelsFetchRequest(spec({ baseUrl: 'https://api.longcat.chat/anthropic',
    modelsUrl: 'https://api.longcat.chat/openai/v1/models', wireProtocol: 'anthropic-messages',
    apiKey: null, headers: { 'x-api-key': 'fixture-legacy-key' } }));
  const headers = new Headers(result.init.headers);
  expect(headers.get('authorization')).toBe('Bearer fixture-legacy-key');
  expect(headers.has('x-api-key')).toBe(false);
});

it.each(['claude-code', 'codex', 'pi'] as const)('discovers Google native catalog from a saved compatibility entry (%s)', agent => {
  const request = buildModelsFetchRequest(spec({ agent,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', wireProtocol: 'openai-chat' }));
  expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
  expect(request.init.headers).toMatchObject({ 'x-goog-api-key': 'sk-test' });
  expect(request.init.headers).not.toHaveProperty('anthropic-version');
});

it('does not rewrite private Google-compatible discovery or an explicit catalog', () => {
  expect(buildModelsFetchRequest(spec({ baseUrl: 'https://private.example/v1beta/openai', wireProtocol: 'openai-chat' })).url)
    .toBe('https://private.example/v1beta/openai/v1/models');
  expect(buildModelsFetchRequest(spec({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelsUrl: 'https://generativelanguage.googleapis.com/custom/models', wireProtocol: 'openai-chat' })).url)
    .toBe('https://generativelanguage.googleapis.com/custom/models');
});

 it('normalizes the real bundled Google discovery URL for all generated harnesses', async () => {
  const { BUNDLED_CATALOG } = await import('@cindy/model-providers');
  const preset = (BUNDLED_CATALOG.presets ?? []).find(p => p.id === 'google-gemini-api')!;
  for (const agent of ['claude-code', 'codex', 'pi'] as const) {
    const runtime = preset.runtimes[agent]!;
    const request = buildModelsFetchRequest(spec({ agent, baseUrl: runtime.baseUrl,
      modelsUrl: runtime.modelsUrl, wireProtocol: runtime.wireProtocol }));
    expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(request.init.headers).toMatchObject({ 'x-goog-api-key': 'sk-test' });
  }
});

it.each([404, 405])('falls back from an unavailable manifest (%i) on the same authenticated endpoint', async status => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(fakeResponse(status, '{}'))
    .mockResolvedValueOnce(fakeResponse(200, '{"data":[{"id":"grok-4.7","reasoningEfforts":["low","high"]}]}'));
  const result = await fetchProviderModels(spec({ baseUrl: 'https://relay.example/proxy/v1',
    modelsUrl: 'https://relay.example/proxy/v1/models?client_version=0.147.0&tenant=test',
  }), fetcher);
  expect(result).toMatchObject({ ok: true, models: [{ id: 'grok-4.7', discoveredMetadata: { efforts: ['low', 'high'] } }] });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toBe('https://relay.example/proxy/v1/models?tenant=test');
  expect(fetcher.mock.calls[1][1].headers).toEqual(fetcher.mock.calls[0][1].headers);
});

it.each([401, 403, 429, 503])('does not disguise manifest authorization or availability failures (%i)', async status => {
  const fetcher = vi.fn(async () => fakeResponse(status, '{}'));
  const result = await fetchProviderModels(spec({ modelsUrl: 'https://relay.example/v1/models?client_version=0.147.0' }), fetcher);
  expect(result.ok).toBe(false);
  expect(fetcher).toHaveBeenCalledOnce();
});

describe('ElevenLabs catalog authentication', () => {
  it('uses xi-api-key on the official endpoint even when stored in an Anthropic runtime', () => {
    const result = buildModelsFetchRequest(spec({
      baseUrl: 'https://api.elevenlabs.io/v1', apiKey: 'fake-eleven-key', authMethod: 'apiKey',
      headers: { Authorization: 'stale', 'X-Api-Key': 'stale', 'Xi-Api-Key': 'stale', 'anthropic-version': 'stale' },
    }));
    expect(result.url).toBe('https://api.elevenlabs.io/v1/models');
    expect(result.init.headers).toEqual({ 'xi-api-key': 'fake-eleven-key' });
  });
  it('does not guess ElevenLabs authentication for a custom host or leak a stale key in no-auth mode', () => {
    const custom = buildModelsFetchRequest(spec({ agent: 'codex', baseUrl: 'https://elevenlabs.example/v1', apiKey: 'fake-key' }));
    expect(custom.init.headers).toEqual({ authorization: 'Bearer fake-key' });
    const noAuth = buildModelsFetchRequest(spec({ baseUrl: 'https://api.elevenlabs.io/v1', apiKey: undefined, authMethod: 'none', headers: { 'Xi-Api-Key': 'stale' } }));
    expect(noAuth.init.headers).toEqual({});
  });
});
