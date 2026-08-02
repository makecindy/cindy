import { describe, expect, it } from 'vitest';

import {
  selectRecentTitleMessages,
  type TitleMessageCandidate,
} from '../latestMessageText.logic.js';

function row(
  role: 'user' | 'assistant',
  rowid: number,
  text: string,
  agentMeta: Record<string, unknown> | null = null,
  toolUseId: string | null = null,
): TitleMessageCandidate {
  return { role, rowid, text, createdAt: rowid, toolUseId, agentMeta };
}

describe('selectRecentTitleMessages', () => {
  it('replays the problematic session shape without feeding assistant progress narration', () => {
    // Real text copied from session d3ae62e2-316b-4570-b163-25a99e4ca386. The fixture
    // keeps only the rows needed to reproduce the title bug; metadata mirrors the DB.
    const rows = [
      row(
        'user',
        1201000,
        '[供应商后台列表拖拽排序](cindy://session/cc2031db-dd60-4274-9dc2-997643594fd2) 你看看这个任务。我们自己的Codex总感觉不太对，新对话，没干多久就压缩了，甚至一个任务都执行不完',
      ),
      row('assistant', 1211101, '好,这就开工。这是一次产品行为变更 + UI 改动,我按仓库流程来。', {
        uuid: 'progress-1',
      }),
      row('assistant', 1211276, 'Findings below。', { uuid: 'progress-2' }),
      row('assistant', 1211935, '唯一消费方就是 spawn 拼接处,无其他断言。等门禁结果。', {
        uuid: 'progress-3',
      }),
      row('assistant', 1212073, '全部完成,门禁通过。', {
        uuid: 'final-1',
        turnCompleted: true,
      }),
      row('user', 1212401, '我本地测试下你告诉我要怎么测试'),
      row(
        'assistant',
        1212485,
        '好,这次改动不含数据库 migration,可以直接用共享登录态起测试实例。',
        {
          uuid: 'progress-4',
        },
      ),
      row('assistant', 1215120, '开发版已启动并验证通过,你可以直接测了。', {
        uuid: 'final-2',
        turnCompleted: true,
      }),
      row(
        'user',
        1215252,
        '发现还是在 UI 上看不到任何 subagent，你来检查一下我的对话记录，看看是为什么？',
      ),
      row('assistant', 1215502, '形态对齐完毕,实现 translator 的 subAgentActivity 处理。', {
        uuid: 'progress-5',
      }),
      row('assistant', 1215855, '问题查清并已修复,开发版也重启好了。', {
        uuid: 'final-3',
        turnCompleted: true,
      }),
    ];

    const selected = selectRecentTitleMessages(rows, 8);

    expect(selected.map((message) => message.text)).toEqual([
      '[供应商后台列表拖拽排序](cindy://session/cc2031db-dd60-4274-9dc2-997643594fd2) 你看看这个任务。我们自己的Codex总感觉不太对，新对话，没干多久就压缩了，甚至一个任务都执行不完',
      '全部完成,门禁通过。',
      '我本地测试下你告诉我要怎么测试',
      '开发版已启动并验证通过,你可以直接测了。',
      '发现还是在 UI 上看不到任何 subagent，你来检查一下我的对话记录，看看是为什么？',
      '问题查清并已修复,开发版也重启好了。',
    ]);
    expect(selected.every((message) => !message.text.includes('Findings below'))).toBe(true);
    expect(selected.every((message) => !message.text.includes('等门禁结果'))).toBe(true);
  });

  it('keeps an unfinished current user message but drops its progress rows', () => {
    const rows = [
      row('user', 1, '原始需求：排查 Codex 压缩'),
      row('assistant', 2, '已完成调查', { turnCompleted: true }),
      row('user', 3, '继续改这个问题'),
      row('assistant', 4, '我先读规则文件', { uuid: 'in-flight-1' }),
      row('assistant', 5, '再看测试', { uuid: 'in-flight-2' }),
    ];

    expect(selectRecentTitleMessages(rows, 8).map((message) => message.text)).toEqual([
      '原始需求：排查 Codex 压缩',
      '已完成调查',
      '继续改这个问题',
    ]);
  });

  it('drops first-turn progress when runtime reports the latest turn is still in flight', () => {
    const rows = [
      row('user', 1, '原始需求：修复任务标题'),
      row('assistant', 2, '我先检查日志', { uuid: 'first-progress-1' }),
      row('assistant', 3, '再读取相关代码', { uuid: 'first-progress-2' }),
    ];

    expect(
      selectRecentTitleMessages(rows, 8, new Set(), true).map((message) => message.text),
    ).toEqual(['原始需求：修复任务标题']);
  });

  it('uses the old last-assistant fallback only when a turn has no boundary metadata', () => {
    const rows = [
      row('user', 1, '老会话'),
      row('assistant', 2, '中间播报'),
      row('assistant', 3, '老数据最终回复'),
    ];
    expect(selectRecentTitleMessages(rows, 8).map((message) => message.text)).toEqual([
      '老会话',
      '老数据最终回复',
    ]);
  });

  it('never selects a subagent assistant as the legacy fallback', () => {
    const rows = [
      row('user', 1, '检查协同 UI'),
      row('assistant', 2, 'subagent 内部播报', { parentUuid: 'toolu-1' }),
      row('assistant', 3, '主线程最终回复'),
    ];
    expect(selectRecentTitleMessages(rows, 8).map((message) => message.text)).toEqual([
      '检查协同 UI',
      '主线程最终回复',
    ]);
  });

  it('keeps legacy Claude transcript parentUuid while excluding confirmed tool parents', () => {
    const rows = [
      row('user', 1, '旧 Claude 导入任务'),
      row('assistant', 2, '普通顶层答复', {
        uuid: 'assistant-uuid',
        parentUuid: 'preceding-user-uuid',
      }),
      row('assistant', 3, 'Subagent 内部答复', {
        uuid: 'subagent-uuid',
        parentUuid: 'legacy-tool-parent-uuid',
      }),
      row('assistant', 4, '最终顶层答复', {
        uuid: 'assistant-final-uuid',
        parentUuid: 'preceding-user-uuid-2',
      }),
    ];

    expect(
      selectRecentTitleMessages(rows, 8, new Set(['legacy-tool-parent-uuid'])).map(
        (message) => message.text,
      ),
    ).toEqual(['旧 Claude 导入任务', '最终顶层答复']);
  });

  it('keeps legacy and sealed turns together without globally dropping old assistants', () => {
    const rows = [
      row('user', 1, '旧轮次'),
      row('assistant', 2, '旧轮次答复'),
      row('user', 3, '新轮次'),
      row('assistant', 4, '新轮次答复', { turnCompleted: true }),
    ];

    expect(selectRecentTitleMessages(rows, 8).map((message) => message.text)).toEqual([
      '旧轮次',
      '旧轮次答复',
      '新轮次',
      '新轮次答复',
    ]);
  });

  it('preserves assistant-only imported or worker sessions', () => {
    const rows = [row('assistant', 1, '定时任务开始'), row('assistant', 2, '定时任务已执行完成')];

    expect(selectRecentTitleMessages(rows, 8).map((message) => message.text)).toEqual([
      '定时任务已执行完成',
    ]);
  });

  it('keeps complete turns when the message budget would otherwise start with an orphan assistant', () => {
    const rows = [
      row('user', 1, '第一轮'),
      row('assistant', 2, '第一轮完成', { turnCompleted: true }),
      row('user', 3, '第二轮'),
      row('assistant', 4, '第二轮完成', { turnCompleted: true }),
      row('user', 5, '第三轮'),
      row('assistant', 6, '第三轮完成', { turnCompleted: true }),
      row('user', 7, '第四轮'),
      row('assistant', 8, '第四轮完成', { turnCompleted: true }),
      row('user', 9, '第五轮'),
      row('assistant', 10, '第五轮完成', { turnCompleted: true }),
    ];

    const selected = selectRecentTitleMessages(rows, 8);
    expect(selected.map((message) => message.text)).toEqual([
      '第二轮',
      '第二轮完成',
      '第三轮',
      '第三轮完成',
      '第四轮',
      '第四轮完成',
      '第五轮',
      '第五轮完成',
    ]);
    expect(selected[0]?.role).toBe('user');
  });

  it('keeps visible steer text in the current turn while hiding automatic resume rows', () => {
    const rows = [
      row('user', 1, '原始任务'),
      row('assistant', 2, '已完成', { turnCompleted: true }),
      row('user', 3, '改为处理计费', { delivery: 'steer' }),
      row('assistant', 4, '续跑中的播报', { uuid: 'resume-progress-1' }),
      row('user', 5, '最终只检查退款', { delivery: 'steer' }),
      row('assistant', 6, '继续施工', { uuid: 'resume-progress-2' }),
      row('user', 7, '隐藏续跑', { autoResume: true }),
      row('assistant', 8, '续跑完成', { turnCompleted: true }),
    ];

    expect(selectRecentTitleMessages(rows, 8).map((message) => message.text)).toEqual([
      '原始任务',
      '改为处理计费',
      '最终只检查退款',
      '续跑完成',
    ]);
  });

  it('keeps a failed modern turn excluded after a later turn succeeds', () => {
    const rows = [
      row('user', 1, '修复登录问题'),
      row('assistant', 2, '我先检查鉴权日志', { uuid: 'failed-progress' }),
      row('assistant', 3, '仍在排查 token', {
        uuid: 'failed-final-progress',
        turnCompleted: false,
        turnCostUsd: 0.2,
        turnUsageDetails: { inputTokens: 100 },
      }),
      row('user', 4, '重试并改为检查计费'),
      row('assistant', 5, '已完成', { turnCompleted: true }),
    ];

    expect(selectRecentTitleMessages(rows, 8).map((message) => message.text)).toEqual([
      '修复登录问题',
      '重试并改为检查计费',
      '已完成',
    ]);
  });

  it('counts effective messages instead of raw rows when a turn is long', () => {
    const rows = [
      row('user', 1, '第一轮'),
      ...Array.from({ length: 12 }, (_, index) =>
        row('assistant', 2 + index, `施工播报 ${index}`, { uuid: `p-${index}` }),
      ),
      row('assistant', 20, '第一轮完成', { turnCompleted: true }),
      row('user', 21, '第二轮'),
      row('assistant', 22, '第二轮完成', { turnCompleted: true }),
    ];

    expect(selectRecentTitleMessages(rows, 4).map((message) => message.text)).toEqual([
      '第一轮',
      '第一轮完成',
      '第二轮',
      '第二轮完成',
    ]);
  });
});
