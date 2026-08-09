/**
 * Phase 2 unit tests: SessionRegistry with a fake SDK Query factory.
 *
 * Fake Query emits a scripted sequence of SDKMessage-shaped events, then
 * yields whatever the consumer pushes via inputQueue. Control methods record
 * invocations so we can assert they were called.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  SessionRegistry,
  type SdkQueryFactory,
  type SdkQueryFactoryOptions,
  type SdkQueryLike,
} from '../src/session-registry.js';

/**
 * Build a fake Query that:
 *   1. Yields a scripted "init" system message (so we capture sdkSessionId)
 *   2. Yields each user message echoed back as assistant text
 *   3. Records calls to control methods
 */
function buildFakeFactory(opts: { sdkSessionId: string } = { sdkSessionId: 'fake-sdk-uuid' }): {
  factory: SdkQueryFactory;
  controlCalls: Array<{ method: string; args: unknown[] }>;
} {
  const controlCalls: Array<{ method: string; args: unknown[] }> = [];
  const factory: SdkQueryFactory = (factoryOpts: SdkQueryFactoryOptions): SdkQueryLike => {
    const inputStream = factoryOpts.inputStream;
    let interrupted = false;

    async function* generate(): AsyncGenerator<unknown> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: opts.sdkSessionId,
        cwd: factoryOpts.cwd,
        model: factoryOpts.model,
      };
      for await (const userMsg of inputStream) {
        if (interrupted) {
          interrupted = false;
          yield { type: 'result', subtype: 'interrupted' };
          continue;
        }
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${JSON.stringify(userMsg)}` }] },
        };
        yield { type: 'result', subtype: 'success' };
      }
    }

    const gen = generate();

    const q: SdkQueryLike = {
      [Symbol.asyncIterator]: () => gen,
      async interrupt(): Promise<void> {
        controlCalls.push({ method: 'interrupt', args: [] });
        interrupted = true;
      },
      async setModel(model?: string): Promise<void> {
        controlCalls.push({ method: 'setModel', args: [model] });
      },
      async setPermissionMode(mode: string): Promise<void> {
        controlCalls.push({ method: 'setPermissionMode', args: [mode] });
      },
      async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
        controlCalls.push({ method: 'applyFlagSettings', args: [settings] });
      },
    };
    return q;
  };
  return { factory, controlCalls };
}

describe('SessionRegistry', () => {
  it('create + consume loop yields init + echo + result events', async () => {
    const { factory } = buildFakeFactory({ sdkSessionId: 'sdk-uuid-1' });
    const events: Array<{ kind: string; payload: unknown }> = [];
    const registry = new SessionRegistry({ sdkQueryFactory: factory });
    const session = registry.create({
      sessionId: 's1',
      cwd: '/tmp/work',
      model: 'claude-opus-4-7[1m]',
      env: {},
    });
    registry.attach('s1', (kind: string, payload: unknown) => events.push({ kind, payload }));

    // Wait for init event to arrive.
    await waitFor(() => events.length >= 1);
    expect(events[0]).toMatchObject({
      kind: 'event',
      payload: expect.objectContaining({
        sessionId: 's1',
        seq: 1,
        message: expect.objectContaining({ type: 'system', subtype: 'init' }),
      }),
    });

    expect(session.sdkSessionId).toBe('sdk-uuid-1');

    registry.sendMessage('s1', { type: 'user', text: 'hi' });

    // Echo + result = 2 more events.
    await waitFor(() => events.length >= 3);
    expect(events[1]).toMatchObject({
      kind: 'event',
      payload: expect.objectContaining({ seq: 2, message: expect.objectContaining({ type: 'assistant' }) }),
    });
    expect(events[2]).toMatchObject({
      kind: 'event',
      payload: expect.objectContaining({ seq: 3, message: expect.objectContaining({ type: 'result' }) }),
    });
  });

  it('list() returns alive sessions with current lastSeq', async () => {
    const { factory } = buildFakeFactory();
    const events: Array<{ kind: string; payload: unknown }> = [];
    const registry = new SessionRegistry({ sdkQueryFactory: factory });
    registry.create({ sessionId: 's1', cwd: '/x', model: 'm', env: {} });
    registry.attach('s1', (kind, p) => events.push({ kind, payload: p }));
    await waitFor(() => events.length >= 1);

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      sessionId: 's1',
      cwd: '/x',
      model: 'm',
      lastSeq: 1,
      alive: true,
    });
  });

  it('control methods forward to SDK Query', async () => {
    const { factory, controlCalls } = buildFakeFactory();
    const registry = new SessionRegistry({ sdkQueryFactory: factory });
    registry.create({ sessionId: 's1', cwd: '/x', model: 'm', env: {} });

    await registry.setModel('s1', 'claude-haiku-4-5');
    await registry.setPermissionMode('s1', 'plan');
    await registry.applyFlagSettings('s1', { effortLevel: 'high' });
    await registry.interrupt('s1');

    expect(controlCalls.map((c) => c.method)).toEqual([
      'setModel',
      'setPermissionMode',
      'applyFlagSettings',
      'interrupt',
    ]);
    expect(controlCalls[0].args).toEqual(['claude-haiku-4-5']);
    expect(controlCalls[2].args).toEqual([{ effortLevel: 'high' }]);
  });

  it('enforces remote tool guards before permission rules while preserving explicit selection', async () => {
    const { factory: baseFactory } = buildFakeFactory();
    let captured: SdkQueryFactoryOptions | undefined;
    const registry = new SessionRegistry({
      sdkQueryFactory: (opts) => {
        captured = opts;
        return baseFactory(opts);
      },
    });
    const events: Array<{ kind: string; payload: unknown }> = [];
    registry.create({
      sessionId: 's-guard',
      cwd: '/x',
      model: 'm',
      env: {},
      toolGuards: [
        {
          toolNamePrefix:
            'mcp__plugin_feishu-delegate_feishu-delegate__',
          sourceServerId: 'plugin:feishu-delegate:feishu-delegate',
          invocation: 'explicit-only',
          explicitSelectors: [
            '$feishu-delegate:message-feishu-coworkers',
            '/feishu-delegate:message-feishu-coworkers',
          ],
          denialMessage: 'Use the Cindy Feishu source.',
        },
      ],
      // A serialized caller cannot replace the daemon-owned guard.
      extraOptions: { hooks: { PreToolUse: [] } },
    });
    registry.attach('s-guard', (kind, payload) =>
      events.push({ kind, payload }),
    );
    await waitFor(() => events.length >= 1);
    const preToolUse = captured?.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(preToolUse).toBeDefined();

    registry.sendMessage('s-guard', {
      type: 'user',
      message: {
        role: 'user',
        content: '不要使用 Feishu Delegate，查一下消息',
      },
      parent_tool_use_id: null,
    });
    await expect(
      preToolUse!({
        hook_event_name: 'PreToolUse',
        session_id: 'sdk-session',
        tool_name:
          'mcp__plugin_feishu-delegate_feishu-delegate__read_messages',
        tool_input: {},
      }),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'Use the Cindy Feishu source.',
      },
    });
    // A user MCP with the ordinary server name is a different source.
    await expect(
      preToolUse!({
        hook_event_name: 'PreToolUse',
        session_id: 'sdk-session',
        tool_name: 'mcp__feishu-delegate__read_messages',
        tool_input: {},
      }),
    ).resolves.toEqual({ continue: true });

    await waitFor(() => events.length >= 3);
    registry.sendMessage('s-guard', {
      type: 'user',
      message: {
        role: 'user',
        content:
          '/feishu-delegate:message-feishu-coworkers 查一下康康',
      },
      parent_tool_use_id: null,
    });
    await expect(
      preToolUse!({
        hook_event_name: 'PreToolUse',
        session_id: 'sdk-session',
        tool_name:
          'mcp__plugin_feishu-delegate_feishu-delegate__read_messages',
        tool_input: {},
      }),
    ).resolves.toEqual({ continue: true });
  });

  it('allows the exact Orca report tool for the root and denies nested Claude agents', async () => {
    const { factory: baseFactory } = buildFakeFactory();
    let captured: SdkQueryFactoryOptions | undefined;
    const registry = new SessionRegistry({
      sdkQueryFactory: (opts) => {
        captured = opts;
        return baseFactory(opts);
      },
    });
    registry.create({
      sessionId: 's-orca-root-only',
      cwd: '/x',
      model: 'm',
      env: {},
      toolGuards: [{
        toolNamePrefix: 'mcp__orca_worker_bridge__send_to_lead',
        sourceServerId: 'orca_worker_bridge',
        invocation: 'root-only',
        denialMessage: 'NESTED_AGENT_NOT_ALLOWED',
      }],
    });
    const preToolUse = captured?.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(preToolUse).toBeDefined();
    const call = {
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__orca_worker_bridge__send_to_lead',
    };
    await expect(preToolUse!(call)).resolves.toEqual({ continue: true });
    await expect(preToolUse!({ ...call, agent_id: 'child-1' })).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'NESTED_AGENT_NOT_ALLOWED',
      },
    });
    await expect(preToolUse!({
      ...call,
      tool_name: 'mcp__orca_worker_bridge__read_lead',
      agent_id: 'child-1',
    })).resolves.toEqual({ continue: true });
  });

  it('keeps explicit selection across accepted same-turn steering inputs', async () => {
    let captured: SdkQueryFactoryOptions | undefined;
    const factory: SdkQueryFactory = (opts) => {
      captured = opts;
      async function* generate(): AsyncGenerator<unknown> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sdk-guard-steer',
        };
        for await (const message of opts.inputStream) {
          void message;
          yield { type: 'assistant', message: { content: [] } };
        }
      }
      const gen = generate();
      return {
        [Symbol.asyncIterator]: () => gen,
        async interrupt() {},
        async setModel() {},
        async setPermissionMode() {},
        async applyFlagSettings() {},
      };
    };
    const registry = new SessionRegistry({ sdkQueryFactory: factory });
    registry.create({
      sessionId: 's-steer',
      cwd: '/x',
      model: 'm',
      env: {},
      toolGuards: [
        {
          toolNamePrefix: 'mcp__plugin_guard__',
          invocation: 'explicit-only',
          explicitSelectors: ['$plugin:guard'],
        },
      ],
    });
    registry.sendMessage('s-steer', {
      type: 'user',
      message: { role: 'user', content: '$plugin:guard 开始' },
    });
    registry.sendMessage('s-steer', {
      type: 'user',
      message: { role: 'user', content: '再补充一点' },
    });

    const preToolUse = captured?.hooks?.PreToolUse?.[0]?.hooks[0];
    await expect(
      preToolUse!({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__plugin_guard__call',
      }),
    ).resolves.toEqual({ continue: true });
  });

  it('merges plan-review edits and user feedback into remote guard selection', async () => {
    const cases = [
      {
        label: 'edited-plan',
        expectedGuardResult: { continue: true },
        decision: {
          kind: 'plan_review' as const,
          behavior: 'allow' as const,
          editedPlan: '1. use $plugin:guard',
        },
      },
      {
        label: 'revision-feedback',
        expectedGuardResult: { continue: true },
        decision: {
          kind: 'plan_review' as const,
          behavior: 'deny' as const,
          reason: 'please use $plugin:guard instead',
        },
      },
      {
        label: 'system-dismissal',
        expectedGuardResult: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
          },
        },
        decision: {
          kind: 'plan_review' as const,
          behavior: 'deny' as const,
          reason: 'system dismissed $plugin:guard',
          dismissed: true,
        },
      },
    ];

    for (const testCase of cases) {
      const { factory: baseFactory } = buildFakeFactory();
      let captured: SdkQueryFactoryOptions | undefined;
      const registry = new SessionRegistry({
        sdkQueryFactory: (opts) => {
          captured = opts;
          return baseFactory(opts);
        },
        onApprovalRequest: async (_sessionId, request) =>
          request.kind === 'plan_review'
            ? testCase.decision
            : { kind: 'permission', behavior: 'allow' },
      });
      const events: Array<{ kind: string; payload: unknown }> = [];
      const sessionId = `s-plan-${testCase.label}`;
      registry.create({
        sessionId,
        cwd: '/x',
        model: 'm',
        env: {},
        toolGuards: [
          {
            toolNamePrefix: 'mcp__plugin_guard__',
            invocation: 'explicit-only',
            explicitSelectors: ['$plugin:guard'],
          },
        ],
      });
      registry.attach(sessionId, (kind, payload) =>
        events.push({ kind, payload }),
      );
      await waitFor(() => events.length >= 1);
      registry.sendMessage(sessionId, {
        type: 'user',
        message: { role: 'user', content: 'make a plan' },
      });

      const canUseTool = captured?.canUseTool;
      const preToolUse = captured?.hooks?.PreToolUse?.[0]?.hooks[0];
      expect(canUseTool).toBeDefined();
      expect(preToolUse).toBeDefined();
      await canUseTool!(
        'ExitPlanMode',
        { plan: '1. call the capability' },
        { toolUseID: `plan-${testCase.label}` },
      );
      await expect(
        preToolUse!({
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__plugin_guard__call',
        }),
      ).resolves.toMatchObject(testCase.expectedGuardResult);
    }
  });

  it('does not guard a connected settings MCP with an exact or normalized plugin id', async () => {
    for (const [label, connectedNames] of [
      ['exact', ['plugin:feishu-delegate:feishu-delegate']],
      [
        'normalized',
        [
          'plugin:feishu-delegate:feishu-delegate',
          'plugin_feishu-delegate_feishu-delegate',
        ],
      ],
    ] as const) {
      let captured: SdkQueryFactoryOptions | undefined;
      const forwardedApproval = vi.fn(async () => ({
        kind: 'permission' as const,
        behavior: 'allow' as const,
      }));
      const factory: SdkQueryFactory = (opts) => {
        captured = opts;
        async function* generate(): AsyncGenerator<unknown> {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: `sdk-settings-collision-${label}`,
            mcp_servers: connectedNames.map((name) => ({
              name,
              status: 'connected',
            })),
          };
          for await (const message of opts.inputStream) void message;
        }
        const query = generate();
        return {
          [Symbol.asyncIterator]: () => query,
          async interrupt() {},
          async setModel() {},
          async setPermissionMode() {},
          async applyFlagSettings() {},
          async mcpServerStatus() {
            return connectedNames.map((name) => ({
              name,
              status: 'connected',
              scope:
                name === 'plugin:feishu-delegate:feishu-delegate' &&
                label === 'normalized'
                  ? 'dynamic'
                  : 'project',
            }));
          },
        };
      };
      const registry = new SessionRegistry({
        sdkQueryFactory: factory,
        onApprovalRequest: forwardedApproval,
      });
      registry.create({
        sessionId: `s-settings-collision-${label}`,
        cwd: '/x',
        model: 'm',
        env: {},
        toolGuards: [
          {
            toolNamePrefix: 'mcp__plugin_feishu-delegate_feishu-delegate__',
            sourceServerId: 'plugin:feishu-delegate:feishu-delegate',
            invocation: 'explicit-only',
            explicitSelectors: ['/feishu-delegate:message-feishu-coworkers'],
          },
        ],
      });
      registry.attach(`s-settings-collision-${label}`, () => undefined);
      await waitFor(
        () =>
          registry.list()[0]?.sdkSessionId ===
          `sdk-settings-collision-${label}`,
      );
      const preToolUse = captured?.hooks?.PreToolUse?.[0]?.hooks[0];
      expect(preToolUse).toBeDefined();
      await expect(
        preToolUse!({
          hook_event_name: 'PreToolUse',
          tool_name:
            'mcp__plugin_feishu-delegate_feishu-delegate__read_messages',
        }),
      ).resolves.toEqual({ continue: true });
      const canUseTool = captured?.canUseTool;
      expect(canUseTool).toBeDefined();
      await expect(
        canUseTool!(
          'mcp__plugin_feishu-delegate_feishu-delegate__read_messages',
          {},
          { toolUseID: `tool-settings-collision-${label}` },
        ),
      ).resolves.toMatchObject({ behavior: 'allow' });
      expect(forwardedApproval).toHaveBeenCalledWith(
        `s-settings-collision-${label}`,
        expect.objectContaining({
          metadata: expect.objectContaining({
            capabilityRoutingChecked: true,
          }),
        }),
      );
    }
  });

  it('keeps the guard for the harness plugin MCP itself', async () => {
    let captured: SdkQueryFactoryOptions | undefined;
    const sourceServerId = 'plugin:feishu-delegate:feishu-delegate';
    const forwardedApproval = vi.fn(async () => ({
      kind: 'permission' as const,
      behavior: 'allow' as const,
    }));
    const factory: SdkQueryFactory = (opts) => {
      captured = opts;
      async function* generate(): AsyncGenerator<unknown> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sdk-harness-plugin-source',
          mcp_servers: [{ name: sourceServerId, status: 'connected' }],
        };
        for await (const message of opts.inputStream) void message;
      }
      const query = generate();
      return {
        [Symbol.asyncIterator]: () => query,
        async interrupt() {},
        async setModel() {},
        async setPermissionMode() {},
        async applyFlagSettings() {},
        async mcpServerStatus() {
          return [{
            name: sourceServerId,
            status: 'connected',
            scope: 'dynamic',
          }];
        },
      };
    };
    const registry = new SessionRegistry({
      sdkQueryFactory: factory,
      onApprovalRequest: forwardedApproval,
    });
    registry.create({
      sessionId: 's-harness-plugin-source',
      cwd: '/x',
      model: 'm',
      env: {},
      toolGuards: [{
        toolNamePrefix: 'mcp__plugin_feishu-delegate_feishu-delegate__',
        sourceServerId,
        invocation: 'explicit-only',
      }],
    });
    registry.attach('s-harness-plugin-source', () => undefined);
    await waitFor(
      () => registry.list()[0]?.sdkSessionId === 'sdk-harness-plugin-source',
    );
    const preToolUse = captured?.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(preToolUse).toBeDefined();
    await expect(
      preToolUse!({
        hook_event_name: 'PreToolUse',
        tool_name:
          'mcp__plugin_feishu-delegate_feishu-delegate__read_messages',
      }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    const canUseTool = captured?.canUseTool;
    expect(canUseTool).toBeDefined();
    await expect(
      canUseTool!(
        'mcp__plugin_feishu-delegate_feishu-delegate__read_messages',
        {},
        { toolUseID: 'tool-harness-plugin-source' },
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
    expect(forwardedApproval).not.toHaveBeenCalled();
  });

  it('keeps the guard when the only colliding settings MCP failed to connect', async () => {
    let captured: SdkQueryFactoryOptions | undefined;
    const factory: SdkQueryFactory = (opts) => {
      captured = opts;
      async function* generate(): AsyncGenerator<unknown> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sdk-failed-settings-collision',
          mcp_servers: [
            { name: 'plugin_feishu-delegate_feishu-delegate', status: 'failed' },
          ],
        };
        for await (const message of opts.inputStream) void message;
      }
      const query = generate();
      return {
        [Symbol.asyncIterator]: () => query,
        async interrupt() {},
        async setModel() {},
        async setPermissionMode() {},
        async applyFlagSettings() {},
        async mcpServerStatus() {
          return [{
            name: 'plugin_feishu-delegate_feishu-delegate',
            status: 'failed',
            scope: 'project',
          }];
        },
      };
    };
    const registry = new SessionRegistry({ sdkQueryFactory: factory });
    registry.create({
      sessionId: 's-failed-settings-collision',
      cwd: '/x',
      model: 'm',
      env: {},
      toolGuards: [
        {
          toolNamePrefix: 'mcp__plugin_feishu-delegate_feishu-delegate__',
          sourceServerId: 'plugin:feishu-delegate:feishu-delegate',
          invocation: 'explicit-only',
          explicitSelectors: ['/feishu-delegate:message-feishu-coworkers'],
        },
      ],
    });
    await waitFor(
      () => registry.list()[0]?.sdkSessionId === 'sdk-failed-settings-collision',
    );
    const preToolUse = captured?.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(preToolUse).toBeDefined();
    await expect(
      preToolUse!({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__plugin_feishu-delegate_feishu-delegate__read_messages',
      }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  it('attach with second client replaces first, notifies the old one', async () => {
    const { factory } = buildFakeFactory();
    const eventsA: Array<{ kind: string; payload: unknown }> = [];
    const eventsB: Array<{ kind: string; payload: unknown }> = [];
    const registry = new SessionRegistry({ sdkQueryFactory: factory });
    registry.create({ sessionId: 's1', cwd: '/x', model: 'm', env: {} });
    const notifyA = vi.fn((kind: string, p: unknown): void => {
      eventsA.push({ kind, payload: p });
    });
    const notifyB = vi.fn((kind: string, p: unknown): void => {
      eventsB.push({ kind, payload: p });
    });
    registry.attach('s1', notifyA);
    await waitFor(() => eventsA.length >= 1); // init event

    registry.attach('s1', notifyB);
    // notifyA should have received a 'replaced' notification.
    expect(eventsA.some((e) => e.kind === 'replaced')).toBe(true);

    // Subsequent events go to B only.
    registry.sendMessage('s1', { type: 'user', text: 'x' });
    await waitFor(() => eventsB.length >= 2); // echo + result
    // A only sees init + replaced; B sees echo + result.
    const aEventKinds = eventsA.filter((e) => e.kind === 'event').length;
    const bEventKinds = eventsB.filter((e) => e.kind === 'event').length;
    expect(aEventKinds).toBe(1); // only the init
    expect(bEventKinds).toBeGreaterThanOrEqual(2);
  });

  it('close() interrupts query + ends input queue → generator exits → alive=false + closed notification', async () => {
    const { factory, controlCalls } = buildFakeFactory();
    const events: Array<{ kind: string; payload: unknown }> = [];
    const registry = new SessionRegistry({ sdkQueryFactory: factory });
    registry.create({ sessionId: 's1', cwd: '/x', model: 'm', env: {} });
    registry.attach('s1', (kind, p) => events.push({ kind, payload: p }));
    await waitFor(() => events.length >= 1);

    await registry.close('s1');
    await waitFor(() => events.some((e) => e.kind === 'closed'));
    expect(controlCalls.some((c) => c.method === 'interrupt')).toBe(true);
    expect(registry.list()[0].alive).toBe(false);
  });

  it('kill() interrupts an alive query before ending input queue', async () => {
    const { factory, controlCalls } = buildFakeFactory();
    const events: Array<{ kind: string; payload: unknown }> = [];
    const registry = new SessionRegistry({ sdkQueryFactory: factory });
    registry.create({ sessionId: 's1', cwd: '/x', model: 'm', env: {} });
    registry.attach('s1', (kind, p) => events.push({ kind, payload: p }));
    await waitFor(() => events.length >= 1);

    await registry.kill('s1');
    await waitFor(() => events.some((e) => e.kind === 'closed'));
    expect(controlCalls.some((c) => c.method === 'interrupt')).toBe(true);
  });

  it('SESSION_ALREADY_EXISTS thrown on duplicate create', () => {
    const { factory } = buildFakeFactory();
    const registry = new SessionRegistry({ sdkQueryFactory: factory });
    registry.create({ sessionId: 's1', cwd: '/x', model: 'm', env: {} });
    expect(() => registry.create({ sessionId: 's1', cwd: '/y', model: 'm2', env: {} })).toThrow(
      /already exists/,
    );
  });

  it('SESSION_NOT_FOUND thrown on get of non-existent session', () => {
    const { factory } = buildFakeFactory();
    const registry = new SessionRegistry({ sdkQueryFactory: factory });
    expect(() => registry.get('nope')).toThrow(/not found/);
  });

});

describe('SessionRegistry getOAuthToken (subscription token refresh)', () => {
  /** 包一层捕获 factory 实际收到的 SdkQueryFactoryOptions。 */
  function captureFactory(): {
    factory: SdkQueryFactory;
    captured: SdkQueryFactoryOptions[];
  } {
    const { factory: base } = buildFakeFactory();
    const captured: SdkQueryFactoryOptions[] = [];
    return {
      factory: (opts) => {
        captured.push(opts);
        return base(opts);
      },
      captured,
    };
  }

  const OAUTH_ENV = { CLAUDE_CODE_OAUTH_TOKEN: 'tok-stale' };

  it('env 带订阅 token + onOAuthRefresh → SDK options 拿到 getOAuthToken,转发含 sessionId', async () => {
    const { factory, captured } = captureFactory();
    const forwarder = vi.fn(async () => ({ token: 'tok-fresh' }));
    const registry = new SessionRegistry({ sdkQueryFactory: factory, onOAuthRefresh: forwarder });
    registry.create({ sessionId: 's1', cwd: '/x', model: 'm', env: { ...OAUTH_ENV } });
    registry.attach('s1', () => undefined);

    expect(captured[0]?.getOAuthToken).toBeDefined();
    await expect(captured[0]!.getOAuthToken!()).resolves.toBe('tok-fresh');
    expect(forwarder).toHaveBeenCalledWith('s1', { sessionId: 's1' });
  });

  it('无 attached client → 不转发,直接 null', async () => {
    const { factory, captured } = captureFactory();
    const forwarder = vi.fn(async () => ({ token: 'tok-fresh' }));
    const registry = new SessionRegistry({ sdkQueryFactory: factory, onOAuthRefresh: forwarder });
    registry.create({ sessionId: 's1', cwd: '/x', model: 'm', env: { ...OAUTH_ENV } });

    await expect(captured[0]!.getOAuthToken!()).resolves.toBeNull();
    expect(forwarder).not.toHaveBeenCalled();
  });

  it('转发抛错(旧 desktop UNKNOWN_METHOD / RPC 超时)→ null,不上抛', async () => {
    const { factory, captured } = captureFactory();
    const forwarder = vi.fn(async () => {
      throw new Error('UNKNOWN_METHOD');
    });
    const registry = new SessionRegistry({ sdkQueryFactory: factory, onOAuthRefresh: forwarder });
    registry.create({ sessionId: 's1', cwd: '/x', model: 'm', env: { ...OAUTH_ENV } });
    registry.attach('s1', () => undefined);

    await expect(captured[0]!.getOAuthToken!()).resolves.toBeNull();
  });

  it('env 不带订阅 token(网关 key 会话)→ 不接 getOAuthToken', () => {
    const { factory, captured } = captureFactory();
    const registry = new SessionRegistry({
      sdkQueryFactory: factory,
      onOAuthRefresh: vi.fn(async () => ({ token: null })),
    });
    registry.create({ sessionId: 's1', cwd: '/x', model: 'm', env: { ANTHROPIC_API_KEY: 'gw' } });

    expect(captured[0]?.getOAuthToken).toBeUndefined();
  });

  it('registry 未配置 onOAuthRefresh → 不接 getOAuthToken', () => {
    const { factory, captured } = captureFactory();
    const registry = new SessionRegistry({ sdkQueryFactory: factory });
    registry.create({ sessionId: 's1', cwd: '/x', model: 'm', env: { ...OAUTH_ENV } });

    expect(captured[0]?.getOAuthToken).toBeUndefined();
  });
});

/* ============================== helpers ============================== */

async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 5;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
