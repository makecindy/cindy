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
      update: {
        provider: 'pi',
        taskId: 'sa-1',
        parentToolUseId: 'sa-1',
        status: 'running',
        title: 'scout',
        description: 'survey the auth flow',
        model: 'claude-haiku-4-5',
        usage: { totalTokens: 12_345, toolUses: 7, durationMs: 4_200 },
      },
    });
  });

  it('carries terminal states and the final summary', () => {
    for (const status of ['completed', 'failed', 'stopped'] as const) {
      const update = parsePiSubagentProgress(payload({ status, summary: 'found 3 call sites' }));
      expect(update?.update.status).toBe(status);
      expect(update?.update.summary).toBe('found 3 call sites');
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
    expect(parsePiSubagentProgress(payload({ status: 'bogus' }))?.update.status).toBe('running');
    expect(parsePiSubagentProgress(payload({ status: undefined }))?.update.status).toBe('running');
  });

  it('drops malformed usage numbers instead of surfacing them', () => {
    const update = parsePiSubagentProgress(
      payload({ totalTokens: -5, toolUses: Number.NaN, durationMs: 'soon' }),
    );
    expect(update?.update.usage).toBeUndefined();
  });

  it('keeps partial usage when only some counters are known', () => {
    expect(parsePiSubagentProgress(payload({ toolUses: 2 }))?.update.usage).toEqual({ toolUses: 2 });
  });

  it('never rewrites taskId — a truncated id would stop matching the same card', () => {
    // taskId 是卡片/tool_use 的关联键。此前按 200 字符截断并追加省略号,超长 id 会被改写成
    // 新值,后续 update 命中不到同一张卡(卡片停更或另开一张)。
    const longId = 'sa-' + 'x'.repeat(500);
    const update = parsePiSubagentProgress(payload({ taskId: longId }));
    expect(update?.update.taskId).toBe(longId);
    expect(update?.update.parentToolUseId).toBe(longId);
    expect(update?.update.taskId).not.toContain('…');
    // 仅 trim,不改内容。
    expect(parsePiSubagentProgress(payload({ taskId: '  sa-9  ' }))?.update.taskId).toBe('sa-9');
  });

  it('surfaces the delegated usage components so the parent turn can account for them', () => {
    // 子代理是独立 pi 进程,请求不走父进程的 usage 流。分量必须逐项带出来(含 cost),
    // 父侧才能并进 turn 记账 → register.ts 持久化的 session token/cost 才含委派花费(review)。
    const progress = parsePiSubagentProgress(
      payload({ usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 2, cost: 0.0125 } }),
    );
    expect(progress?.delegatedUsage).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 2, cost: 0.0125 });
  });

  it('drops an all-zero or malformed delegated usage payload', () => {
    // 全零帧不该在父侧建立记账条目;坏值按 0 处理而不是把 NaN 灌进 turn 计数。
    expect(parsePiSubagentProgress(payload({ usage: { input: 0, output: 0 } }))?.delegatedUsage).toBeUndefined();
    expect(parsePiSubagentProgress(payload({ usage: 'nope' }))?.delegatedUsage).toBeUndefined();
    expect(parsePiSubagentProgress(payload())?.delegatedUsage).toBeUndefined();
    expect(
      parsePiSubagentProgress(payload({ usage: { input: Number.NaN, output: -3, cost: 1 } }))?.delegatedUsage,
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1 });
  });

  it('truncates long text so a chatty subagent cannot flood the event stream', () => {
    const update = parsePiSubagentProgress(payload({ task: 'x'.repeat(5_000) }));
    expect(update?.update.description?.length).toBe(2_000);
    expect(update?.update.description?.endsWith('…')).toBe(true);
  });
});
