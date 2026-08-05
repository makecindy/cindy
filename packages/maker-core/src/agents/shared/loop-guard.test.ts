import { describe, expect, it } from 'vitest';

import { ToolLoopGuard, type ToolLoopGuardVerdict } from './loop-guard.js';

/** 喂一次完整 tool_use → tool_result, 返回 guard 判定。id 唯一即可。 */
function feed(
  guard: ToolLoopGuard,
  id: string,
  name: string,
  input: unknown,
  output: string,
): ToolLoopGuardVerdict {
  guard.onToolUse(id, name, input);
  return guard.onToolResult(id, output);
}

describe('ToolLoopGuard', () => {
  // ── 第 1 层: 连续 name+input+output 完全相同 ──────────────────────────────
  it('在连续完全相同达到阈值时判 consecutive', () => {
    const g = new ToolLoopGuard(); // consecutiveLimit 默认 4
    for (let i = 0; i < 3; i += 1) {
      expect(feed(g, `id${i}`, 'Bash', { cmd: 'ls' }, 'out').kind).toBe('ok');
    }
    expect(feed(g, 'id3', 'Bash', { cmd: 'ls' }, 'out')).toMatchObject({
      kind: 'hard',
      reason: 'consecutive',
      toolName: 'Bash',
      count: 4,
    });
  });

  it('output 每次都变时不算 consecutive(窗口未满前放行)', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 5; i += 1) {
      expect(feed(g, `id${i}`, 'Bash', { cmd: 'date' }, `out-${i}`).kind).toBe('ok');
    }
  });

  // ── 第 2 层: name+input 滑动窗口多样性坍缩 ────────────────────────────────
  it('同 name+input 但 output 一直变, 窗口填满后判 pingpong(对应图里输出易变的重复)', () => {
    const g = new ToolLoopGuard(); // windowSize 12, distinct<=2
    for (let i = 0; i < 12; i += 1) {
      const v = feed(g, `id${i}`, 'Bash', { cmd: 'p4 status' }, `changelist-${i}`);
      if (i < 11) expect(v.kind).toBe('ok');
      else expect(v).toMatchObject({ kind: 'hard', reason: 'pingpong', count: 12 });
    }
  });

  it('ABAB 交替调用(两种 name+input 来回打转)判 pingpong', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 12; i += 1) {
      const isA = i % 2 === 0;
      const v = feed(
        g,
        `id${i}`,
        'Bash',
        isA ? { cmd: 'python run.py' } : { cmd: 'p4 sync' },
        `o${i}`,
      );
      if (i < 11) expect(v.kind).toBe('ok');
      else expect(v).toMatchObject({ kind: 'hard', reason: 'pingpong' });
    }
  });

  it('每次调用都不同(合法长任务)不误判', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 30; i += 1) {
      expect(feed(g, `id${i}`, 'Read', { file: `f${i}.ts` }, 'content').kind).toBe('ok');
    }
  });

  // ── 第 3 层: 单 turn tool result 硬上限 ───────────────────────────────────
  it('在 turn 内调用总数超硬上限时判 turn-cap(任何形态兜底)', () => {
    // 放宽前两层, 只验证兜底: 每次 input 都不同, 不会触发 consecutive / pingpong
    const g = new ToolLoopGuard({ turnHardCap: 5, windowSize: 1000, consecutiveLimit: 1000 });
    for (let i = 0; i < 5; i += 1) {
      expect(feed(g, `id${i}`, 'Read', { file: `f${i}` }, `o${i}`).kind).toBe('ok');
    }
    expect(feed(g, 'id5', 'Read', { file: 'f5' }, 'o5')).toMatchObject({
      kind: 'hard',
      reason: 'turn-cap',
      count: 6,
    });
  });

  // ── 配对 / 放行 ───────────────────────────────────────────────────────────
  it('没配到 tool_use 的孤立 result 直接放行', () => {
    const g = new ToolLoopGuard();
    expect(g.onToolResult('orphan', 'out').kind).toBe('ok');
  });

  it('半信息 tool_use(name 非 string)不缓存, result 配不到即放行', () => {
    const g = new ToolLoopGuard({ consecutiveLimit: 2 });
    for (let i = 0; i < 5; i += 1) {
      g.onToolUse(`id${i}`, undefined, { cmd: 'ls' });
      expect(g.onToolResult(`id${i}`, 'out').kind).toBe('ok');
    }
  });

  // ── reset ─────────────────────────────────────────────────────────────────
  it('resetTurn 清空全部计数', () => {
    const g = new ToolLoopGuard({ consecutiveLimit: 3 });
    feed(g, 'a0', 'Bash', { cmd: 'ls' }, 'o');
    feed(g, 'a1', 'Bash', { cmd: 'ls' }, 'o'); // streak 到 2

    g.resetTurn();

    expect(feed(g, 'b0', 'Bash', { cmd: 'ls' }, 'o').kind).toBe('ok'); // streak 重新从 1
    expect(feed(g, 'b1', 'Bash', { cmd: 'ls' }, 'o').kind).toBe('ok'); // 2
    expect(feed(g, 'b2', 'Bash', { cmd: 'ls' }, 'o')).toMatchObject({
      kind: 'hard',
      reason: 'consecutive',
    });
  });
});
