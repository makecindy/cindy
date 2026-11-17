import { describe, expect, it, vi } from 'vitest';
import { claudeToolLifecycleHooks, withClaudeToolLifecycleHooks } from './tool-lifecycle-hooks.js';
import { buildClaudeSubagentModelGuardHooks } from './subagent-model-access.js';
import type { ToolLifecycleControl, ToolLifecycleVerdict } from '../shared/tool-lifecycle.js';

// Native callback boundary, unit: plugins cannot emit permissionDecision=allow;
// input/result changes and cancellation must follow the SDK hook contract.
// Existing native-auto hooks tests cover Cindy policy, not optional plugin callbacks.
// Minimal inputs: PreToolUse and PostToolUse with an injected host verdict.
describe('Claude plugin tool hooks', () => {
  // SDK matchers run in parallel. This uses the production account guard:
  // rewriting an allowed model must not bypass denial of the resulting model.
  it('checks transformed parameters before capture and account guards, retaining a plugin ask', async () => {
    const capture = vi.fn(async () => ({}));
    const guard = buildClaudeSubagentModelGuardHooks(async model => ({ status: model === 'denied' ? 'denied' : 'allowed' }));
    const control: ToolLifecycleControl = { enabled: () => true, run: async () => ({ decision: 'ask', input: { model: 'denied' } }) };
    const hooks = withClaudeToolLifecycleHooks(control, 'task', { PreToolUse: [
      { hooks: [capture] }, ...guard.PreToolUse!,
      { matcher: 'Bash', hooks: [async () => { throw new Error('wrong matcher'); }] },
    ] });
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'call', tool_input: { model: 'allowed' } };
    const result = await hooks.PreToolUse![0].hooks[0](input as never, 'call', { signal: new AbortController().signal });
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', updatedInput: { model: 'denied' } } });
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ tool_input: { model: 'denied' } }), 'call', expect.anything());
  });
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'call', tool_input: { command: 'original' } };
  function fixture(verdict: ToolLifecycleVerdict = {}) {
    const control: ToolLifecycleControl = { enabled: () => true, run: vi.fn(async () => verdict) };
    const hooks = claudeToolLifecycleHooks(control, 'task')!;
    const signal = new AbortController();
    const run = (event = input) => hooks[event.hook_event_name as 'PreToolUse']![0].hooks[0](event as never, 'call', { signal: signal.signal });
    return { control, hooks, run, signal };
  }
  it('does not install callbacks without a selected provider', () => {
    const control: ToolLifecycleControl = { enabled: () => false, run: vi.fn() };
    expect(claudeToolLifecycleHooks(control, 'task')).toBeUndefined();
    expect(claudeToolLifecycleHooks(control, undefined)).toBeUndefined();
    expect(control.run).not.toHaveBeenCalled();
  });
  it('defers to native permission while transforming the actual input', async () => {
    const f = fixture({ input: { command: 'changed' } });
    expect(await f.run()).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'changed' } } });
    expect(f.control.run).toHaveBeenCalledWith('task', expect.objectContaining({ input: { command: 'original' }, phase: 'call' }), f.signal.signal);
  });
  it.each(['deny', 'ask'] as const)('passes the native %s restriction without manufacturing approval', async decision => {
    expect(await fixture({ decision, reason: 'policy' }).run()).toMatchObject({ hookSpecificOutput: { permissionDecision: decision, permissionDecisionReason: 'policy' } });
  });
  it('maps result replacement and additional context to PostToolUse', async () => {
    const f = fixture({ result: { text: 'changed' }, additionalContext: 'reference' });
    expect(await f.run({ ...input, hook_event_name: 'PostToolUse' })).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { text: 'changed' }, additionalContext: 'reference' } });
  });
  it('discards answers after cancellation or provider removal', async () => {
    const f = fixture({ decision: 'ask' });
    f.control.run = async () => { f.signal.abort(); return { decision: 'ask' }; };
    expect(await f.run()).toEqual({});
    f.control.enabled = () => false;
    expect(await f.run()).toEqual({});
  });
});
