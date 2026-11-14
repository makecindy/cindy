/*
 * 测试价值
 * - 生产入口与可观察结果：summarizeInteraction（插件伙伴读挂起交互的一句摘要）与 parseActiveSessionList
 *   （get_task_digest 读另一台电脑的 maker:list-active）。
 * - Bug／规则依据：只对真正的权限请求暴露可批准的 requestId；新旧被控端两种返回都要收，读不懂不能当成「没有任务」。
 * - 现有覆盖缺口：随伙伴跟进观察层删除从 autonomyRules.test.ts 移来，行为不变。
 * - 最小失败输入：确认卡带 id；mcp__ 原始工具名；未知包装。
 * - tier：unit（纯函数）。
 */
import { describe, expect, it } from 'vitest';

import { parseActiveSessionList, summarizeInteraction } from '../taskPhase.js';

describe('pending interaction identity and active-session responses', () => {
  // 依据：同一相位里换了一条请求要重新计时；缺口：回答 / 确认卡的 id 被归成 null，换了也认不出。
  // 「允许」只对真正的权限请求：确认卡有 id 也不能成为可批准的 requestId。tier：unit。
  it('keeps every interaction id for change detection but only exposes permission ids for approval', () => {
    expect(summarizeInteraction({ kind: 'ask_user_question', requestId: 'q1', questions: [{ question: '用哪个分支？' }] }))
      .toEqual({ summary: '用哪个分支？', waitingFor: 'answer', requestId: null, interactionId: 'q1' });
    expect(summarizeInteraction({ kind: 'host_confirm', requestId: 'c1' }))
      .toEqual({ summary: null, waitingFor: 'permission', requestId: null, interactionId: 'c1' });
  });

  it('reads both the v2 wrapper and the legacy array from list-active, and rejects anything else', () => {
    const rows = [{ sessionId: 's1' }];
    expect(parseActiveSessionList({ format: 'active-sessions-v2', sessions: rows })).toBe(rows);
    expect(parseActiveSessionList(rows)).toBe(rows);
    expect(parseActiveSessionList({ format: 'unknown' })).toBeNull();
    expect(parseActiveSessionList(null)).toBeNull();
  });
});

describe('waiting-row summary for a permission request', () => {
  it('shows an MCP tool as "server · tool" instead of the raw mcp__ identifier, and keeps other names', () => {
    // Seen in the dev build: the glance row title was `mcp__cindy_helper__call_tool` (programmer-speak on a user-facing row).
    const mcp = summarizeInteraction({ kind: 'permission', requestId: 'r1', toolName: 'mcp__cindy_helper__call_tool' });
    expect(mcp).toEqual({ summary: 'cindy_helper · call_tool', waitingFor: 'permission', requestId: 'r1', interactionId: 'r1' });
    const bash = summarizeInteraction({ kind: 'permission', requestId: 'r2', title: 'bash' });
    expect(bash?.summary).toBe('bash');
  });
});
