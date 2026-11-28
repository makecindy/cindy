import { describe, expect, it } from 'vitest';

import { promptRecommendationAgentKind } from '../promptRecommendationAgentKind';

/**
 * 测试价值
 * - 生产入口与可观察结果：`promptRecommendationAgentKind` 是 ChatInput 输入建议预测的
 *   唯一引擎判定入口；可观察结果是发给 `maker:predict-prompt` 的 `agentKind`（后端按
 *   DB 的 dbAgentKind 核对，不一致即拒绝）。
 * - Bug／规则依据：#13694 —— ACP 会话（runtimeAgentKind 为 null）因启用条件要求
 *   runtimeAgentKind 非空而永远走不到预测；0.1.149 日志里错标成 'claude-code' 的请求
 *   被后端拒绝。
 * - 现有覆盖缺口：`predictPromptUntilDisabled.test.ts` 只测重试/取消转发，
 *   `usePromptRecommendationPrediction.test.tsx` 只测 hook 的去重与生命周期，都不含
 *   「会话引擎 → agentKind」的判定。
 * - 最小失败输入：`{ isPluginEngineSession: true, runtimeAgentKind: null }`（已确认的
 *   ACP 会话）在修复前没有判定入口可返回 'acp'。
 * - tier：unit（纯函数，无 IO）。
 */
describe('promptRecommendationAgentKind', () => {
  it('已确认的 ACP 会话（runtimeAgentKind 为 null）返回 acp', () => {
    // #13694 的核心分支：插件引擎任务没有内置 Harness 身份，不等于不能预测。
    expect(
      promptRecommendationAgentKind({ isPluginEngineSession: true, runtimeAgentKind: null }),
    ).toBe('acp');
  });

  it('内置引擎会话返回 runtimeAgentKind', () => {
    expect(
      promptRecommendationAgentKind({ isPluginEngineSession: false, runtimeAgentKind: 'codex' }),
    ).toBe('codex');
    expect(
      promptRecommendationAgentKind({ isPluginEngineSession: false, runtimeAgentKind: 'claude-code' }),
    ).toBe('claude-code');
    expect(
      promptRecommendationAgentKind({ isPluginEngineSession: false, runtimeAgentKind: 'pi' }),
    ).toBe('pi');
  });

  it('会话信息未就绪时返回 null（等待，不补默认值）', () => {
    // 两个信号都没有 = session 尚未加载；此时不能拿模型选择器默认值补成 claude-code。
    expect(
      promptRecommendationAgentKind({ isPluginEngineSession: false, runtimeAgentKind: null }),
    ).toBeNull();
    expect(
      promptRecommendationAgentKind({ isPluginEngineSession: false, runtimeAgentKind: undefined }),
    ).toBeNull();
  });

  it('插件引擎会话优先于 runtimeAgentKind', () => {
    // 与修复前 ChatInput 的优先级一致（pluginEngineSession ? 'acp' : runtimeAgentKind），
    // 引擎切换后迟到的旧请求仍由主进程按 DB 复核失效，这里只保证口径不分叉。
    expect(
      promptRecommendationAgentKind({ isPluginEngineSession: true, runtimeAgentKind: 'claude-code' }),
    ).toBe('acp');
  });
});
