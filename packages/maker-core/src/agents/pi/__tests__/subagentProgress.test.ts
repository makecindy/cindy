import { describe, expect, it } from 'vitest';

import { parsePiSubagentProgress } from '../subagent-progress.js';

/** 模拟 pi 工具 onUpdate 的中间结果:标记与数据都在 details 下。 */
function payload(extra: Record<string, unknown> = {}): unknown {
  return { details: { __cindySubagent: 1, taskId: 'sa-1', status: 'running', ...extra } };
}

describe('parsePiSubagentProgress', () => {
  it('maps a progress notify onto the shared agent task card fields', () => {
    expect(
      parsePiSubagentProgress(
        payload({
          agentName: 'scout',
          task: 'survey the auth flow',
          model: 'claude-haiku-4-5',
          totalTokens: 12_345,
          toolUses: 7,
          durationMs: 4_200,
        }),
      ),
    ).toEqual({
      provider: 'pi',
      taskId: 'sa-1',
      parentToolUseId: 'sa-1',
      status: 'running',
      title: 'scout',
      description: 'survey the auth flow',
      model: 'claude-haiku-4-5',
      usage: { totalTokens: 12_345, toolUses: 7, durationMs: 4_200 },
    });
  });

  it('carries terminal states and the final summary', () => {
    for (const status of ['completed', 'failed', 'stopped'] as const) {
      const update = parsePiSubagentProgress(payload({ status, summary: 'found 3 call sites' }));
      expect(update?.status).toBe(status);
      expect(update?.summary).toBe('found 3 call sites');
    }
  });

  it('ignores partial results that are not marked cindy subagent progress', () => {
    // 别的工具流式上报(bash 的 partialResult 等)不得被误认成子代理进度。
    expect(parsePiSubagentProgress({ content: [{ type: 'text', text: 'Working...' }] })).toBeNull();
    expect(parsePiSubagentProgress({ details: { taskId: 'sa-1', status: 'running' } })).toBeNull();
    // 标记必须是数字 1,字符串 '1' 不算(防松散判等放进无关载荷)。
    expect(parsePiSubagentProgress({ details: { __cindySubagent: '1', taskId: 'sa-1' } })).toBeNull();
    expect(parsePiSubagentProgress(undefined)).toBeNull();
    expect(parsePiSubagentProgress('running')).toBeNull();
    expect(parsePiSubagentProgress({ details: [{ __cindySubagent: 1 }] })).toBeNull();
  });

  it('requires a taskId — an unlinkable update cannot address a card', () => {
    expect(parsePiSubagentProgress({ details: { __cindySubagent: 1, status: 'running' } })).toBeNull();
    expect(parsePiSubagentProgress(payload({ taskId: '   ' }))).toBeNull();
  });

  it('never invents a terminal state for an unknown status', () => {
    // 不猜:状态不认识时按 running,把跑着的子代理显示成已完成比没状态更糟。
    expect(parsePiSubagentProgress(payload({ status: 'bogus' }))?.status).toBe('running');
    expect(parsePiSubagentProgress(payload({ status: undefined }))?.status).toBe('running');
  });

  it('drops malformed usage numbers instead of surfacing them', () => {
    const update = parsePiSubagentProgress(
      payload({ totalTokens: -5, toolUses: Number.NaN, durationMs: 'soon' }),
    );
    expect(update?.usage).toBeUndefined();
  });

  it('keeps partial usage when only some counters are known', () => {
    expect(parsePiSubagentProgress(payload({ toolUses: 2 }))?.usage).toEqual({ toolUses: 2 });
  });

  it('never rewrites taskId — a truncated id would stop matching the same card', () => {
    // taskId 是卡片/tool_use 的关联键。此前按 200 字符截断并追加省略号,超长 id 会被改写成
    // 新值,后续 update 命中不到同一张卡(卡片停更或另开一张)。
    const longId = 'sa-' + 'x'.repeat(500);
    const update = parsePiSubagentProgress(payload({ taskId: longId }));
    expect(update?.taskId).toBe(longId);
    expect(update?.parentToolUseId).toBe(longId);
    expect(update?.taskId).not.toContain('…');
    // 仅 trim,不改内容。
    expect(parsePiSubagentProgress(payload({ taskId: '  sa-9  ' }))?.taskId).toBe('sa-9');
  });

  it('truncates long text so a chatty subagent cannot flood the event stream', () => {
    const update = parsePiSubagentProgress(payload({ task: 'x'.repeat(5_000) }));
    expect(update?.description?.length).toBe(2_000);
    expect(update?.description?.endsWith('…')).toBe(true);
  });
});
