import { describe, expect, it, vi } from 'vitest';
import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerNativeToolHook, type NativeToolHookCallback } from './native_tool_hook.js';
import type { LiziMcpSessionContext } from '../types.js';

// Internal MCP boundary, unit: preserve native hook JSON and cancellation while
// rejecting plugin/remote/missing runtime identity. The native Codex integration
// tests use a fake MCP tool and cannot validate this production relay.
// Minimal input: a PreToolUse call with one host-attested local runtime instance.
describe('native tool hook MCP relay', () => {
  const context: LiziMcpSessionContext = { agentKind: 'codex', workingDir: '/fixture', sessionId: 'task', sessionInstanceId: 'runtime' };
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'call', tool_input: { command: 'original' } };
  function fixture(call: NativeToolHookCallback, ctx = context) {
    const registry = new XdtHelperToolRegistry();
    registerNativeToolHook(registry, () => ctx, call);
    return registry;
  }
  it('keeps the relay hidden and returns native parameter transformation JSON', async () => {
    const call = vi.fn(async () => ({ input: { command: 'changed' } }));
    const registry = fixture(call);
    expect(registry.list()).toEqual([]);
    const signal = new AbortController().signal;
    const result = await registry.call('native_tool_hook', input, signal);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'changed' } } });
    expect(call).toHaveBeenCalledWith(context, expect.objectContaining({ toolCallId: 'call', input: { command: 'original' } }), signal);
  });
  it('returns native denial instead of approving the tool', async () => {
    const result = await fixture(async () => ({ decision: 'deny', reason: 'restricted' })).call('native_tool_hook', input);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'restricted' } });
  });
  it('preserves PostToolUse context and stop feedback', async () => {
    const result = await fixture(async () => ({ decision: 'deny', reason: 'stop', additionalContext: 'reference' })).call('native_tool_hook', { ...input, hook_event_name: 'PostToolUse', tool_response: 'original' });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ decision: 'block', reason: 'stop', hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'reference' } });
  });
  it.each([{ ...context, sessionInstanceId: undefined }, { ...context, remoteHostId: 'remote' }, { ...context, agentKind: 'pi' }])('rejects an unbound context', async ctx => {
    const call = vi.fn(async () => ({}));
    await expect(fixture(call, ctx).call('native_tool_hook', input)).rejects.toThrow('Native hook task context');
    expect(call).not.toHaveBeenCalled();
  });
});
