/**
 * Pending plugin-engine switches over device-link (docs/plans/acp-plugin-bridge.md, phase 2).
 *
 * 测试价值
 * - 生产入口与可观察结果：device-link 推送的逐控制端投影(dispatch.ts payloadFor 对
 *   local-db:sessions:patched 调用的 withoutPluginEngineSwitchIntent)；看旧控制端收到的 patch。
 * - 规则依据：protocol-compatibility「只加不改」：已发布的手机把 sessions:patched 原样套用，
 *   会把 targetAgentKind 'acp' 显示成「下条：Claude Code」并去读不存在的能力。
 * - 现有覆盖缺口：第二期前意图只有三种内置引擎，没有需要按控制端收窄的取值。
 * - 最小失败输入：带 acp 意图的 patch 原样推给旧控制端；或把内置引擎意图 / 其他字段也一起改掉。
 * - tier：unit(纯函数，无 I/O)。
 */
import { describe, expect, it } from 'vitest';

import { withoutPluginEngineSwitchIntent } from '../pluginEngineSwitchIntentPush';

describe('pending plugin-engine switch pushed to a controller that does not know it', () => {
  it('reads as no pending switch and keeps the rest of the patch', () => {
    const push = {
      sessionId: 's1',
      patch: {
        agentSwitchIntent: { targetAgentKind: 'acp', model: 'deepseek-v4', providerId: 'acp-plugin:_ns__local__dsh-acp:dsh' },
        title: 'Login page',
      },
    };
    expect(withoutPluginEngineSwitchIntent(push)).toEqual({
      sessionId: 's1',
      patch: { agentSwitchIntent: null, title: 'Login page' },
    });
    // The original push (sent unchanged to controllers that declared the capability) is untouched.
    expect(push.patch.agentSwitchIntent).not.toBeNull();
  });

  it('leaves built-in switches and unrelated patches unchanged', () => {
    const builtin = { sessionId: 's1', patch: { agentSwitchIntent: { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null } } };
    expect(withoutPluginEngineSwitchIntent(builtin)).toBe(builtin);
    const cleared = { sessionId: 's1', patch: { agentSwitchIntent: null } };
    expect(withoutPluginEngineSwitchIntent(cleared)).toBe(cleared);
    const other = { sessionId: 's1', patch: { agentKind: 'acp', model: 'deepseek-v4' } };
    expect(withoutPluginEngineSwitchIntent(other)).toBe(other);
  });
});
