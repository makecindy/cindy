import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectProviderDeployment } from '../provider-detection.js';
// Protects scheme-2 request budgets/credential scope through the real discovery transport.
// Existing fetch tests do not dispatch identity probes. Missing/hostile diagnostics are the
// smallest failure inputs; unit injection avoids network and services. No real credentials.
const spec = { agent: 'pi' as const, authMethod: 'apiKey' as const, baseUrl: 'https://relay.example/team/v1', apiKey: 'fake-test-key', headers: { 'X-Project': 'example' } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.useRealTimers());

describe('bounded deployment detection', () => {
  it('recognizes Sub2API without exposing billing data and reuses the account directory', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url).startsWith('https://relay.example/team/')).toBe(true);
      expect(init?.redirect).toBe('error');
      if (String(url).endsWith('/v1/models')) return json({ data: [{ id: 'private-model' }] });
      if (String(url).endsWith('/settings/public')) {
        expect(init?.headers).toEqual({});
        return json({ code: 0, data: { version: '0.2.17', hide_ccs_import_button: false, backend_mode_enabled: true, subscription_enabled: false } });
      }
      if (String(url).endsWith('/sub2api/billing')) {
        expect(init?.headers).toEqual({ Authorization: 'Bearer fake-test-key', 'X-Project': 'example' });
        return json({ object: 'sub2api.key_billing', schema_version: 1, balance: 'must-not-return' });
      }
      return json({ error: 'not found' }, 404);
    });
    const result = await detectProviderDeployment(spec, new AbortController().signal, fetcher);
    expect(result).toMatchObject({ candidates: ['sub2api'], reason: 'matched', catalog: { ok: true, models: [{ id: 'private-model' }] } });
    expect(JSON.stringify(result)).not.toMatch(/must-not-return|fake-test-key/);
    expect(fetcher.mock.calls.filter(([url]) => String(url) === spec.baseUrl + '/models')).toHaveLength(1);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(9);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/health'))).toBe(false);
  });
  it.each(['lmstudio', 'llamacpp'])('does not let an early %s match hide a later Sub2API conflict', async early => {
    const bodies: Record<string, unknown> = {
      '/v1/models': { data: [{ id: 'one' }] },
      '/api/v1/settings/public': { code: 0, data: { version: '0.2.17', hide_ccs_import_button: false, backend_mode_enabled: true, subscription_enabled: false } },
      '/v1/sub2api/billing': { object: 'sub2api.key_billing', schema_version: 1 },
      ...(early === 'lmstudio' ? { '/lmstudio-greeting': { lmstudio: true }, '/api/v1/models': { models: [] } }
        : { '/props': { default_generation_settings: {}, total_slots: 1, build_info: 'b11723' } }),
    };
    const result = await detectProviderDeployment(spec, new AbortController().signal, async url => {
      const body = bodies[new URL(String(url)).pathname.replace(/^\/team/, '')];
      return body ? json(body) : json({ error: 'not found' }, 404);
    });
    expect(result.reason).toBe('conflict');
    expect(result.candidates).toEqual(expect.arrayContaining([early, 'sub2api']));
    expect(result.catalog).toMatchObject({ ok: true, models: [{ id: 'one' }] });
  });
  it.each([401, 403, 404, 429, 200])('keeps usable models when diagnostics fail with %s', async status => {
    const result = await detectProviderDeployment(spec, new AbortController().signal, async url =>
      String(url).endsWith('/v1/models') ? json({ data: [{ id: 'company-chat' }] }) : json({ error: 'unavailable' }, status));
    expect(result).toMatchObject({ candidates: [], catalog: { ok: true, models: [{ id: 'company-chat' }] } });
  });
  it('skips required Bearer diagnostics without a key; public probes carry no custom headers', async () => {
    const urls: string[] = [];
    await detectProviderDeployment({ ...spec, apiKey: undefined }, new AbortController().signal, async (url, init) => {
      urls.push(String(url));
      if (/greeting|\/version|settings\/public/.test(String(url))) expect(init?.headers).toEqual({});
      return json({ error: 'not found' }, 404);
    });
    expect(urls.some(url => /sub2api\/billing|model\/info|readiness/.test(url))).toBe(false);
  });
  it('does not probe query tokens or full generation URLs', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const baseUrl of ['https://relay.example/team/v1?token=fake', 'https://relay.example/v1/chat/completions']) {
      expect(await detectProviderDeployment({ ...spec, baseUrl }, new AbortController().signal, fetcher)).toEqual({ candidates: [], reason: 'insufficient_evidence' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects oversized identity bodies and redirects without losing the directory', async () => {
    const result = await detectProviderDeployment(spec, new AbortController().signal, async url => {
      if (String(url).endsWith('/v1/models')) return json({ data: [] });
      return String(url).endsWith('/props') ? json({ padding: 'x'.repeat(1024 * 1024) }) : new Response(null, { status: 302, headers: { location: 'https://other.example' } });
    });
    expect(result).toMatchObject({ candidates: [], catalog: { ok: true, models: [] } });
  });
  it('limits identity concurrency to two and aborts queued work when the draft closes', async () => {
    const controller = new AbortController();
    let active = 0, peak = 0, calls = 0;
    const started: (() => void)[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls++;
      if (String(url).endsWith('/v1/models')) return json({ data: [] });
      active++; peak = Math.max(peak, active);
      return new Promise((_resolve, reject) => {
        const abort = () => { active--; reject(new DOMException('Aborted', 'AbortError')); };
        init?.signal?.addEventListener('abort', abort, { once: true });
        started.push(() => undefined);
      });
    };
    const promise = detectProviderDeployment(spec, controller.signal, fetcher);
    expect(started).toHaveLength(2);
    controller.abort();
    expect(await promise).toMatchObject({ catalog: undefined });
    expect(peak).toBe(2);
    expect(calls).toBe(3);
  });
});

it('ends identity work at eight seconds with two concurrent three-second requests', async () => {
  vi.useFakeTimers();
  const requests: number[] = [];
  const timeouts: number[] = [];
  const result = detectProviderDeployment(spec, new AbortController().signal, async (url, init) => {
    if (String(url) === spec.baseUrl + '/models') return json({ data: [] });
    requests.push(Date.now());
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  }, ms => {
    timeouts.push(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  await vi.advanceTimersByTimeAsync(7999);
  expect(requests).toHaveLength(6);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ reason: 'budget_exhausted', catalog: { ok: true } });
  expect(timeouts).toEqual([8000, 3000, 3000, 3000, 3000, 3000, 3000]);
});

it('settles already dispatched evidence before accepting a match', async () => {
  let finishProps!: () => void;
  let versionRead!: () => void;
  const reachedVersion = new Promise<void>(resolve => { versionRead = resolve; });
  const result = detectProviderDeployment(spec, new AbortController().signal, async url => {
    if (String(url) === spec.baseUrl + '/models') return json({ data: [{ id: 'model', root: 'weights', owned_by: 'vllm', max_model_len: 8192 }] });
    if (String(url).endsWith('/props')) return new Promise(resolve => {
      finishProps = () => resolve(json({ default_generation_settings: {}, total_slots: 1, build_info: 'b11723' }));
    });
    if (String(url).endsWith('/version')) { versionRead(); return json({ version: 'source.test' }); }
    return json({ error: 'not found' }, 404);
  });
  await reachedVersion;
  finishProps();
  expect(await result).toMatchObject({ reason: 'conflict', candidates: ['llamacpp', 'vllm'] });
});
