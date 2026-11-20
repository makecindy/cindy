import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PI_PLAN_TODOS_SOURCE } from '../plan-todos-source.js';
import { buildPiPlanModeExtensionSource } from '../plan-mode-source.js';

// #8933 / unit: execute the generated production parser/adapter. The native
// integration tier covers JSONL, confirmation, progress and resume; these cases
// cover parser boundaries and delegation without a real process or filesystem.
type Todo = { step: number; text: string; completed: boolean };
const extract = runInNewContext(PI_PLAN_TODOS_SOURCE + '; extractTodoItems') as (text: string) => Todo[];
const selectPlan = runInNewContext(PI_PLAN_TODOS_SOURCE + '; selectPlanText') as
  (content: Array<{ type: string; text?: string; thinking?: string }>) => string;

describe('Pi plan title extraction', () => {
  it('retains the native thinking plan but not its unrelated preamble, and prefers a visible plan', () => {
    const thought = { type: 'thinking', thinking: 'Private reasoning.\n```\nPlan:\n1. Example\n```\nPlan:\n3. 验证\n7. 交付' };
    expect(selectPlan([thought])).toBe('Plan:\n3. 验证\n7. 交付');
    expect(selectPlan([thought, { type: 'text', text: 'Here is the plan.' }]))
      .toBe('Plan:\n3. 验证\n7. 交付\nHere is the plan.');
    expect(selectPlan([thought, { type: 'text', text: 'Details first.\nPlan:\n9. 发布' }]))
      .toBe('Details first.\nPlan:\n9. 发布');
  });

  it('retains a headerless numbered plan emitted only in thinking', () => {
    expect(selectPlan([{ type: 'thinking', thinking: 'Unrelated reasoning.\n1. 验证\n2. 交付' }]))
      .toBe('1. 验证\n2. 交付');
  });

  it.each(['1. 实现\n1. 验证', '先验证，再交付。', '9007199254740992. 验证'])('prefers the visible whole plan: %s', visible => {
    expect(selectPlan([{ type: 'thinking', thinking: 'Plan:\n1. Investigate alternatives' }, { type: 'text', text: visible }]))
      .toBe(visible);
  });

  it.each([
    ['Options:\n1. A\n2. B\n\nFinal steps:\n3. 验证\n\nDetails...\n7. 交付', 'Final steps:\n3. 验证\n\nDetails...\n7. 交付'],
    ['1. A\n2. B\n\n1. 验证\n\nDetails...\n2. 交付', '1. 验证\n\nDetails...\n2. 交付'],
  ])('uses the final thinking list: %s', (thinking, expected) => {
    expect(selectPlan([{ type: 'thinking', thinking }])).toBe(expected);
  });

  it.each(['Plan:', '## **计划：**', 'Plan:\n```\n1. Example\n```', 'Plan:\n\n计划：'])('ignores a visible heading without a plan body: %s', visible => {
    for (const plan of ['Plan:\n1. 验证\n2. 交付', '1. 验证\n\nDetails...\n2. 交付']) {
      const selected = selectPlan([{ type: 'thinking', thinking: plan }, { type: 'text', text: visible }]);
      expect(selected.trim()).toBe(plan);
      expect(extract(selected).map(todo => todo.text)).toEqual(['验证', '交付']);
    }
  });

  it.each([
    '1. 验证\n\nDetails...\n2. 交付',
    '3. 验证\n   1. 子项\n\n说明\n7. 交付',
    '1. 验证\n```\n9. 示例\n```\n2. 交付',
    '1. 验证\n\n1. 交付',
    '9007199254740992. 验证\n\nDetails...\n2. 交付',
  ])('keeps complete headerless thinking plans with details: %s', plan => {
    expect(selectPlan([{ type: 'thinking', thinking: 'Unrelated reasoning.\n' + plan }]))
      .toBe(plan);
  });

  it.each([
    ['Plan:\n1. **验证**\n2. **交付**', [1, 2], ['验证', '交付']],
    ['## **计划：**\n2）实现\n5) Verify\n9、`deploy`', [2, 5, 9], ['实现', 'Verify', 'deploy']],
    ['1. Go\n2. QA', [1, 2], ['Go', 'QA']],
    ['Plan:\n4. Read the full project specification', [4], ['Read the full project specification']],
  ])('retains titles and original ids: %s', (text, ids, titles) => {
    expect(extract(text as string)).toEqual((ids as number[]).map((step, i) => ({
      step, text: (titles as string[])[i], completed: false,
    })));
  });

  it('uses the final plan and excludes fenced examples and nested steps', () => {
    expect(extract('Plan:\n1. Draft\n## Plan:\n3. 实现\n   1. 子项\n```text\n8. 示例\n```\n7. 验证'))
      .toEqual([{ step: 3, text: '实现', completed: false }, { step: 7, text: '验证', completed: false }]);
  });

  it.each(['先验证，再交付。', 'Plan:\n1. 实现\n1. 验证', 'Plan:\n0. 实现',
    'Plan:\n9007199254740992. 交付', 'Plan:\n1. [ ]'])('keeps ambiguous plans for whole-plan confirmation: %s', text => {
    expect(extract(text)).toEqual([]);
  });
});

describe('version-matched native plan adapter', () => {
  it('shows original ids through the native todos command', async () => {
    type Command = { handler: (args: string, ctx: { ui: { notify: (text: string) => void } }) => unknown };
    let command!: Command;
    let notification = '';
    const nativePlan = (pi: { appendEntry: (type: string, data: unknown) => void;
      registerCommand: (name: string, command: Command) => void }) => {
      pi.appendEntry('plan-mode', { enabled: false, todos: [{ step: 3 }, { step: 7 }] });
      pi.registerCommand('todos', { handler: (_args, ctx) => ctx.ui.notify('Plan Progress:\n1. ○ 验证\n2. ○ 交付') });
    };
    const adapter = runInNewContext(buildPiPlanModeExtensionSource('/runtime/plan-mode/index.ts')
      .replace(/^import nativePlan[^\n]*\n/, '').replace('export default function', 'function') + '; cindyPlanMode', { nativePlan });
    adapter({ appendEntry: () => {}, registerCommand: (_name: string, value: Command) => { command = value; } });
    await command.handler('', { ui: { notify: text => { notification = text; } } });
    expect(notification).toBe('Plan Progress:\n3. ○ 验证\n7. ○ 交付');
  });

  it('delegates native tools, future hooks and unrelated UI unchanged', () => {
    const calls: unknown[][] = [];
    const handler = () => 'native-result';
    const api = {
      getActiveTools: () => ['read', 'custom-tool'],
      setActiveTools: (...args: unknown[]) => calls.push(args),
      on: (...args: unknown[]) => calls.push(args),
      registerCommand: (...args: unknown[]) => calls.push(args),
    };
    const nativePlan = (pi: typeof api) => {
      pi.setActiveTools(pi.getActiveTools());
      pi.on('future_native_hook', handler);
      pi.registerCommand('future-command', handler);
    };
    const adapter = runInNewContext(buildPiPlanModeExtensionSource('/runtime/plan-mode/index.ts')
      .replace(/^import nativePlan[^\n]*\n/, '').replace('export default function', 'function') + '; cindyPlanMode', { nativePlan });
    adapter(api);
    expect(calls).toEqual([[['read', 'custom-tool']], ['future_native_hook', handler], ['future-command', handler]]);
  });
});
