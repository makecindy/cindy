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
