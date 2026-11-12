/**
 * 渠道过程反馈的隐私边界。
 *
 * 测试价值
 * - 生产入口与可观察结果: renderPublicStage —— 企业微信用户看到的过程反馈。
 * - Bug／规则依据: im-turn-flow.md「只发公开进度」；用户要求「不输出思考或内部工具参数」。
 * - 现有覆盖缺口: turnActivity.renderActivity 会渲染工具步骤与思考摘要（桌面/富卡用），
 *   没有断言保证 chunked-text 的公开视图不带这些内容。
 * - 最小失败输入: 一轮里同时有 Bash 命令、思考增量和重试提示 —— 公开视图只能出现后者。
 * - tier: unit（纯函数，无 IO）。
 */
import { describe, expect, it } from 'vitest';

import { renderPublicStage } from '../publicProgress';
import {
  createTurnActivity,
  markActivityWriting,
  pushThinkingStep,
  pushToolStep,
  setActivityNotice,
} from '../turnActivity';

describe('public progress stage', () => {
  it('shows coarse progress but never tool names, arguments or thinking text', () => {
    const activity = createTurnActivity(0);
    pushToolStep(activity, 'Bash', { command: 'rm -rf /tmp/secret' }, 'tool-1');
    pushThinkingStep(
      activity,
      { stage: 'delta', text: '内部推理：先读密钥', blockId: 'thinking-1' },
    );
    markActivityWriting(activity);
    // 状态行由已本地化的用户可见文案设置(自动重试)，属于可以公开的内容。
    setActivityNotice(activity, '上游过载，正在自动重试（1/3）');

    const stage = renderPublicStage(activity, 12_000);
    expect(stage).toContain('正在处理');
    expect(stage).toContain('已进行 2 步');
    expect(stage).toContain('正在整理回答');
    expect(stage).toContain('正在自动重试');
    expect(stage).toContain('12s');
    // 工具名、命令参数、思考原文一律不得出现。
    expect(stage).not.toContain('Bash');
    expect(stage).not.toContain('rm -rf');
    expect(stage).not.toContain('内部推理');
    expect(stage).not.toContain('密钥');
  });

  it('stays a single public line even before any progress', () => {
    const stage = renderPublicStage(createTurnActivity(0), 3_000);
    expect(stage).toBe('⚙️ 正在处理 · 3s');
  });
});
