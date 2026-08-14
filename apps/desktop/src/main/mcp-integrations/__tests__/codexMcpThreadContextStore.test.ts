import { describe, expect, it } from 'vitest';

import { createCodexMcpThreadContextStore } from '../codexMcpThreadContextStore.js';

function ctx(sessionId: string, vendorOptions: Record<string, unknown> = {}) {
  return {
    sessionId,
    agentKind: 'codex' as const,
    workingDir: '/repo',
    vendorOptions,
  };
}

describe('createCodexMcpThreadContextStore', () => {
  it('returns context only for a registered thread id', () => {
    const store = createCodexMcpThreadContextStore();
    const context = ctx('lead-session-1');

    store.registerThreadContext('thread-1', context);

    expect(store.getContextForThreadId('thread-1')).toBe(context);
    expect(store.getContextForThreadId('unknown-thread')).toBeUndefined();
    expect(store.getContextForThreadId(undefined)).toBeUndefined();
    expect(store.getContextForThreadId('')).toBeUndefined();
  });

  it('unregisters a thread context', () => {
    const store = createCodexMcpThreadContextStore();
    const context = ctx('lead-session-1');

    store.registerThreadContext('thread-1', context);
    expect(store.getContextForThreadId('thread-1')).toBe(context);

    store.unregisterThreadContext('thread-1');

    expect(store.getContextForThreadId('thread-1')).toBeUndefined();
  });

  it('resolves cloned contexts for one host-owned session instance', () => {
    const store = createCodexMcpThreadContextStore();
    const first = {
      ...ctx('session-1', { orcaRole: 'lead', pluginPolicy: { disabled: ['browser'] } }),
      sessionInstanceId: 'instance-1',
    };
    const alias = {
      ...first,
      vendorOptions: { orcaRole: 'lead', pluginPolicy: { disabled: ['browser'] } },
    };

    store.registerThreadContext('thread-1', first);
    expect(store.getContextForSessionInstanceId('instance-1')).toBe(first);
    expect(store.getContextForSessionInstanceId('unknown')).toBeUndefined();

    store.registerThreadContext('thread-2', alias);
    expect(store.getContextForSessionInstanceId('instance-1')).toBe(first);
  });

  it('fail-closes aliases whose vendor options differ', () => {
    const store = createCodexMcpThreadContextStore();
    const first = {
      ...ctx('session-1', { pluginPolicy: { disabled: ['browser'] } }),
      sessionInstanceId: 'instance-1',
    };
    const differentPolicy = {
      ...first,
      vendorOptions: { pluginPolicy: { disabled: ['ssh'] } },
    };

    store.registerThreadContext('thread-1', first);
    store.registerThreadContext('thread-2', differentPolicy);

    expect(store.getContextForSessionInstanceId('instance-1')).toBeUndefined();
  });

  it('fail-closes duplicate claims with different stable identity', () => {
    const store = createCodexMcpThreadContextStore();
    const first = { ...ctx('session-1'), sessionInstanceId: 'instance-1' };
    const duplicate = { ...ctx('session-2'), sessionInstanceId: 'instance-1' };

    store.registerThreadContext('thread-1', first);
    store.registerThreadContext('thread-2', duplicate);
    expect(store.getContextForSessionInstanceId('instance-1')).toBeUndefined();
    store.unregisterThreadContext('thread-2');
    expect(store.getContextForSessionInstanceId('instance-1')).toBe(first);
  });

  it('ignores a stale unregister after the same thread id is rebound to a new session instance', () => {
    const store = createCodexMcpThreadContextStore();
    const oldContext = { ...ctx('session-1'), sessionInstanceId: 'instance-old' };
    const newContext = { ...ctx('session-1'), sessionInstanceId: 'instance-new' };

    store.registerThreadContext('thread-1', oldContext);
    store.registerThreadContext('thread-1', newContext);
    store.unregisterThreadContext('thread-1', 'instance-old');

    expect(store.getContextForThreadId('thread-1')).toBe(newContext);
    store.unregisterThreadContext('thread-1', 'instance-new');
    expect(store.getContextForThreadId('thread-1')).toBeUndefined();
  });

  it('preserves the vendorOptions object reference', () => {
    const store = createCodexMcpThreadContextStore();
    const vendorOptions = { orcaRole: 'lead' };
    const context = ctx('lead-session-1', vendorOptions);

    store.registerThreadContext('thread-1', context);
    vendorOptions.orcaRole = 'reviewer';

    expect(store.getContextForThreadId('thread-1')?.vendorOptions).toBe(vendorOptions);
    expect(store.getContextForThreadId('thread-1')?.vendorOptions).toEqual({
      orcaRole: 'reviewer',
    });
  });
});
