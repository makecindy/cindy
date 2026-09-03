import { describe, expect, it } from 'vitest';

import {
  extractAliveYieldCellsFromCodexItem,
  extractSettledYieldCellIdsFromCodexItem,
  extractYieldedExecCellIds,
  extractYieldedExecCellsFromCodexItem,
  formatYieldContinuationPrompt,
} from './yielded-exec-cell.js';

describe('extractYieldedExecCellIds', () => {
  it('locks the #3179 rollout yield shape', () => {
    expect(extractYieldedExecCellIds(
      'Script running with cell ID 226\nWall time 11.0 seconds\nOutput:\n',
    )).toEqual(['226']);
  });

  it('keeps later cells in order and dedupes repeats', () => {
    expect(extractYieldedExecCellIds([
      'Script running with cell ID 226\nWall time 1.0 seconds',
      'Script running with cell ID 229 Wall time 11.0 seconds Output:',
      'Script running with cell ID 226\nWall time 2.0 seconds',
    ].join('\n'))).toEqual(['226', '229']);
  });

  it('ignores finished command output without a yield marker', () => {
    expect(extractYieldedExecCellIds('Exit 0\n\n> tsc --noEmit\n')).toEqual([]);
  });

  // Windows 路径:执行器状态头以 CRLF 分行时同样是真实 yield,不得漏判(假完成)。
  it('recognizes a CRLF-delimited executor status header', () => {
    expect(extractYieldedExecCellIds(
      'Script running with cell ID 226\r\nWall time 11.0 seconds\r\nOutput:\r\n',
    )).toEqual(['226']);
    expect(extractYieldedExecCellIds(
      'chunk done\r\nScript running with cell ID 42\r\nWall time 1.0 seconds\r\n',
    )).toEqual(['42']);
  });

  // #3763:被引用/示例出现的 marker 文案不是执行器状态头,不得铸造 cell。
  it('ignores quoted or prefixed markers that are not executor status headers', () => {
    // grep 输出:路径:行号: 前缀,不在物理行首。
    expect(extractYieldedExecCellIds(
      "src/x.test.ts:14:      'Script running with cell ID 226\\nWall time 11.0 seconds',",
    )).toEqual([]);
    // 源码 cat:缩进 + 引号包裹,\n 是字面转义不是真实换行。
    expect(extractYieldedExecCellIds(
      "      'Script running with cell ID 229\\nWall time 11.0 seconds\\nOutput:\\n',",
    )).toEqual([]);
    // 行首但缺 Wall time 帧(裸引用一行文案)。
    expect(extractYieldedExecCellIds('Script running with cell ID 777')).toEqual([]);
    // issue 复现形态:一次读取源码把多个示例 ID 全炸出来 —— 现在必须为空。
    expect(extractYieldedExecCellIds([
      "  it('locks the #3179 rollout yield shape', () => {",
      "    expect(extractYieldedExecCellIds(",
      "      'Script running with cell ID 226\\nWall time 11.0 seconds\\nOutput:\\n',",
      "    )).toEqual(['226']);",
      "  'Script running with cell ID 229 Wall time', 'cell ID 11', 'cell ID 12',",
    ].join('\n'))).toEqual([]);
  });
});

describe('extractYieldedExecCellsFromCodexItem', () => {
  it('reads commandExecution.aggregatedOutput', () => {
    expect(extractYieldedExecCellsFromCodexItem({
      type: 'commandExecution',
      id: 'item-1',
      command: 'pnpm --filter desktop run typecheck',
      status: 'completed',
      aggregatedOutput: 'Script running with cell ID 226 Wall time 11.0 seconds Output:',
    })).toEqual([{
      cellId: '226',
      command: 'pnpm --filter desktop run typecheck',
    }]);
  });

  it('reads Responses/proxy function_call(exec_command) output text', () => {
    expect(extractYieldedExecCellsFromCodexItem({
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify({
        cmd: 'pnpm --filter desktop run typecheck',
        workdir: '/repo',
        yield_time_ms: 10_000,
      }),
      content: [{ type: 'output_text', text: 'Script running with cell ID 229\nWall time 10.0 seconds\nOutput:\n' }],
    })).toEqual([{
      cellId: '229',
      command: 'pnpm --filter desktop run typecheck',
    }]);
  });

  // #3763:已完成命令的 stdout 引用 marker 示例,不得铸造 continuation claim。
  it('does not mint cells from a completed exec whose stdout merely quotes markers', () => {
    expect(extractYieldedExecCellsFromCodexItem({
      type: 'commandExecution',
      id: 'item-quoted',
      command: 'grep -rn "cell ID" src/',
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: [
        "src/a.test.ts:14:      'Script running with cell ID 226\\nWall time 11.0 seconds',",
        "src/a.test.ts:21:      'Script running with cell ID 229 Wall time 11.0 seconds Output:',",
        "src/a.test.ts:75:      text: 'I will wait. Script running with cell ID 777',",
      ].join('\n'),
    })).toEqual([]);
  });

  it('does not treat a finished exec item as a yielded cell', () => {
    expect(extractYieldedExecCellsFromCodexItem({
      type: 'commandExecution',
      id: 'item-2',
      command: 'pnpm --filter desktop run typecheck',
      status: 'completed',
      aggregatedOutput: 'Exit 0',
      exitCode: 0,
    })).toEqual([]);
  });

  it('ignores yield text quoted by an agentMessage', () => {
    expect(extractYieldedExecCellsFromCodexItem({
      type: 'agentMessage',
      text: 'I will wait. Script running with cell ID 777',
    })).toEqual([]);
  });

  it('still finds a yield marker near the end of a long exec output', () => {
    const padding = 'x'.repeat(20_000);
    expect(extractYieldedExecCellsFromCodexItem({
      type: 'commandExecution',
      id: 'item-late-marker',
      command: 'pnpm --filter desktop run typecheck',
      aggregatedOutput: `${padding}\nScript running with cell ID 226\nWall time 30.0 seconds\nOutput:\n`,
    })).toEqual([{
      cellId: '226',
      command: 'pnpm --filter desktop run typecheck',
    }]);
  });
});

describe('extractSettledYieldCellIdsFromCodexItem', () => {
  it('clears a cell after wait reports Script completed', () => {
    expect(extractSettledYieldCellIdsFromCodexItem({
      type: 'function_call',
      name: 'wait',
      arguments: JSON.stringify({ cell_id: '11', max_tokens: 1000 }),
      content: [{ type: 'output_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }],
    })).toEqual(['11']);
  });

  it('keeps a cell outstanding when wait still yields the same cell', () => {
    expect(extractSettledYieldCellIdsFromCodexItem({
      type: 'function_call',
      name: 'wait',
      arguments: JSON.stringify({ cell_id: '11', yield_time_ms: 1000 }),
      content: [{ type: 'output_text', text: 'Script running with cell ID 11\nWall time 1.0 seconds\nOutput:\n' }],
    })).toEqual([]);
  });

  it('does not settle on a wait adapter error', () => {
    expect(extractSettledYieldCellIdsFromCodexItem({
      type: 'function_call',
      name: 'wait',
      arguments: JSON.stringify({ cell_id: '11' }),
      content: [{ type: 'output_text', text: 'unexpected adapter error' }],
    })).toEqual([]);
  });

  it('does not settle cell 11 from a running marker for a different cell', () => {
    expect(extractSettledYieldCellIdsFromCodexItem({
      type: 'function_call',
      name: 'wait',
      arguments: JSON.stringify({ cell_id: '11' }),
      content: [{ type: 'output_text', text: 'Script running with cell ID 12' }],
    })).toEqual([]);
  });
});

describe('extractAliveYieldCellsFromCodexItem', () => {
  it('treats a wait still printing the running marker as proof the cell is alive', () => {
    expect(extractAliveYieldCellsFromCodexItem({
      type: 'function_call',
      name: 'wait',
      arguments: JSON.stringify({ cell_id: '226', yield_time_ms: 1000 }),
      content: [{ type: 'output_text', text: 'Script running with cell ID 226\nWall time 1.0 seconds\nOutput:\n' }],
    })).toEqual([{ cellId: '226' }]);
  });

  it('does not treat a completed wait as an alive cell', () => {
    expect(extractAliveYieldCellsFromCodexItem({
      type: 'function_call',
      name: 'wait',
      arguments: JSON.stringify({ cell_id: '226', max_tokens: 1000 }),
      content: [{ type: 'output_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }],
    })).toEqual([]);
  });
});

describe('formatYieldContinuationPrompt', () => {
  it('asks the next provider turn to wait the same cells', () => {
    const prompt = formatYieldContinuationPrompt([
      { cellId: '226', command: 'pnpm --filter desktop run typecheck' },
    ]);
    expect(prompt).toContain('Wait for cell ID 226');
    expect(prompt).toContain('Do not start a new task');
    expect(prompt).toContain('report that it was lost');
    expect(prompt).not.toContain('pnpm --filter desktop run typecheck'.repeat(2));
  });
});
