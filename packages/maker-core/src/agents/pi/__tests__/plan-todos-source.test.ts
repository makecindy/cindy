import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PI_PLAN_TODOS_SOURCE } from '../plan-todos-source.js';
import { buildPiPlanReviewExtensionSource } from '../cindy-plan-review-source.js';

// #8933 / unit: execute the exact parser emitted into Pi, not a second parser.
// Existing plan/review integration cases omitted short/Markdown/nonsequential
// titles. Minimal failure: "Plan:\n1. 验证". Runtime integration separately
// proves that this parser's ids reach the actual native tracker and [DONE:n].
const extract = runInNewContext(`${PI_PLAN_TODOS_SOURCE}; extractTodoItems`) as (
  plan: string,
) => Array<{ step: number; text: string; completed: boolean }>;

describe('Pi plan tracker extraction', () => {
  it.each([
    ['short Chinese', 'Plan:\n1. **实现交互**\n2. **验证**\n3. **交付**', [1, 2, 3], ['实现交互', '验证', '交付']],
    ['Chinese header and mixed markers', '## **计划：**\n2）实现\n5) Verify\n9、`deploy`', [2, 5, 9], ['实现', 'Verify', 'deploy']],
    ['short English without header', '1. Go\n2. QA', [1, 2], ['Go', 'QA']],
    ['long title and action verb', 'Plan:\n4. Read the full project specification and preserve every acceptance criterion without truncation', [4],
      ['Read the full project specification and preserve every acceptance criterion without truncation']],
  ])('preserves %s', (_name, plan, ids, titles) => {
    expect(extract(plan as string)).toEqual((ids as number[]).map((step, i) => ({ step, text: titles[i], completed: false })));
  });

  it('ignores fenced examples and nested substeps without changing top-level ids', () => {
    expect(extract('Intro\n1. Not the plan\n计划：\n3. 实现\n   1. 子项\n```text\n8. 示例\n```\n7. 验证')).toEqual([
      { step: 3, text: '实现', completed: false }, { step: 7, text: '验证', completed: false },
    ]);
  });

  it.each(['先验证，再交付。', 'Plan:\n1. 实现\n1. 验证', 'Plan:\n9007199254740992. 交付'])(
    'leaves unaddressable steps for complete-plan review: %s', plan => {
      expect(extract(plan)).toEqual([]);
    },
  );

  it('shows original sparse ids in the native todos command', async () => {
    type Context = { ui: { notify: (...args: unknown[]) => void } };
    type Command = { handler: (args: string, ctx: Context) => Promise<void> };
    let command!: Command;
    let notification: unknown[] = [];
    const adapter = runInNewContext(buildPiPlanReviewExtensionSource('/pi/plan-mode/index.ts')
      .replace(/^import nativePlan[^\n]*\n/, '').replace('export default function', 'function')
      + '; cindyPlanReview', {
      nativePlan: (api: {
        appendEntry: (type: string, data: unknown) => void;
        registerCommand: (name: string, command: Command) => void;
      }) => {
        api.appendEntry('plan-mode', { enabled: false, todos: [{ step: 3 }, { step: 7 }] });
        api.registerCommand('todos', { handler: async (_args: string, ctx: Context) => {
          ctx.ui.notify('Plan Progress:\n1. ○ 验证\n2. ○ 交付', 'info');
        } });
      },
    }) as (api: unknown) => void;
    adapter({ appendEntry: () => {}, registerCommand: (_name: string, handler: typeof command) => { command = handler; } });
    await command.handler('', { ui: { notify: (...args: unknown[]) => { notification = args; } } });
    expect(notification).toEqual(['Plan Progress:\n3. ○ 验证\n7. ○ 交付', 'info']);
  });
});
