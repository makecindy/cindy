import { runInNewContext } from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PI_CACHE_RECOVERY_SOURCE } from '../cache-recovery-source.js';

// Unit: real generated provider wrapper, not a duplicate classifier. Protects
// opaque-400 recovery, one input budget, final hook comparison and TTL storage.
const model = { provider: 'fixture', id: 'wire', api: 'openai-completions', baseUrl: 'http://127.0.0.1/v1' };
const routeKey = 'a'.repeat(64);
const key = JSON.stringify(['connection', 'wire', routeKey]);
const body = { model: 'wire', messages: [{ role: 'user', content: 'OK' }], prompt_cache_key: 'cache', prompt_cache_retention: '24h' };
const failure = (text = '400: {"error":{"message":"opaque refusal","param":null,"type":"invalid_request_error"}}') => ({
  type: 'error', error: { role: 'assistant', content: [], stopReason: 'error', errorMessage: text, usage: { output: 0 } },
});
const success = { type: 'done', message: { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }], usage: { input: 3, output: 1, cacheRead: 2 } } };
const modernRegistry = { getProvider() {}, getRegisteredNativeProvider() {} };
function fixture(legacy = false) {
  let now = 1000000000;
  const files = new Map<string, string>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const rules = [{ ...model, providerId: 'connection', routeKey }];
  files.set('/agent/pi-cache-compatibility.json', JSON.stringify(rules));
  let writeFails = false;
  const removalFailures = new Map<string, (name: string) => string | undefined>();
  const deadPids = new Set<number>();
  const fs = {
    mkdirSync() {}, rmdirSync() {}, closeSync() {}, readdirSync: () => [],
    openSync: (name: string) => {
      if (files.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(name, ''); return name;
    },
    linkSync: (from: string, to: string) => { files.set(to, files.get(from)!); },
    lstatSync: (name: string) => fs.statSync(name),
    statSync: (name: string) => {
      if (!files.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { size: Buffer.byteLength(files.get(name)!), mtimeMs: 1000, dev: 1, ino: 1, isFile: () => true };
    },
    readFileSync: (name: string) => { fs.statSync(name); return files.get(name); },
    writeFileSync: (name: string, text: string) => { if (writeFails) throw new Error('read-only'); files.set(name, text); },
    renameSync: (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
    rmSync: (name: string) => {
      const code = (removalFailures.get(name) ?? removalFailures.get('*'))?.(name);
      if (code) throw Object.assign(new Error('fixture removal failure'), { code });
      files.delete(name);
    },
  };
  const api = runInNewContext(PI_CACHE_RECOVERY_SOURCE + '\ninstallCindyCacheRecovery(pi)', {
    pi: { on: (name: string, fn: (...args: any[]) => void) => handlers.set(name, fn) },
    process: { pid: 123, uptime: () => 1, kill(pid: number) {
      if (deadPids.has(pid)) throw Object.assign(new Error('dead'), { code: 'ESRCH' });
    }, env: { PI_CODING_AGENT_DIR: '/agent', CINDY_PI_CACHE_COMPAT_FILE: '/compat.json' } },
    // The in-memory filesystem uses POSIX keys on every host, including Windows.
    ...fs, path: path.posix, createHash, randomUUID, Buffer, setTimeout, clearTimeout, Date: { now: () => now }, homedir: () => '/home/fixture',
  });
  if (!legacy) api.ownRegistry(modernRegistry);
  const startUser = (direct = true, followUp = false) => {
    if (direct) handlers.get('before_agent_start')?.({});
    handlers.get('message_start')?.({ message: { role: 'user', content: [{ type: 'text', text: 'OK' }] } }, {
      mode: 'rpc', modelRegistry: legacy ? {} : modernRegistry,
      ui: { input: async (_title: string, raw: string) => JSON.stringify({ key: JSON.parse(raw).key, followUp }) },
    });
  };
  const fresh = () => { handlers.get('input')!({ source: 'rpc' }, { isIdle: () => true }); startUser(); };
  const interrupt = () => handlers.get('input')!({ source: 'rpc', streamingBehavior: 'steer' }, { isIdle: () => false });
  const sent: any[] = [];
  let invocation = 0;
  const request = async (events: any[] = [failure(), success], options: any = {}, prepare?: (n: number) => void, selectedModel = model) => {
    const invoke = async function* (opts: any) {
      const n = invocation++;
      prepare?.(n);
      try {
        const payload = await opts.onPayload(structuredClone(body), selectedModel);
        sent.push(payload);
      } catch (error) {
        yield failure(String(error));
        return;
      }
      const event = events[n] ?? events.at(-1);
      if (Array.isArray(event)) yield* event; else yield event;
    };
    const output = [];
    for await (const event of api.wrap(selectedModel, options, invoke)) output.push(event);
    return output;
  };
  return { api, handlers, fresh, startUser, interrupt, request, files, sent, failRemovals: (name: string, failure: (name: string) => string | undefined) => removalFailures.set(name, failure), deadPid: (pid: number) => deadPids.add(pid), clock: (value: number) => { now = value; },
    failWrites: () => { writeFails = true; }, record: () => JSON.parse(files.get('/compat.json') ?? '{"routes":{}}').routes[key] };
}

describe('Pi native cache recovery', () => {
  it.each(['EPERM', 'EBUSY', 'EACCES'])('releases a live-owner lock after transient %s without replaying generation', async code => {
    vi.useFakeTimers();
    try {
      const h = fixture();
      let failures = 1;
      h.failRemovals('/compat.json.lock', () => failures-- > 0 ? code : undefined);
      h.fresh();
      expect(await h.request()).toEqual([success]);
      expect(h.files.has('/compat.json.lock')).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.files.has('/compat.json.lock')).toBe(false);
      h.fresh(); await h.request([success]);
      expect(h.sent).toHaveLength(3);
      expect(h.sent[2]).not.toHaveProperty('prompt_cache_key');
    } finally { vi.useRealTimers(); }
  });

  it('recovers an exhausted release on the next input even after learning was persisted', async () => {
    vi.useFakeTimers();
    try {
      const h = fixture(); let denied = true;
      h.failRemovals('/compat.json.lock', () => denied ? 'EPERM' : undefined);
      h.fresh(); expect(await h.request()).toEqual([success]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.files.has('/compat.json.lock')).toBe(true);
      expect(h.record()).toBeDefined();
      expect(vi.getTimerCount()).toBe(0);
      denied = false; h.fresh();
      expect(h.files.has('/compat.json.lock')).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('retries removal of its reclaim gate without leaving a live-owner gate behind', async () => {
    vi.useFakeTimers();
    try {
      const h = fixture(); let failures = 1;
      h.deadPid(42);
      h.files.set('/compat.json.lock', JSON.stringify({ pid: 42, nonce: 'dead-owner' }));
      h.failRemovals('*', name => name.includes('.reclaim.d/') && failures-- > 0 ? 'EBUSY' : undefined);
      h.fresh(); expect(await h.request()).toEqual([success]);
      expect([...h.files.keys()].some(name => name.includes('.reclaim.d/'))).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect([...h.files.keys()].some(name => name.includes('.reclaim.d/'))).toBe(false);
      expect(h.files.has('/compat.json.lock')).toBe(false);
      expect(h.record()).toBeDefined();
    } finally { vi.useRealTimers(); }
  });

  it('does not remove a successor nonce during delayed release or next-input recovery', async () => {
    vi.useFakeTimers();
    try {
      const h = fixture();
      h.failRemovals('/compat.json.lock', () => 'EPERM');
      h.fresh(); expect(await h.request()).toEqual([success]);
      const successor = JSON.stringify({ pid: 123, nonce: 'successor', startedAt: 1000000000 });
      h.files.set('/compat.json.lock', successor);
      h.failRemovals('/compat.json.lock', () => undefined);
      await vi.advanceTimersByTimeAsync(1000); h.fresh();
      expect(h.files.get('/compat.json.lock')).toBe(successor);
    } finally { vi.useRealTimers(); }
  });

  it.each(['openai-completions', 'openai-responses'])('keeps learned payload recovery without taking provider ownership on an older %s registry', async api => {
    const h = fixture(true);
    const selected = { ...model, api };
    const rules = [{ ...selected, providerId: 'connection', routeKey }];
    h.files.set('/agent/pi-cache-compatibility.json', JSON.stringify(rules));
    h.fresh();
    const record = { supportsLongCacheRetention: false, learnedAt: 1000000000,
      expiresAt: 1086400000, evidence: 'opaque' };
    // Another session can learn after the last RPC input. Native continuation
    // has no new RPC input event, but its real user message starts a new input.
    h.files.set('/compat.json', JSON.stringify({ routes: { [key]: record } }));
    h.startUser();
    const ctx = { model: selected, modelRegistry: { getProvider: vi.fn() } };
    const hook = h.handlers.get('before_provider_request')!;
    const payload = { ...body, service_tier: 'priority' };
    expect((await hook?.({ payload }, ctx)) ?? payload).toEqual({ model: 'wire', messages: body.messages, service_tier: 'priority' });
    expect(ctx.modelRegistry.getProvider).not.toHaveBeenCalled();
    expect(payload).toHaveProperty('prompt_cache_key', 'cache');
    // A newly loaded bridge reads the same durable record, not process memory.
    const restarted = fixture(true);
    restarted.files.set('/agent/pi-cache-compatibility.json', JSON.stringify(rules));
    restarted.files.set('/compat.json', h.files.get('/compat.json')!);
    restarted.fresh();
    const recovered = restarted.handlers.get('before_provider_request')!;
    expect(await recovered({ payload }, ctx)).not.toHaveProperty('prompt_cache_key');
    expect(await recovered({ payload }, { ...ctx, model: { ...selected, baseUrl: selected.baseUrl + '/other' } })).toBeUndefined();
    restarted.api.ownRegistry(modernRegistry);
    expect(await recovered({ payload }, { ...ctx, modelRegistry: modernRegistry })).toBeUndefined();
    restarted.clock(1086400001);
    // Expiry cannot change a tool continuation in the already-started input.
    restarted.handlers.get('tool_execution_start')!();
    expect(await recovered({ payload }, ctx)).not.toHaveProperty('prompt_cache_key');
    restarted.startUser();
    expect(await recovered({ payload }, ctx)).toBeUndefined();
    expect(restarted.record()).toEqual(record);
  });

  it('preserves normal caching and bounds legacy records in the older registry payload hook', async () => {
    const h = fixture(true);
    const ctx = { model, modelRegistry: {} };
    const hook = () => h.handlers.get('before_provider_request')?.({ payload: body }, ctx);
    h.fresh();
    expect(await hook()).toBeUndefined();
    h.files.set('/compat.json', JSON.stringify({ routes: { [key]: { supportsLongCacheRetention: false } } }));
    h.clock(1001); h.fresh();
    expect(await hook()).toEqual({ model: 'wire', messages: body.messages });
    h.clock(1000 + 7 * 86400000 + 1); h.fresh();
    expect(await hook()).toBeUndefined();
  });

  it('does one final-payload comparison, learns only after generation, and preserves usage', async () => {
    const h = fixture(); h.fresh();
    const hook = vi.fn((payload: any) => ({ ...payload, third_party: 'preserved', service_tier: 'priority' }));
    const result = await h.request(undefined, { onPayload: hook });
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).toHaveProperty('prompt_cache_retention', '24h');
    expect(h.sent[1]).toEqual({ model: 'wire', messages: body.messages, third_party: 'preserved', service_tier: 'priority' });
    expect(result).toEqual([success]);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(h.record()).toMatchObject({ evidence: 'opaque', learnedAt: 1000000000, expiresAt: 1086400000 });
    h.fresh(); await h.request([success]);
    expect(h.sent[2]).not.toHaveProperty('prompt_cache_key');
    h.clock(1086400001); h.fresh(); await h.request([success]);
    expect(h.sent[3]).toHaveProperty('prompt_cache_key');
  });

  it('stops after two 400s without learning; a new input carries cache again', async () => {
    const h = fixture(); h.fresh();
    expect(await h.request([failure(), failure()])).toEqual([expect.objectContaining({ error: expect.objectContaining({ cindyCacheRecoveryHandled: true }) })]);
    expect(h.sent).toHaveLength(2); expect(h.record()).toBeUndefined();
    await h.request([failure()]); // Native retry in the same input cannot refresh the budget.
    expect(h.sent).toHaveLength(3);
    expect(h.sent[2]).not.toHaveProperty('prompt_cache_key');
    h.fresh(); await h.request([success]);
    expect(h.sent[3]).toHaveProperty('prompt_cache_key');
  });

  // PR #7561 P1: input queuing is not execution; Pi emits user message_start
  // (without agent_start) when followUp actually begins. Unit production wrapper.
  it('arms one budget only when a queued user input actually starts', async () => {
    const h = fixture(); h.fresh();
    await h.request([failure()], {}, () => {
      h.handlers.get('input')!({ source: 'rpc', streamingBehavior: 'followUp' }, { isIdle: () => false });
    });
    expect(h.sent).toHaveLength(1); expect(h.record()).toBeUndefined();
    h.startUser(false, true);
    await h.request([failure()]);
    expect(h.sent).toHaveLength(3);
    expect(h.sent[1]).toHaveProperty('prompt_cache_key');
    expect(h.sent[2]).not.toHaveProperty('prompt_cache_key');
    for (const role of ['assistant', 'toolResult', 'system']) h.handlers.get('message_start')?.({ message: { role } });
    h.handlers.get('turn_start')?.({});
    await h.request([failure()]);
    expect(h.sent).toHaveLength(4);
    expect(h.sent[3]).not.toHaveProperty('prompt_cache_key');
    expect(h.record()).toBeUndefined();
    h.startUser(); await h.request([failure(), failure(), failure(), failure(), failure(), success]);
    expect(h.sent).toHaveLength(6);
    expect(h.record()).toMatchObject({ evidence: 'opaque' });
  });

  it('does not reopen recovery when an actual steer user message is consumed', async () => {
    const h = fixture(); h.fresh();
    h.handlers.get('tool_execution_start')!();
    h.interrupt(); h.startUser(false);
    await h.request([failure(), success]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toHaveProperty('prompt_cache_key');
    expect(h.record()).toBeUndefined();
    // A later independently consumed followUp still owns its budget.
    h.startUser(false, true);
    await h.request([failure(), failure(), success]);
    expect(h.sent).toHaveLength(3);
    expect(h.record()).toMatchObject({ evidence: 'opaque' });
  });

  it('keeps the continuing snapshot when steer is consumed across its TTL', async () => {
    const h = fixture();
    const record = { supportsLongCacheRetention: false, learnedAt: 1000000000, expiresAt: 1086400000, evidence: 'opaque' };
    h.files.set('/compat.json', JSON.stringify({ routes: { [key]: record } }));
    h.fresh();
    h.handlers.get('tool_execution_start')!();
    h.clock(1086400001); h.interrupt(); h.startUser(false);
    await h.request([success]);
    expect(h.sent[0]).not.toHaveProperty('prompt_cache_key');
    const hook = h.handlers.get('before_provider_request')!;
    expect(await hook({ payload: body }, { model, modelRegistry: {} })).not.toHaveProperty('prompt_cache_key');
    h.startUser(false, true); await h.request([success]);
    expect(h.sent[1]).toHaveProperty('prompt_cache_key');
  });

  it('does not arm from a stale receipt or a followUp cancelled while its receipt is pending', async () => {
    for (const cancel of [false, true]) {
      const h = fixture(); h.fresh(); h.interrupt();
      h.handlers.get('message_start')!({ message: { role: 'user', content: [] } }, { mode: 'rpc', ui: {
        input: async (_title: string, raw: string) => {
          if (cancel) h.handlers.get('tool_execution_start')!();
          return JSON.stringify({ key: cancel ? JSON.parse(raw).key : 'stale', followUp: true });
        },
      } });
      await h.request([failure(), success]);
      expect(h.sent).toHaveLength(1);
      expect(h.record()).toBeUndefined();
    }
  });

  it.each([true, false].flatMap(direct => [{ direct, mode: 'rpc' }, { direct, mode: undefined }]))(
    'binds $direct input receipts before message_end replaces the message (mode: $mode)', async ({ direct, mode }) => {
      const h = fixture(); h.fresh(); h.interrupt();
      if (direct) h.handlers.get('before_agent_start')!({});
      const message = { role: 'user', content: [{ type: 'text', text: 'accepted input' }], timestamp: 123 };
      const key = createHash('sha256').update(JSON.stringify(message)).digest('hex');
      const query = vi.fn(async () => JSON.stringify({ key, followUp: !direct }));
      h.handlers.get('message_start')!({ message }, { mode, modelRegistry: modernRegistry, ui: { input: query } });
      // Pi's message_end replacement mutates the same message object in place.
      Object.assign(message, { content: [{ type: 'text', text: 'extension replacement' }], timestamp: 456 });
      await h.request([failure(), success]);
      if (direct) expect(query).not.toHaveBeenCalled();
      else expect(query).toHaveBeenCalledWith('cindy:cache-input', JSON.stringify({ key, direct: false }));
      expect(h.sent).toHaveLength(2);
      expect(h.record()).toMatchObject({ evidence: 'opaque' });
    },
  );

  it('keeps modern ordinary input recovery independent of the queue receipt service', async () => {
    const h = fixture(); h.fresh();
    const query = vi.fn(() => { throw new Error('queue service unavailable'); });
    h.handlers.get('before_agent_start')!({});
    h.handlers.get('message_start')!({ message: { role: 'user', content: 'direct' } }, { mode: 'rpc', modelRegistry: modernRegistry, ui: { input: query } });
    expect(await h.request([failure(), success])).toEqual([success]);
    expect(query).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(2);
    expect(h.record()).toMatchObject({ evidence: 'opaque' });
  });

  it('retains exact direct-input acknowledgement only for older host recovery', async () => {
    const h = fixture(true);
    const message = { role: 'user', content: 'legacy direct' };
    const key = createHash('sha256').update(JSON.stringify(message)).digest('hex');
    const query = vi.fn(async () => JSON.stringify({ key, followUp: false }));
    h.handlers.get('before_agent_start')!({});
    h.handlers.get('message_start')!({ message }, { mode: 'rpc', modelRegistry: {}, ui: { input: query } });
    await h.handlers.get('before_provider_request')!({ payload: body }, { model, modelRegistry: {} });
    expect(query).toHaveBeenCalledWith('cindy:cache-input', JSON.stringify({ key, direct: true }));
    expect(await h.request([failure(), success])).toEqual([success]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveLength(2);
  });

  it('does not ask an interactive runtime to confirm queued provenance', async () => {
    const h = fixture(); h.fresh(); h.interrupt();
    const query = vi.fn();
    h.handlers.get('message_start')!({ message: { role: 'user', content: [] } }, { mode: 'interactive', ui: { input: query } });
    await h.request([failure(), success]);
    expect(query).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(1);
    expect(h.record()).toBeUndefined();
  });

  // PR #7561 P1: freeze learned state across tool calls, including the case
  // where the TTL passes after input start but before the first provider call.
  it('freezes learned cache removal until the next real user input', async () => {
    const h = fixture();
    h.files.set('/compat.json', JSON.stringify({ routes: { [key]: { supportsLongCacheRetention: false,
      learnedAt: 1000000000, expiresAt: 1086400000, evidence: 'opaque' } } }));
    h.fresh(); h.clock(1086400001);
    await h.request([success]);
    h.handlers.get('tool_execution_start')!();
    await h.request([success]);
    expect(h.sent).toHaveLength(2);
    for (const payload of h.sent) expect(payload).toEqual({ model: 'wire', messages: body.messages });
    h.startUser(); await h.request([success]);
    expect(h.sent[2]).toEqual(body);
  });

  it('treats an unfamiliar gateway error type as opaque without a vendor allowlist', async () => {
    const h = fixture(); h.fresh();
    await h.request([failure('400: {"error":{"type":"new_gateway_validation_shape","message":"请求不满足要求"}}'), success]);
    expect(h.sent).toHaveLength(2);
    expect(h.record()).toMatchObject({ evidence: 'opaque', expiresAt: 1086400000 });
  });

  it.each(['401: unauthorized', '429: limited', '500: broken', 'text says 400: failure',
    '400: {"error":{"param":"temperature","message":"invalid"}}',
    '400: {"error":{"code":"context_length_exceeded","message":"opaque"}}',
    '400: {"error":{"type":"authentication_error","message":"opaque"}}',
    '400: Invalid value for prompt_cache_retention', '400: 模型不存在'])('leaves known unrelated failures alone: %s', async text => {
    const h = fixture(); h.fresh(); await h.request([failure(text)]);
    expect(h.sent).toHaveLength(1); expect(h.record()).toBeUndefined();
  });

  it.each([
    { code: 'missing_required_parameter', message: 'Request validation failed' },
    { type: 'invalid_type', message: 'Request validation failed' },
    { code: 'invalid_type', param: null, message: 'Request validation failed' },
    { message: "Missing required parameter: 'messages'." },
    { message: 'messages: Field required' },
    { message: 'Required field messages is missing' },
    { message: 'Invalid type for messages' },
    { message: 'Invalid parameter: temperature' },
    { code: 'invalid_parameter', param: null, message: 'Invalid parameter: future_option' },
    { message: "Parameter 'temperature' is invalid" },
    { message: 'Invalid parameters: prompt_cache_key, temperature' },
  ])('does not trial explicit required/type/other-field validation: %j', async error => {
    const h = fixture(); h.fresh();
    const event = failure('400: ' + JSON.stringify({ error }));
    expect(await h.request([event, success])).toEqual([expect.objectContaining({ error: expect.objectContaining({ errorMessage: event.error.errorMessage }) })]);
    expect(h.sent).toHaveLength(1); expect(h.record()).toBeUndefined();
  });

  it.each([
    { code: 'invalid_parameter', message: 'Request validation failed' },
    { type: 'invalid_parameter', param: null, message: 'Request validation failed' },
    { message: 'Invalid parameter: prompt_cache_key' },
  ])('keeps a non-specific validation label eligible for bounded contrast: %j', async error => {
    const h = fixture(); h.fresh();
    await h.request([failure('400: ' + JSON.stringify({ error })), success]);
    expect(h.sent).toHaveLength(2);
    expect(h.record()).toMatchObject({ evidence: 'opaque', expiresAt: 1086400000 });
  });

  it.each([
    'Validation: Unsupported parameter(s): temperature',
    'Unknown field: future_vendor_option',
    "Unsupported parameter(s): ['temperature']",
    "Unsupported parameter(s): ['prompt_cache_key', 'temperature']",
    'Unsupported parameters: prompt_cache_key, temperature',
    "Unsupported parameter(s): 'prompt_cache_key', 'future_vendor_option'",
    '未知请求字段：prompt_cache_key，temperature',
    "The parameter 'temperature' is not supported",
    '未知请求字段：temperature',
    '参数 temperature 不支持',
    'Unsupported parameter: prompt_cache_key; unsupported parameter: temperature',
  ])('does not trial an explicitly rejected other field without structured param: %s', async message => {
    const h = fixture(); h.fresh();
    await h.request([failure('400: ' + JSON.stringify({ error: { type: 'invalid_request_error', param: null, message } })), success]);
    expect(h.sent).toHaveLength(1);
    expect(h.record()).toBeUndefined();
  });

  it.each(['Validation: Unsupported parameter(s): prompt_cache_key',
    'Unsupported parameter: prompt_cache_retention.',
    "The parameter 'prompt_cache_key' is not supported",
    '未知请求字段：prompt_cache_retention',
    "Unsupported parameter(s): ['prompt_cache_key', 'prompt_cache_retention']",
    'Unsupported parameters: prompt_cache_key, prompt_cache_retention',
    "Unsupported parameter(s): 'prompt_cache_key', 'prompt_cache_retention'",
    'Unsupported parameter: prompt_cache_key, use prompt_cache_options instead',
    'Unsupported parameter: prompt_cache_key, please use a supported option',
    '未知请求字段：prompt_cache_key，请改用 prompt_cache_options',
  ])('still learns explicit cache rejection: %s', async message => {
    const h = fixture(); h.fresh();
    await h.request([failure('400: ' + JSON.stringify({ error: { param: null, message } })), success]);
    expect(h.sent).toHaveLength(2);
    expect(h.record()).toMatchObject({ evidence: 'explicit', expiresAt: 1604800000 });
  });

  it.each(['start', 'thinking_delta', 'toolcall_start'])('never retries after %s or a prior tool', async type => {
    const h = fixture(); h.fresh(); await h.request([[{ type }, failure()]]);
    expect(h.sent).toHaveLength(1); expect(h.record()).toBeUndefined();
    h.fresh(); h.handlers.get('tool_execution_start')!(); await h.request([failure()]);
    expect(h.sent).toHaveLength(2);
  });

  it('does not send a changed second request, even when the later payload hook changes it', async () => {
    const h = fixture(); h.fresh(); let n = 0;
    const result = await h.request(undefined, { onPayload: (p: any) => ({ ...p, temperature: n++ }) });
    expect(h.sent).toHaveLength(1);
    expect(result[0].error.errorMessage).toContain('opaque refusal');
    expect(h.record()).toBeUndefined();
  });

  it('respects stop and queued input while a payload hook is awaiting', async () => {
    for (const cancel of [true, false]) {
      const h = fixture(); h.fresh(); const controller = new AbortController(); let n = 0;
      await h.request(undefined, { signal: controller.signal, onPayload: async (p: any) => {
        if (++n === 2) { if (cancel) controller.abort(); else h.interrupt(); }
        return p;
      } });
      expect(h.sent).toHaveLength(1); expect(h.record()).toBeUndefined();
    }
  });

  it('does not retry when a later hook changes authentication even if the body is identical', async () => {
    const h = fixture(); h.fresh(); let n = 0;
    const headers = { authorization: 'fixture-a' };
    await h.request(undefined, { headers, onPayload: (payload: any) => {
      if (++n === 2) headers.authorization = 'fixture-b';
      return payload;
    } });
    expect(h.sent).toHaveLength(1);
    expect(h.record()).toBeUndefined();
  });

  it('does not learn from a stream failure or let a storage error undo a good response', async () => {
    const h = fixture(); h.fresh(); await h.request([failure(), [{ type: 'start' }, failure('stream error')]]);
    expect(h.record()).toBeUndefined();
    const good = fixture(); good.failWrites(); good.fresh();
    expect(await good.request()).toEqual([success]); expect(good.record()).toBeUndefined();
    good.fresh(); await good.request([success]);
    expect(good.sent[2]).not.toHaveProperty('prompt_cache_key');
  });

  it('gives explicit rejection a finite seven-day record and isolates protocols', async () => {
    const h = fixture(); h.fresh();
    await h.request([failure('400: {"code":"UNKNOWN_FIELD","data":{"field":"prompt_cache_key"}}'), success]);
    expect(h.record()).toMatchObject({ evidence: 'explicit', expiresAt: 1604800000 });
    expect(h.api.accepts({ ...model, api: 'openai-responses' })).toBe(false);
    expect(h.api.accepts({ ...model, baseUrl: model.baseUrl + '/changed' })).toBe(false);
  });

  it('preserves malformed files and bounds the lifetime of legacy records', async () => {
    const h = fixture(); h.files.set('/compat.json', '{bad'); h.fresh(); await h.request();
    expect(h.files.get('/compat.json')).toBe('{bad');
    const legacy = fixture(); legacy.files.set('/compat.json', JSON.stringify({ routes: { [key]: { supportsLongCacheRetention: false } } }));
    legacy.clock(1001); legacy.fresh(); await legacy.request([success]);
    expect(legacy.sent[0]).not.toHaveProperty('prompt_cache_key');
    legacy.clock(1000 + 7 * 86400000 + 1); legacy.fresh(); await legacy.request([success]);
    expect(legacy.sent[1]).toHaveProperty('prompt_cache_key');
  });

  it('ignores malformed route entries and invalid expiry instead of disabling cache forever', async () => {
    const h = fixture();
    const rules = JSON.parse(h.files.get('/agent/pi-cache-compatibility.json')!);
    h.files.set('/agent/pi-cache-compatibility.json', JSON.stringify([null, false, ...rules]));
    h.files.set('/compat.json', JSON.stringify({ routes: { [key]: { supportsLongCacheRetention: false, learnedAt: 1, evidence: 'opaque' } } }));
    h.fresh(); await h.request([success]);
    expect(h.sent[0]).toHaveProperty('prompt_cache_key');
  });
});
