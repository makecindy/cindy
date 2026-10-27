import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexHarnessHooks } from './harness-hooks.js';

const input = { event: 'PreToolUse', session: 'thread-a', turn: 'turn-a', tool_name: 'exec_command', tool_input: { cmd: 'pwd' } };
const metadata = { threadId: 'thread-a', progressToken: 1 };
const notification = {
  threadId: 'thread-a', turnId: 'turn-a',
  run: { id: 'opaque-native-run', eventName: 'preToolUse', handlerType: 'mcpTool', executionMode: 'sync', status: 'running' },
};
const configuredHook = { eventName: 'preToolUse', handlerType: 'mcpTool', server: 'cindy', tool: 'harness_hook', enabled: true, trustStatus: 'trusted' };

afterEach(() => vi.useRealTimers());

describe('Codex native MCP Hook ingress', () => {
  it('requires native enablement and trust before advertising a connected hook', () => {
    const hooks = createCodexHarnessHooks(() => true);
    const config = { config: { features: { hooks: true } } };
    hooks.configure(config, { data: [{ hooks: [configuredHook] }] });
    expect(hooks.names).toEqual([]);
    hooks.setTransportReady(true);
    expect(hooks.names).toEqual(['tool.before']);
    hooks.configure(config, { data: [{ hooks: [{ ...configuredHook, trustStatus: 'modified' }] }] });
    expect(hooks.names).toEqual([]);
    hooks.configure({ config: { features: { hooks: false } } }, { data: [{ hooks: [configuredHook] }] });
    expect(hooks.names).toEqual([]);
    hooks.close();
  });

  it('rejects ordinary model calls without consuming a valid native receipt', async () => {
    const hooks = createCodexHarnessHooks(() => true);
    const dispatch = vi.fn(async () => ({ action: 'block' as const }));
    hooks.setHandler(dispatch);
    hooks.observe(notification, false);
    await expect(hooks.run(input, { ...metadata, callId: 'model-call', itemId: 'model-item' })).rejects.toThrow('NATIVE_HOOK_UNAVAILABLE');
    expect(dispatch).not.toHaveBeenCalled();
    expect(await hooks.run(input, metadata)).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'Blocked by an approved Cindy plugin hook.',
    } });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ name: 'tool.before', toolName: 'exec_command', input: { cmd: 'pwd' } });
    hooks.close();
  });

  it('binds native callbacks to the current root, turn and unconsumed receipt', async () => {
    vi.useFakeTimers();
    const hooks = createCodexHarnessHooks((thread, turn) => thread === 'thread-a' && turn === 'turn-a');
    const dispatch = vi.fn(async () => ({ action: 'continue' as const }));
    hooks.setHandler(dispatch);
    hooks.observe(notification, false);
    await expect(hooks.run({ ...input, session: 'thread-child' }, { threadId: 'thread-child' })).rejects.toThrow('NATIVE_HOOK_UNAVAILABLE');
    expect(await hooks.run(input, metadata)).toEqual({});
    const duplicate = expect(hooks.run(input, metadata)).rejects.toThrow('NATIVE_HOOK_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(100);
    await duplicate;
    expect(dispatch).toHaveBeenCalledTimes(1);
    hooks.close();
  });

  it('handles independent transport ordering and discards late results after close', async () => {
    const hooks = createCodexHarnessHooks(() => true);
    let finish!: (value: { action: 'block' }) => void;
    hooks.setHandler(() => new Promise(resolve => { finish = resolve; }));
    const pending = expect(hooks.run(input, metadata)).rejects.toThrow('NATIVE_HOOK_UNAVAILABLE');
    hooks.observe(notification, false);
    await Promise.resolve();
    await Promise.resolve();
    hooks.close();
    finish({ action: 'block' });
    await pending;
  });

  it('does not dispatch when the native run completes before the callback resumes', async () => {
    const hooks = createCodexHarnessHooks(() => true);
    const dispatch = vi.fn(async () => ({ action: 'block' as const }));
    hooks.setHandler(dispatch);
    const pending = expect(hooks.run(input, metadata)).rejects.toThrow('NATIVE_HOOK_UNAVAILABLE');
    hooks.observe(notification, false);
    hooks.observe(notification, true);
    await pending;
    expect(dispatch).not.toHaveBeenCalled();
    hooks.close();
  });
});
