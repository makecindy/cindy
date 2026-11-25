import { describe, expect, it, vi } from 'vitest';
import { buildClaudeOrcaTurnGateHooks } from '../orca-turn-gate-hooks.js';

/** 取出唯一那个 Stop hook 回调，省得每个用例重复剥两层数组。 */
function stopHook(sessionId: string, evaluate?: (id: string, text?: string) => Promise<string | undefined>) {
  const hooks = buildClaudeOrcaTurnGateHooks(sessionId, evaluate);
  const matcher = hooks?.Stop?.[0];
  return matcher?.hooks[0] as (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

describe('Claude Code 收口闸门 Stop hook', () => {
  it('把纠正内容放进 block 决定里，让引擎续跑一次', async () => {
    const hook = stopHook('cindy-session', async () => 'dispatched nothing');
    const result = await hook({
      hook_event_name: 'Stop',
      last_assistant_message: '已派给 developer2',
      stop_hook_active: false,
    });
    expect(result).toEqual({ decision: 'block', reason: 'dispatched nothing' });
  });

  it('判定放行时按 continue 收口，不制造第二次续跑', async () => {
    const hook = stopHook('cindy-session', async () => undefined);
    await expect(
      hook({ hook_event_name: 'Stop', last_assistant_message: '你好', stop_hook_active: false }),
    ).resolves.toEqual({ continue: true });
  });

  it('引擎已经续跑过一次就不再叠加判定', async () => {
    const evaluate = vi.fn(async () => 'dispatched nothing');
    const hook = stopHook('cindy-session', evaluate);
    const result = await hook({
      hook_event_name: 'Stop',
      last_assistant_message: '已派给 developer2',
      stop_hook_active: true,
    });
    expect(result).toEqual({ continue: true });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('绑的是 Cindy 会话 id，不是引擎自己的 SDK 会话 id', async () => {
    const evaluate = vi.fn(async () => undefined);
    const hook = stopHook('cindy-session-42', evaluate);
    await hook({
      hook_event_name: 'Stop',
      session_id: 'sdk-uuid',
      last_assistant_message: '已派给 developer2',
      stop_hook_active: false,
    });
    expect(evaluate).toHaveBeenCalledWith('cindy-session-42', '已派给 developer2');
  });

  it('判定抛错时放行，不把会话卡在收口', async () => {
    const hook = stopHook('cindy-session', async () => {
      throw new Error('judge down');
    });
    await expect(
      hook({ hook_event_name: 'Stop', last_assistant_message: '已派', stop_hook_active: false }),
    ).resolves.toEqual({ continue: true });
  });

  it('没有判定入口就不注册 Stop hook', () => {
    expect(buildClaudeOrcaTurnGateHooks('cindy-session', undefined)).toBeUndefined();
  });
});
