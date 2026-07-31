/**
 * renderActivityLine — Telegram DM 草稿占位的单行紧凑状态。
 * 契约: 零进展返回空串(保持原生 Thinking 占位); 工具期一行讲清当前步;
 * notice(过载重试)优先于工作项。
 */

import { describe, expect, it } from 'vitest';

import {
  createTurnActivity,
  pushToolStep,
  pushThinkingStep,
  renderActivityLine,
  setActivityNotice,
} from '../im/shared/turnActivity';

describe('renderActivityLine', () => {
  it('零进展返回空串(草稿保持原生 Thinking 占位)', () => {
    const activity = createTurnActivity(1_000);
    expect(renderActivityLine(activity, 2_000)).toBe('');
  });

  it('工具期渲染最近一步 + 项数 + 时长', () => {
    const activity = createTurnActivity(0);
    pushToolStep(activity, 'Bash', { command: 'git log' }, 't1');
    pushToolStep(activity, 'Read', { file_path: '/tmp/a.md' }, 't2');
    const line = renderActivityLine(activity, 21_000);
    expect(line).toMatch(/^⚙️ /);
    expect(line).toContain(' · 2 项 · 21s');
  });

  it('单项不显示项数; 思考步带 ✦ 前缀', () => {
    const activity = createTurnActivity(0);
    pushThinkingStep(activity, { text: '先看看仓库结构', blockId: 'b1' });
    const line = renderActivityLine(activity, 5_000);
    expect(line).toContain('✦ ');
    expect(line).not.toContain(' 项 ');
    expect(line).toContain(' · 5s');
  });

  it('notice 优先于工作项(过载重试窗口)', () => {
    const activity = createTurnActivity(0);
    pushToolStep(activity, 'Bash', { command: 'x' }, 't1');
    setActivityNotice(activity, '上游过载，正在自动重试');
    expect(renderActivityLine(activity, 1_000)).toBe('⏳ 上游过载，正在自动重试');
  });
});
