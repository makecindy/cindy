/**
 * 测试价值：createEventProjection 的文本与工具事件直接决定 HHH 可见记录。
 * 依据：流式快照不得重复回复、宿主工具不得重复执行；既有 renderer 投影不覆盖本机 API。
 * 最小失败输入：delta 后 final、宿主 MCP 同时出现原生 tool_result、终态错误后 done。
 * tier: unit（纯事件、无 Electron）；单文件实测 2ms。与 server 分文件以隔离真实 socket tier。
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('@cindy/maker-core', () => ({ LOCAL_AGENT_CLIENT: Symbol('local-agent-client') }));
import { createEventProjection } from '../runtime.js';
import { localAgentModels, LOCAL_AGENT_ROUTE } from '../catalog.js';
import type { ProviderView } from '@cindy/model-providers';

describe('whole Cindy catalog projection', () => {
  const provider = (id: string, patch: Partial<ProviderView> = {}) =>
    ({
      id,
      name: id,
      source: 'user',
      connected: true,
      agents: ['claude-code', 'codex', 'pi'],
      routing: { 'claude-code': {}, codex: {}, pi: {} },
      models: { 'claude-code': [], codex: [], pi: [] },
      ...patch,
    }) as ProviderView;
  const model = {
    id: 'same-model',
    name: '同名模型',
    mode: 'chat',
    efforts: ['low', 'high'],
    defaultEffort: 'low',
    modalities: { input: ['text', 'image'], output: ['text'] },
  };
  it('includes all available engines and distinguishes supplier/model collisions without leaking routing', () => {
    const result = localAgentModels(
      ['A', 'B'].map((id) =>
        provider(id, {
          models: { 'claude-code': [model], codex: [model], pi: [model] },
          routing: { 'claude-code': { apiKey: 'SECRET' }, codex: { endpoint: 'PRIVATE' }, pi: {} },
        } as never),
      ),
      ['claude-code', 'codex', 'pi'],
    );
    expect(result).toHaveLength(6);
    expect(new Set(result.map((m) => m.id)).size).toBe(6);
    expect(result.every((m) => m.id.length === 64 && m.images)).toBe(true);
    expect(result.map((m) => m.label)).toContain('B · 同名模型 · pi');
    expect(result.map((m) => m.providerLabel)).toEqual(['A', 'A', 'A', 'B', 'B', 'B']);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE|apiKey|endpoint/);
    expect(
      localAgentModels(
        [
          provider('A', {
            models: { 'claude-code': [model], codex: [model], pi: [model] },
          } as never),
        ],
        ['pi'],
      ),
    ).toHaveLength(1);
  });
  it('keeps provider display names separate from stable routing identities', () => {
    const result = localAgentModels(
      [provider('source-id', { name: '我的 · 网关', models: { pi: [model] } } as never)],
      ['pi'],
    );
    expect(result[0]).toMatchObject({ provider: 'source-id', providerLabel: '我的 · 网关' });
  });
  it('keeps local, same-account and shared routes distinct without publishing routing metadata', () => {
    const providers = [provider('openai', { models: { pi: [model] } } as never)];
    const local = localAgentModels(providers, ['pi']);
    const remote = localAgentModels(providers, ['pi'], { deviceId: 'device-a', label: '电脑 A' });
    const shared = localAgentModels(providers, ['pi'], { deviceId: 'share:one', label: '来自 LiZi 的分享' });
    expect(new Set([...local, ...remote, ...shared].map(m => m.id)).size).toBe(3);
    expect(new Set([...local, ...remote, ...shared].map(m => m.provider)).size).toBe(3);
    expect(shared[0].providerLabel).toBe('openai · 来自 LiZi 的分享');
    expect(shared[0][LOCAL_AGENT_ROUTE]).toEqual({ deviceId: 'share:one', providerId: 'openai' });
    expect(JSON.stringify(shared)).not.toContain('share:one');
    expect(localAgentModels(providers, ['pi'], { deviceId: 'share:one', label: '改名' })[0].id).toBe(shared[0].id);
  });
  it('filters disconnected, suspended, disabled, retired and non-chat choices and keeps large catalogs fast', () => {
    const choices = [
      model,
      { ...model, id: 'disabled', disabled: true },
      { ...model, id: 'retired', status: 'retired' },
      { ...model, id: 'image-only', mode: 'image' },
    ];
    expect(
      localAgentModels(
        [
          provider('A', { models: { pi: choices } } as never),
          provider('B', { suspended: true }),
          provider('C', { connected: false }),
        ],
        ['pi'],
      ),
    ).toHaveLength(1);
    const large = provider('large', {
      models: { pi: Array.from({ length: 500 }, (_, i) => ({ ...model, id: `chat-${i}` })) },
    } as never);
    const start = performance.now();
    expect(localAgentModels([large], ['pi'])).toHaveLength(500);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('native event projection', () => {
  // Actual native done envelopes differ: Codex promptTokens, Pi cacheCreation,
  // and Claude request deltas alongside a cumulative SDK aggregate.
  it.each([
    { usage: { promptTokens: 2, cachedTokens: 3, cacheCreationTokens: 4, completionTokens: 5 } },
    { usage: { inputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, outputTokens: 5 } },
    {
      usage: { input_tokens: 200, output_tokens: 500 },
      usageSegments: [
        { inputTokens: 2, cacheReadTokens: 3, cacheCreateTokens: 4, outputTokens: 5 },
      ],
    },
  ])(
    'preserves native token buckets without counting a cumulative aggregate twice (%j)',
    (data) => {
      const emit = vi.fn(),
        projection = createEventProjection(emit);
      projection.begin();
      projection.accept({ type: 'done', data });
      expect(emit.mock.calls[0][0]).toEqual({
        type: 'usage',
        data: { input: 9, cached: 3, output: 5 },
      });
    },
  );
  it.each(['client', 'calendar', 'hhh'])(
    'does not repeat final snapshots or duplicate tools in namespace %s',
    (namespace) => {
      const emit = vi.fn(),
        p = createEventProjection(emit, namespace);
      p.begin();
      for (const event of [
        { type: 'text', data: { text: 'hello', isFinal: false } },
        { type: 'text', data: { text: 'hello', isFinal: true } },
        { type: 'thinking', data: { text: 'think', stage: 'delta' } },
        { type: 'thinking', data: { text: 'think', stage: 'final' } },
        {
          type: 'tool_use',
          data: { toolUseId: 'host', toolName: `mcp__${namespace}__send`, input: {} },
        },
        { type: 'tool_result_full', data: { toolUseId: 'host', fullText: 'done' } },
        {
          type: 'tool_use',
          data: { toolUseId: 'codex-host', toolName: `mcp:${namespace}:list_items`, input: {} },
        },
        { type: 'tool_result_full', data: { toolUseId: 'codex-host', fullText: 'done' } },
        {
          type: 'done',
          data: {
            result: 'hello',
            status: 'completed',
            usage: { inputTokens: 10, cacheReadTokens: 5, outputTokens: 2 },
          },
        },
      ])
        p.accept(event as any);
      expect(emit.mock.calls.map(([e]) => e.type)).toEqual([
        'text',
        'thinking',
        'usage',
        'turn_end',
      ]);
      expect(emit.mock.calls[2][0].data).toEqual({ input: 15, cached: 5, output: 2 });
    },
  );
  it('fails a dismissed interaction only at the native boundary, after its usage', () => {
    const emit = vi.fn(),
      p = createEventProjection(emit);
    p.begin();
    p.failAtEnd('interaction unavailable');
    p.accept({ type: 'text', data: { text: 'wrapping up', isFinal: false } } as any);
    p.accept({
      type: 'done',
      data: { status: 'completed', usage: { inputTokens: 3, outputTokens: 1 } },
    } as any);
    expect(emit.mock.calls.map(([e]) => e)).toEqual([
      { type: 'text', data: 'wrapping up' },
      { type: 'usage', data: { input: 3, cached: 0, output: 1 } },
      { type: 'turn_end', data: { status: 'failed', message: 'interaction unavailable' } },
    ]);
  });
  it('appends a final-only tail per message and never repeats a diverged snapshot', () => {
    const emit = vi.fn(),
      p = createEventProjection(emit);
    p.begin();
    for (const event of [
      // Codex holds a citation-boundary tail out of deltas and only publishes it in completed.
      { type: 'text', data: { text: 'See ', isFinal: false, agentMessageId: 'a' } },
      { type: 'text', data: { text: 'See docs.', isFinal: true, agentMessageId: 'a' } },
      { type: 'text', data: { text: 'Only final', isFinal: true, agentMessageId: 'b' } },
      { type: 'text', data: { text: 'Hello worxd', isFinal: false, agentMessageId: 'c' } },
      { type: 'text', data: { text: 'Hello wonderful', isFinal: true, agentMessageId: 'c' } },
      { type: 'done', data: { result: 'Hello wonderful', status: 'completed' } },
    ])
      p.accept(event as any);
    expect(emit.mock.calls.filter(([e]) => e.type === 'text').map(([e]) => e.data)).toEqual([
      'See ',
      'docs.',
      'Only final',
      'Hello worxd',
    ]);
  });
  it('keeps native tool activity and emits one failure per turn', () => {
    const emit = vi.fn(),
      p = createEventProjection(emit);
    p.begin();
    p.accept({
      type: 'tool_use',
      data: { toolUseId: 'native', toolName: 'bash', input: { command: 'pwd' } },
    });
    p.accept({ type: 'tool_result_full', data: { toolUseId: 'native', fullText: 'result' } });
    p.fail('stopped');
    p.accept({ type: 'done', data: { result: 'late' } });
    expect(emit.mock.calls.map(([e]) => e.type)).toEqual([
      'tool_started',
      'tool_finished',
      'turn_end',
    ]);
  });
  // Native Pi/Codex Stop uses cancelled; an error can carry paid usage before a paired done.
  it('preserves cancellation and usage on a failed turn without emitting another terminal', () => {
    const emit = vi.fn(),
      p = createEventProjection(emit);
    p.begin();
    p.accept({
      type: 'done',
      data: { status: 'cancelled', usage: { inputTokens: 3, outputTokens: 1 } },
    });
    expect(emit.mock.calls.at(-1)?.[0].data.status).toBe('interrupted');
    p.begin();
    emit.mockClear();
    p.accept({
      type: 'error',
      data: { message: 'failed', isTerminal: true, usage: { inputTokens: 7, outputTokens: 2 } },
    });
    p.accept({
      type: 'done',
      data: { status: 'failed', usage: { inputTokens: 7, outputTokens: 2 } },
    });
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual(['usage', 'turn_end']);
    expect(emit.mock.calls[0][0].data).toEqual({ input: 7, cached: 0, output: 2 });
  });
  // Claude's failed result: a usage-less terminal error, then the paired done with usage.
  it('reports a failed turn usage before its end, and still ends when no done follows', () => {
    vi.useFakeTimers();
    try {
      const emit = vi.fn(),
        p = createEventProjection(emit);
      p.begin();
      p.accept({ type: 'error', data: { message: 'failed', isTerminal: true } });
      p.accept({
        type: 'done',
        data: { is_error: true, usageSegments: [{ inputTokens: 4, outputTokens: 1 }] },
      });
      expect(emit.mock.calls.map(([event]) => event)).toEqual([
        { type: 'usage', data: { input: 4, cached: 0, output: 1 } },
        { type: 'turn_end', data: { status: 'failed', message: 'failed' } },
      ]);
      p.begin();
      emit.mockClear();
      p.accept({ type: 'error', data: { message: 'stopped', isTerminal: true } });
      expect(emit).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(emit.mock.calls.map(([event]) => event)).toEqual([
        { type: 'turn_end', data: { status: 'failed', message: 'stopped' } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
