import { describe, expect, it } from 'vitest';

import { ToolLoopGuard, classifyToolContractError, type ToolLoopGuardVerdict } from './loop-guard.js';

/** 喂一次完整 tool_use → tool_result, 返回 guard 判定。id 唯一即可。 */
function feed(
  guard: ToolLoopGuard,
  id: string,
  name: string,
  input: unknown,
  output: string,
  isError = false,
  toolResultBatchId?: string,
): ToolLoopGuardVerdict {
  guard.onToolUse(id, name, input);
  return guard.onToolResult(id, output, isError, toolResultBatchId);
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

  // ── 第 3 层: 长窗口轮转(ABCD…) ───────────────────────────────────────────
  it('4 个不同调用轮转(ABCDABCD…)在轮转窗口填满时判 rotation(对应 grok 4-Grep 实锤)', () => {
    const g = new ToolLoopGuard(); // rotationWindowSize 16, rotationDistinct<=4
    const cmds = ['grep -R a', 'grep -R b', 'grep -R c', 'grep -R d'];
    for (let i = 0; i < 16; i += 1) {
      const v = feed(g, `id${i}`, 'Grep', { pattern: cmds[i % 4] }, `hits-${i}`);
      if (i < 15) expect(v.kind).toBe('ok');
      else expect(v).toMatchObject({ kind: 'hard', reason: 'rotation', count: 16, toolName: 'Grep' });
    }
  });

  it('3 个不同调用轮转同样被 rotation 层捕获', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 16; i += 1) {
      const v = feed(g, `id${i}`, 'Bash', { cmd: `check-${i % 3}` }, `o${i}`);
      if (i < 15) expect(v.kind).toBe('ok');
      else expect(v).toMatchObject({ kind: 'hard', reason: 'rotation' });
    }
  });

  it('5 个不同调用轮转不判 rotation(distinct 超过上限,留给更长证据)', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 40; i += 1) {
      expect(feed(g, `id${i}`, 'Bash', { cmd: `probe-${i % 5}` }, `o${i}`).kind).toBe('ok');
    }
  });

  it('轮转中途出现新调用会把窗口 distinct 顶出上限,不误判', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 48; i += 1) {
      // 每 8 次插入一个全新 input:任何 16 连续窗口 distinct ≥ 5
      const input = i % 8 === 7 ? { cmd: `novel-${i}` } : { cmd: `fix-${i % 4}` };
      expect(feed(g, `id${i}`, 'Bash', input, `o${i}`).kind).toBe('ok');
    }
  });

  // ── 合法长 turn / 原生轮询工具 ───────────────────────────────────────────
  it('TaskOutput 状态长期不变仍放行,不会被通用重复判据中断', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 250; i += 1) {
      expect(
        feed(
          g,
          `id${i}`,
          'TaskOutput',
          { task_id: 'task-1', block: true, timeout: 30_000 },
          'still running',
        ).kind,
      ).toBe('ok');
    }
  });

  it('TaskOutput 不会隐藏穿插在轮询之间的连续普通工具循环', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 4; i += 1) {
      const ordinary = feed(g, `bash-${i}`, 'Bash', { cmd: 'ls' }, 'same');
      if (i < 3) expect(ordinary.kind).toBe('ok');
      else expect(ordinary).toMatchObject({ kind: 'hard', reason: 'consecutive' });

      expect(
        feed(
          g,
          `poll-${i}`,
          'TaskOutput',
          { task_id: 'task-1', block: true, timeout: 30_000 },
          'still running',
        ).kind,
      ).toBe('ok');
    }
  });

  it('TaskOutput 不会隐藏穿插在轮询之间的 ABAB 普通工具循环', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 12; i += 1) {
      const ordinary = feed(
        g,
        `ordinary-${i}`,
        'Bash',
        i % 2 === 0 ? { cmd: 'python run.py' } : { cmd: 'p4 sync' },
        `output-${i}`,
      );
      if (i < 11) expect(ordinary.kind).toBe('ok');
      else expect(ordinary).toMatchObject({ kind: 'hard', reason: 'pingpong' });

      expect(
        feed(
          g,
          `poll-${i}`,
          'TaskOutput',
          { task_id: 'task-1', block: true, timeout: 30_000 },
          'still running',
        ).kind,
      ).toBe('ok');
    }
  });

  it('三十三项固定序列不会被有限窗口冒充为通用硬上限', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 198; i += 1) {
      const position = i % 33;
      expect(
        feed(
          g,
          `id${i}`,
          'Read',
          { file: `project-${position}.json` },
          `stable-${position}`,
        ).kind,
      ).toBe('ok');
    }
  });

  it('参数持续变化时即使结果高度重复也不判 hard', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 250; i += 1) {
      expect(feed(g, `id${i}`, 'Read', { file: `missing-${i}.ts` }, 'not found').kind).toBe('ok');
    }
  });

  it('参数持续变化且结果为空或纯空白时也不判 hard', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 250; i += 1) {
      const output = i % 2 === 0 ? '' : '   ';
      expect(feed(g, `id${i}`, 'Write', { file: `f${i}.ts` }, output).kind).toBe('ok');
    }
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

  // ── 第 4 层: 同类契约错误 streak(input 各不相同也计) ─────────────────────
  const MISSING = 'InputValidationError: Edit failed due to the following issue: The required parameter `file_path` is missing';

  it('同工具连续 3 次同类契约错误判 contract,input 各不相同也计(对应 grok 16 次 Edit 缺 file_path 实锤)', () => {
    const g = new ToolLoopGuard();
    expect(feed(g, 'e0', 'Edit', { old_string: 'a', new_string: 'b' }, MISSING, true).kind).toBe('ok');
    expect(feed(g, 'e1', 'Edit', { old_string: 'c', new_string: 'd' }, MISSING, true).kind).toBe('ok');
    expect(feed(g, 'e2', 'Edit', { old_string: 'e', new_string: 'f' }, MISSING, true)).toMatchObject({
      kind: 'hard',
      reason: 'contract',
      count: 3,
      toolName: 'Edit',
      contractCategory: 'missing_required_field',
    });
  });

  it('中间插入成功结果打断契约错误的"连续"', () => {
    const g = new ToolLoopGuard();
    feed(g, 'e0', 'Edit', { old_string: 'a' }, MISSING, true);
    feed(g, 'e1', 'Edit', { old_string: 'b' }, MISSING, true);
    // 成功输出重置 streak
    expect(feed(g, 'ok', 'Edit', { file_path: '/f', old_string: 'x', new_string: 'y' }, 'The file /f has been updated.').kind).toBe('ok');
    expect(feed(g, 'e2', 'Edit', { old_string: 'c' }, MISSING, true).kind).toBe('ok'); // 重新从 1 计
    expect(feed(g, 'e3', 'Edit', { old_string: 'd' }, MISSING, true).kind).toBe('ok'); // 2
    expect(feed(g, 'e4', 'Edit', { old_string: 'e' }, MISSING, true)).toMatchObject({ kind: 'hard', reason: 'contract' });
  });

  it('交替类别不判 contract(stale / ambiguous 各自重新计数)', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 12; i += 1) {
      const output = i % 2 === 0
        ? 'String to replace not found in file.'
        : 'Found 2 matches of the string to replace, but replace_all is false.';
      // 类别交替 → 每次键都换,streak 恒为 1;但第 2/3 层若命中(input 相同)与本层无关,
      // 这里让 input 每次都不同,隔离只测第 4 层。
      expect(feed(g, `alt-${i}`, 'Edit', { old_string: `s-${i}` }, output).kind).toBe('ok');
    }
  });

  it('同类别跨不同工具不累计(键含工具名)', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 12; i += 1) {
      const tool = i % 2 === 0 ? 'Edit' : 'Write';
      expect(feed(g, `x-${i}`, tool, { n: i }, MISSING.replace('Edit', tool), true).kind).toBe('ok');
    }
  });

  it('未识别的错误(other)永不触发熔断', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 50; i += 1) {
      expect(feed(g, `u-${i}`, 'Bash', { cmd: `c-${i}` }, `Error: something odd happened (${i})`).kind).toBe('ok');
    }
  });

  it('TaskOutput 轮询穿插在契约错误之间不重置 streak,也不隐藏它', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 3; i += 1) {
      const v = feed(g, `e-${i}`, 'Edit', { old_string: `s-${i}` }, MISSING, true);
      if (i < 2) expect(v.kind).toBe('ok');
      else expect(v).toMatchObject({ kind: 'hard', reason: 'contract', count: 3 });

      expect(
        feed(g, `poll-${i}`, 'TaskOutput', { task_id: 't', block: true, timeout: 30_000 }, 'still running').kind,
      ).toBe('ok');
    }
  });

  it('成功输出恰好包含错误文案短语时被长度门挡在分类外(编辑含文案的测试文件)', () => {
    const g = new ToolLoopGuard();
    const longEcho = `The file /repo/loop-guard.test.ts has been updated. Here is a snippet:\n${'x'.repeat(700)}\nString to replace not found in file.`;
    for (let i = 0; i < 10; i += 1) {
      expect(feed(g, `echo-${i}`, 'Edit', { old_string: `s-${i}` }, longEcho, false).kind).toBe('ok');
    }
  });

  it('成功结果即使包含短错误文案也不会进入契约错误熔断', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 6; i += 1) {
      expect(
        feed(g, `read-${i}`, 'Read', { file_path: `fixture-${i}.txt` }, 'The pages must be numbered', false).kind,
      ).toBe('ok');
    }
  });

  it('resetTurn 同样清空契约错误计数', () => {
    const g = new ToolLoopGuard();
    feed(g, 'c0', 'Edit', { old_string: 'a' }, MISSING, true);
    feed(g, 'c1', 'Edit', { old_string: 'b' }, MISSING, true); // streak 2

    g.resetTurn();

    expect(feed(g, 'd0', 'Edit', { old_string: 'c' }, MISSING, true).kind).toBe('ok'); // 重新从 1
    expect(feed(g, 'd1', 'Edit', { old_string: 'd' }, MISSING, true).kind).toBe('ok'); // 2
    expect(feed(g, 'd2', 'Edit', { old_string: 'e' }, MISSING, true)).toMatchObject({ kind: 'hard', reason: 'contract' });
  });

  it('同一 assistant 批次的多个同类失败只计一次,模型仍有机会看到第一批错误', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 3; i += 1) {
      expect(
        feed(g, `batch-a-${i}`, 'Edit', { old_string: `a-${i}` }, MISSING, true, 'batch-a').kind,
      ).toBe('ok');
    }

    expect(feed(g, 'batch-b-0', 'Edit', { old_string: 'b-0' }, MISSING, true, 'batch-b').kind).toBe('ok');
    expect(feed(g, 'batch-c-0', 'Edit', { old_string: 'c-0' }, MISSING, true, 'batch-c')).toMatchObject({
      kind: 'hard',
      reason: 'contract',
      count: 3,
      toolName: 'Edit',
      contractCategory: 'missing_required_field',
    });
  });

  it('同一批次去重仍要求 is_error=true', () => {
    const g = new ToolLoopGuard();
    for (let i = 0; i < 4; i += 1) {
      expect(feed(g, `success-${i}`, 'Edit', { old_string: `s-${i}` }, MISSING, false, 'same-batch').kind).toBe('ok');
    }
    expect(feed(g, 'failed', 'Edit', { old_string: 'failed' }, MISSING, true, 'next-batch').kind).toBe('ok');
  });

  it('同批次无关成功结果不清零契约 streak,下一批次才继续累计', () => {
    const g = new ToolLoopGuard();

    expect(feed(g, 'bad-a', 'Edit', { old_string: 'a' }, MISSING, true, 'batch-a').kind).toBe('ok');
    // 结果顺序若为 malformed Edit → successful Read, 不应把第一批失败抹掉。
    expect(feed(g, 'read-a', 'Read', { file_path: 'context.txt' }, 'read ok', false, 'batch-a').kind).toBe('ok');

    expect(feed(g, 'bad-b', 'Edit', { old_string: 'b' }, MISSING, true, 'batch-b').kind).toBe('ok');
    expect(feed(g, 'read-b', 'Read', { file_path: 'context.txt' }, 'read ok', false, 'batch-b').kind).toBe('ok');

    expect(feed(g, 'bad-c', 'Edit', { old_string: 'c' }, MISSING, true, 'batch-c')).toMatchObject({
      kind: 'hard',
      reason: 'contract',
      count: 3,
      contractCategory: 'missing_required_field',
    });
  });

  it('同批次成功结果先到也不清零契约 streak,结果顺序不影响跨批次计数', () => {
    const g = new ToolLoopGuard();

    for (const [index, batchId] of ['batch-a', 'batch-b'].entries()) {
      expect(
        feed(g, `read-${index}`, 'Read', { file_path: 'context.txt' }, 'read ok', false, batchId).kind,
      ).toBe('ok');
      expect(
        feed(g, `bad-${index}`, 'Edit', { old_string: `s-${index}` }, MISSING, true, batchId).kind,
      ).toBe('ok');
    }

    expect(feed(g, 'read-c', 'Read', { file_path: 'context.txt' }, 'read ok', false, 'batch-c').kind).toBe('ok');
    expect(feed(g, 'bad-c', 'Edit', { old_string: 'c' }, MISSING, true, 'batch-c')).toMatchObject({
      kind: 'hard',
      reason: 'contract',
      count: 3,
      contractCategory: 'missing_required_field',
    });
  });

  it('同批次其它契约类别先到也不清零目标类别 streak', () => {
    const g = new ToolLoopGuard();
    const stale = 'String to replace not found in file.';

    expect(feed(g, 'missing-a', 'Edit', { old_string: 'a' }, MISSING, true, 'batch-a').kind).toBe('ok');
    expect(feed(g, 'stale-b', 'Edit', { old_string: 'b' }, stale, true, 'batch-b').kind).toBe('ok');
    expect(feed(g, 'missing-b', 'Edit', { old_string: 'b' }, MISSING, true, 'batch-b').kind).toBe('ok');
    expect(feed(g, 'missing-c', 'Edit', { old_string: 'c' }, MISSING, true, 'batch-c')).toMatchObject({
      kind: 'hard',
      reason: 'contract',
      count: 3,
      contractCategory: 'missing_required_field',
    });
  });

  it('批次标识流与旧版无批次调用不串用契约 streak', () => {
    const g = new ToolLoopGuard();

    expect(feed(g, 'legacy-a', 'Edit', { old_string: 'a' }, MISSING, true).kind).toBe('ok');
    expect(feed(g, 'legacy-b', 'Edit', { old_string: 'b' }, MISSING, true).kind).toBe('ok');

    expect(feed(g, 'batch-a', 'Edit', { old_string: 'c' }, MISSING, true, 'batch-a').kind).toBe('ok');
    expect(feed(g, 'batch-b', 'Edit', { old_string: 'd' }, MISSING, true, 'batch-b').kind).toBe('ok');

    // Switching back to the legacy callback shape starts a fresh streak rather
    // than inheriting the two legacy failures from before the batch stream.
    expect(feed(g, 'legacy-c', 'Edit', { old_string: 'e' }, MISSING, true).kind).toBe('ok');
    expect(feed(g, 'legacy-d', 'Edit', { old_string: 'f' }, MISSING, true).kind).toBe('ok');
    expect(feed(g, 'legacy-e', 'Edit', { old_string: 'g' }, MISSING, true)).toMatchObject({
      kind: 'hard',
      reason: 'contract',
      count: 3,
    });
  });
});

describe('classifyToolContractError', () => {
  it('逐类别识别稳定错误文案', () => {
    expect(classifyToolContractError('Edit', 'The required parameter `file_path` is missing')).toBe('missing_required_field');
    expect(classifyToolContractError('Write', 'missing required parameter "content"')).toBe('missing_required_field');
    expect(classifyToolContractError('Read', 'Invalid pages parameter: "abc"')).toBe('invalid_pages');
    expect(classifyToolContractError('Read', 'The `pages` parameter is only applicable to PDF files')).toBe('invalid_pages');
    expect(classifyToolContractError('Edit', 'String to replace not found in file.')).toBe('stale_locator');
    expect(classifyToolContractError('Edit', 'Found 2 matches of the string to replace, but replace_all is false.')).toBe('ambiguous_locator');
    expect(classifyToolContractError('Edit', 'No changes to make: old_string and new_string are exactly the same.')).toBe('no_changes');
  });

  it('工具限定:Edit 专属类别不套在别的工具上;pages 只认 Read', () => {
    expect(classifyToolContractError('Bash', 'String to replace not found in file.')).toBe(null);
    expect(classifyToolContractError('Grep', 'invalid pages')).toBe(null);
  });

  it('Bash 转发的 CLI "missing required parameter" 不算契约错误(用户脚本报错不熔断)', () => {
    expect(classifyToolContractError('Bash', 'mycli: missing required parameter --env')).toBe(null);
    expect(classifyToolContractError('Bash', 'Error: required parameter "--token" is missing')).toBe(null);
  });

  it('空输出 / 超长输出 / 未知错误返回 null', () => {
    expect(classifyToolContractError('Edit', '')).toBe(null);
    expect(classifyToolContractError('Edit', `${'x'.repeat(700)} String to replace not found`)).toBe(null);
    expect(classifyToolContractError('Edit', 'Error: disk full')).toBe(null);
  });
});
