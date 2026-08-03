/** Live work preview parity and replay-safety tests for remote channels. */
import { describe, expect, it } from 'vitest';

import {
  createTurnActivity,
  formatThinkingStep,
  formatToolStep,
  markActivityWriting,
  MAX_VISIBLE_STEPS,
  pushThinkingStep,
  pushToolStep,
  renderActivity,
  setActivityNotice,
  setInteractionNotice,
} from '../turnActivity';

describe('formatToolStep — shared friendly wording', () => {
  it('humanizes files, searches, commands and Codex file changes', () => {
    expect(formatToolStep('Read', { file_path: '/a/b/slackRelay.ts' })).toBe(
      '读取 slackRelay.ts',
    );
    expect(formatToolStep('Grep', { pattern: 'recordRoute' })).toBe('搜索 recordRoute');
    expect(formatToolStep('exec', {
      command: 'pnpm test',
      commandActions: [{ type: 'unknown' }],
    })).toBe('运行测试');
    expect(formatToolStep('file_change', {
      changes: [{ path: '/repo/src/app.ts', kind: { type: 'update' }, diff: '-a\n+b' }],
    })).toBe('编辑 app.ts');
  });

  it('keeps only the friendly title in the compact row', () => {
    expect(formatToolStep('Bash', {
      command: 'rg -n useMemo src',
      description: '搜索 useMemo 的使用位置',
    })).toBe('搜索 useMemo 的使用位置');
    expect(formatToolStep('mcp__lizi_feishu__read_by_url', {})).toBe(
      '调用 lizi_feishu · read by url',
    );
  });
});

describe('thinking activity', () => {
  it('removes paired markdown markers for Slack and collapses whitespace', () => {
    expect(formatThinkingStep('**检查实现**\n\n读取 `app.ts`')).toBe('检查实现 读取 app.ts');
    expect(formatThinkingStep('**正在检查')).toBe('正在检查');
  });

  it('updates one row across deltas/final instead of adding raw stream rows', () => {
    const activity = createTurnActivity(0);
    expect(pushThinkingStep(activity, {
      stage: 'start',
      blockId: 'thinking-1',
      startedAt: 0,
    })).toBe(false);
    pushThinkingStep(activity, { stage: 'delta', blockId: 'thinking-1', text: '**检查' });
    pushThinkingStep(activity, { stage: 'delta', blockId: 'thinking-1', text: '实现**' });
    pushThinkingStep(activity, {
      stage: 'final',
      blockId: 'thinking-1',
      text: '**检查实现**',
    });

    expect(activity.totalSteps).toBe(1);
    expect(activity.recentSteps).toEqual([
      { key: 'thinking:thinking-1', kind: 'thinking', label: '检查实现' },
    ]);
  });

  it('does not expose redacted thinking', () => {
    const activity = createTurnActivity(0);
    expect(pushThinkingStep(activity, { stage: 'redacted', blockId: 'secret' })).toBe(false);
    expect(activity.totalSteps).toBe(0);
  });
});

describe('rolling window and replay de-duplication', () => {
  it('keeps the latest five unique activities while retaining the total', () => {
    const activity = createTurnActivity(0);
    for (let index = 1; index <= MAX_VISIBLE_STEPS + 3; index += 1) {
      pushToolStep(activity, 'Grep', { pattern: `p${index}` }, `tool-${index}`);
    }
    expect(activity.totalSteps).toBe(MAX_VISIBLE_STEPS + 3);
    expect(activity.recentSteps).toHaveLength(MAX_VISIBLE_STEPS);
    expect(activity.recentSteps[0]?.label).toBe('搜索 p4');
    expect(activity.recentSteps.at(-1)?.label).toBe(`搜索 p${MAX_VISIBLE_STEPS + 3}`);
  });

  it('ignores a repeated tool_use id even after its row rolled out', () => {
    const activity = createTurnActivity(0);
    pushToolStep(activity, 'Read', { file_path: '/repo/a.ts' }, 'read-a');
    for (let index = 0; index < MAX_VISIBLE_STEPS; index += 1) {
      pushToolStep(activity, 'Grep', { pattern: `p${index}` }, `grep-${index}`);
    }
    markActivityWriting(activity);
    expect(pushToolStep(activity, 'Read', { file_path: '/repo/a.ts' }, 'read-a')).toBe(false);
    expect(activity.totalSteps).toBe(MAX_VISIBLE_STEPS + 1);
    expect(activity.recentSteps.some((step) => step.label === '读取 a.ts')).toBe(false);
    expect(activity.writing).toBe(true);
  });

  it('keeps writing active when a replayed thought has already rolled out', () => {
    const activity = createTurnActivity(0);
    pushThinkingStep(activity, { stage: 'delta', blockId: 'old-thought', text: '先检查状态' });
    for (let index = 0; index < MAX_VISIBLE_STEPS; index += 1) {
      pushToolStep(activity, 'Grep', { pattern: `p${index}` }, `grep-${index}`);
    }
    markActivityWriting(activity);

    expect(pushThinkingStep(activity, {
      stage: 'final',
      blockId: 'old-thought',
      text: '先检查状态，再继续处理',
    })).toBe(false);
    expect(activity.writing).toBe(true);
    expect(activity.recentSteps.some((step) => step.kind === 'thinking')).toBe(false);
  });

  it('等交互那一行不被正常进展事件清掉(与瞬态 notice 的关键区别)', () => {
    const activity = createTurnActivity(0);
    expect(setInteractionNotice(activity, '等待授权 · 需要你确认')).toBe(true);
    setActivityNotice(activity, '模型服务繁忙，正在自动重试（1/4）…');

    // 挂起期间 agent 的其它子任务照样吐事件: 瞬态 notice 该被清掉, 等待提示必须留着
    pushThinkingStep(activity, { stage: 'final', blockId: 't1', text: '再查一处引用' });
    pushToolStep(activity, 'Read', { file_path: '/x/bg.ts' }, 'bg-1');
    markActivityWriting(activity);
    expect(activity.notice).toBeNull();
    expect(activity.interactionNotice).toBe('等待授权 · 需要你确认');
    expect(renderActivity(activity, 3_000)).toContain('> ⏳ 等待授权 · 需要你确认');

    // 只由交互收口显式摘掉; 重复内容不算变化(同 setActivityNotice 的配额语义)
    expect(setInteractionNotice(activity, '等待授权 · 需要你确认')).toBe(false);
    expect(setInteractionNotice(activity, null)).toBe(true);
    expect(renderActivity(activity, 3_000)).not.toContain('等待授权');
  });

  it('keeps replay bookkeeping out of the serializable card state', () => {
    const activity = createTurnActivity(0);
    pushThinkingStep(activity, { stage: 'final', blockId: 't1', text: '检查状态' });
    pushToolStep(activity, 'Read', { file_path: '/repo/a.ts' }, 'read-a');

    expect(Object.keys(activity).sort()).toEqual([
      'interactionNotice',
      'notice',
      'recentSteps',
      'startedAt',
      'totalSteps',
      'writing',
    ]);
    expect(JSON.parse(JSON.stringify(activity))).toEqual(activity);
  });
});

describe('renderActivity', () => {
  it('renders the current activity without a redundant writing row', () => {
    const activity = createTurnActivity(0);
    pushThinkingStep(activity, { stage: 'final', blockId: 't1', text: '确认调用链' });
    pushToolStep(activity, 'Read', { file_path: '/x/relay.ts' }, 'read-1');
    expect(renderActivity(activity, 42_000).split('\n')).toEqual([
      '⚙️ 工作中 · 2 项 · 42s',
      '> ✓ ✦ 确认调用链',
      '> ▸ 读取 relay.ts',
    ]);

    markActivityWriting(activity);
    const writingView = renderActivity(activity, 90_000);
    expect(writingView).toContain('⚙️ 工作中 · 2 项 · 1m30s');
    expect(writingView).toContain('> ✓ 读取 relay.ts');
    expect(writingView).not.toContain('正在书写回复');

    // A later tool becomes current even though earlier progress text exists.
    pushToolStep(activity, 'Bash', { command: 'pnpm test' }, 'test-1');
    expect(renderActivity(activity, 91_000)).toContain('> ▸ 运行测试');
  });

  it('emits no chrome for a text-only quick answer', () => {
    const activity = createTurnActivity(0);
    markActivityWriting(activity);
    expect(renderActivity(activity, 1_000)).toBe('');
  });
});

describe('activity notice — 自动重试期间的单行状态', () => {
  it('零工作项时也渲染, 且省掉没有信息量的「0 项」', () => {
    // 这条是本机制存在的理由: 过载自动重试只发生在零产出的 turn 上, 若此时
    // renderActivity 仍返回空串, 渠道那条消息在整个退避窗口里一个字都不变。
    const activity = createTurnActivity(0);
    expect(renderActivity(activity, 8_000)).toBe('');

    expect(setActivityNotice(activity, '模型服务繁忙，正在自动重试（2/4）…')).toBe(true);
    expect(renderActivity(activity, 8_000).split('\n')).toEqual([
      '⚙️ 工作中 · 8s',
      '> ⏳ 模型服务繁忙，正在自动重试（2/4）…',
    ]);
  });

  it('不占 step 槽位, 挂在已有步骤之后, 并让最后一步收成已完成', () => {
    const activity = createTurnActivity(0);
    pushToolStep(activity, 'Read', { file_path: '/x/relay.ts' }, 'read-1');
    setActivityNotice(activity, '模型服务繁忙，正在自动重试（1/4）…');

    expect(activity.totalSteps).toBe(1);
    expect(renderActivity(activity, 5_000).split('\n')).toEqual([
      '⚙️ 工作中 · 1 项 · 5s',
      '> ✓ 读取 relay.ts',
      '> ⏳ 模型服务繁忙，正在自动重试（1/4）…',
    ]);
  });

  it('重复内容不算变化(不浪费渠道 update 配额)', () => {
    const activity = createTurnActivity(0);
    expect(setActivityNotice(activity, '模型服务繁忙，正在自动重试（1/4）…')).toBe(true);
    expect(setActivityNotice(activity, '模型服务繁忙，正在自动重试（1/4）…')).toBe(false);
    expect(setActivityNotice(activity, '模型服务繁忙，正在自动重试（2/4）…')).toBe(true);
    expect(setActivityNotice(activity, null)).toBe(true);
    expect(activity.notice).toBeNull();
    expect(setActivityNotice(activity, '   ')).toBe(false);
  });

  it('清掉状态行后渲染里不再残留它(终态收口依赖这条)', () => {
    // handleTurnErrorAsync 在 finalize 前会 setActivityNotice(null)：重试耗尽走到
    // 终态时，notice 还挂着「正在自动重试」，而 finalize 的正文由 composeStreamingView
    // 拼出——不清就会在失败说明的正上方永久显示"仍在重试"（review #844 codex P1）。
    const activity = createTurnActivity(0);
    pushToolStep(activity, 'Read', { file_path: '/x/relay.ts' }, 'read-1');
    setActivityNotice(activity, '模型服务繁忙，正在自动重试（4/4）…');
    expect(renderActivity(activity, 5_000)).toContain('正在自动重试');

    setActivityNotice(activity, null);
    const finalView = renderActivity(activity, 5_000);
    expect(finalView).not.toContain('正在自动重试');
    // 已完成的工作项照常保留，只有瞬态状态行消失。
    expect(finalView).toContain('读取 relay.ts');
  });

  it('任何真实进展都清掉过期状态行', () => {
    const withTool = createTurnActivity(0);
    setActivityNotice(withTool, '模型服务繁忙，正在自动重试（1/4）…');
    pushToolStep(withTool, 'Grep', { pattern: 'x' }, 'grep-1');
    expect(withTool.notice).toBeNull();

    const withThinking = createTurnActivity(0);
    setActivityNotice(withThinking, '模型服务繁忙，正在自动重试（1/4）…');
    pushThinkingStep(withThinking, { stage: 'final', blockId: 't1', text: '继续检查' });
    expect(withThinking.notice).toBeNull();

    const withText = createTurnActivity(0);
    setActivityNotice(withText, '模型服务繁忙，正在自动重试（1/4）…');
    markActivityWriting(withText);
    expect(withText.notice).toBeNull();
    // 正文已在流, 过程区回到"无内容"→ 与旧行为逐字一致(纯文本快答无 chrome)。
    expect(renderActivity(withText, 1_000)).toBe('');
  });
});
