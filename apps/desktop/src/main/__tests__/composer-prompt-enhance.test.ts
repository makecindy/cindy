import { describe, expect, it } from 'vitest';

import {
  buildEnhancePrompt,
  enhanceComposerPrompt,
  outputBudgetFor,
  COMPOSER_ENHANCE_MAX_OUTPUT_TOKENS,
  COMPOSER_ENHANCE_MIN_OUTPUT_TOKENS,
  COMPOSER_ENHANCE_RESPONSE_INSTRUCTIONS,
  COMPOSER_ENHANCE_SYSTEM_PROMPT,
  COMPOSER_ENHANCE_TIMEOUT_MS,
} from '../composer-prompt-enhance.js';
import { COMPOSER_ENHANCE_MAX_INPUT_CHARS, hasUnclosedFence } from '../../shared/composerPromptEnhance.js';
import type { UtilityTextResult } from '../../shared/utilityTextResult.js';

function okResponse(text: string): UtilityTextResult {
  return {
    ok: true,
    text,
    providerId: 'xd',
    model: 'deepseek-v4-flash',
    transport: 'codex-responses',
  };
}

describe('enhanceComposerPrompt', () => {
  it('returns the rewritten prompt and the route that produced it', async () => {
    const seen: { prompt?: string } = {};
    const result = await enhanceComposerPrompt(async (prompt) => {
      seen.prompt = prompt;
      return okResponse('  给这个页面加一个搜索框  ');
    }, '  给这个页面加个搜索框  ');

    expect(result.text).toBe('给这个页面加一个搜索框');
    expect(result.model).toBe('xd/deepseek-v4-flash');
    expect(seen.prompt).toContain('给这个页面加个搜索框');
  });

  it('rejects an empty or non-string draft before spending a model call', async () => {
    let called = false;
    const request = async () => {
      called = true;
      return okResponse('x');
    };

    await expect(enhanceComposerPrompt(request, '   ')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(enhanceComposerPrompt(request, 42)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(called).toBe(false);
  });

  it('rejects a draft that exceeds the input budget', async () => {
    const request = async () => okResponse('x');
    await expect(
      enhanceComposerPrompt(request, 'a'.repeat(COMPOSER_ENHANCE_MAX_INPUT_CHARS + 1)),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('maps an exhausted auxiliary chain to a code the renderer can act on', async () => {
    const request = async (): Promise<UtilityTextResult> => ({
      ok: false,
      reason: 'no_candidate',
      attempts: [],
    });

    // The renderer uses this code to offer a link to the auxiliary-model
    // setting, so it must not fall back to a generic "unavailable" code.
    await expect(enhanceComposerPrompt(request, 'hello')).rejects.toMatchObject({
      code: 'AUXILIARY_MODEL_UNAVAILABLE',
    });
  });

  it('maps a timeout to a precondition failure', async () => {
    const request = async (): Promise<UtilityTextResult> => ({
      ok: false,
      reason: 'timeout',
      attempts: [],
    });

    await expect(enhanceComposerPrompt(request, 'hello')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('keeps a failed call distinct from a missing configuration', async () => {
    // An upstream HTTP error or an empty body is not a configuration problem:
    // the renderer turns AUXILIARY_MODEL_UNAVAILABLE into "configure a model",
    // which would be wrong advice for a chain the user already configured.
    for (const reason of ['all_candidates_failed', 'empty_response'] as const) {
      const request = async (): Promise<UtilityTextResult> => ({
        ok: false,
        reason,
        attempts: [],
      });

      await expect(enhanceComposerPrompt(request, 'hello')).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    }
  });

  it('maps an empty rewrite to an internal failure', async () => {
    const request = async () => okResponse('   ');
    await expect(enhanceComposerPrompt(request, 'hello')).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('asks the model to keep the draft language and to answer in plain text only', async () => {
    let options: { systemPrompt?: string; responseInstructions?: string } = {};
    await enhanceComposerPrompt(async (_prompt, opts) => {
      options = opts;
      return okResponse('x');
    }, 'hello');

    expect(options.systemPrompt).toBe(COMPOSER_ENHANCE_SYSTEM_PROMPT);
    expect(options.responseInstructions).toBe(COMPOSER_ENHANCE_RESPONSE_INSTRUCTIONS);
    // Language alignment: a multilingual UI must not turn a Chinese draft into
    // an English rewrite.
    expect(options.systemPrompt).toMatch(/language of the draft/i);
    expect(options.systemPrompt).toMatch(/never translate/i);
    // Plain-text output: no commentary the user would have to delete.
    expect(options.responseInstructions).toMatch(/plain text/i);
    expect(options.responseInstructions).toMatch(/no preamble/i);
    expect(options.responseInstructions).toMatch(/no code fences/i);
    expect(options.responseInstructions).toMatch(/exactly one rewrite/i);
  });

  it('asks the utility route for a complete rewrite, never a truncated one', async () => {
    let options: { requireCompleteOutput?: boolean } = {};
    await enhanceComposerPrompt(async (_prompt, opts) => {
      options = opts;
      return okResponse('x');
    }, 'hello');

    // The rewrite becomes the user's draft: a body the provider cut short at
    // the output budget would silently drop the constraints at its end.
    expect(options.requireCompleteOutput).toBe(true);
  });

  it('sizes the output budget from the draft and keeps it inside its bounds', async () => {
    const budgets: number[] = [];
    const request = async (_prompt: string, opts: { maxTokens: number; timeoutMs: number }) => {
      budgets.push(opts.maxTokens);
      expect(opts.timeoutMs).toBe(COMPOSER_ENHANCE_TIMEOUT_MS);
      return okResponse('x');
    };

    await enhanceComposerPrompt(request, 'a');
    await enhanceComposerPrompt(request, 'a'.repeat(400));
    await enhanceComposerPrompt(request, 'a'.repeat(COMPOSER_ENHANCE_MAX_INPUT_CHARS));

    // A short draft gets the floor, a long one grows, and nothing exceeds the ceiling.
    expect(budgets[0]).toBe(COMPOSER_ENHANCE_MIN_OUTPUT_TOKENS);
    expect(budgets[1]).toBe(400 * 2 + 96);
    expect(budgets[2]).toBe(COMPOSER_ENHANCE_MAX_OUTPUT_TOKENS);
    for (const budget of budgets) {
      expect(budget).toBeGreaterThanOrEqual(COMPOSER_ENHANCE_MIN_OUTPUT_TOKENS);
      expect(budget).toBeLessThanOrEqual(COMPOSER_ENHANCE_MAX_OUTPUT_TOKENS);
    }
  });
});

describe('outputBudgetFor', () => {
  it('scales with the draft between the floor and the ceiling', () => {
    expect(outputBudgetFor('')).toBe(COMPOSER_ENHANCE_MIN_OUTPUT_TOKENS);
    expect(outputBudgetFor('x'.repeat(300))).toBeGreaterThan(
      COMPOSER_ENHANCE_MIN_OUTPUT_TOKENS,
    );
    expect(outputBudgetFor('x'.repeat(COMPOSER_ENHANCE_MAX_INPUT_CHARS))).toBe(
      COMPOSER_ENHANCE_MAX_OUTPUT_TOKENS,
    );
  });
});

describe('hasUnclosedFence', () => {
  it('flags a rewrite that ends inside a fenced block', () => {
    expect(hasUnclosedFence('先看这段：\n```ts\nconst a = 1;')).toBe(true);
    expect(hasUnclosedFence('```\n正文')).toBe(true);
  });

  it('accepts a closed block and a fence with an info string', () => {
    expect(hasUnclosedFence('```ts\nconst a = 1;\n```')).toBe(false);
    expect(hasUnclosedFence('说明\n```json\n{}\n```\n结束')).toBe(false);
  });

  it('does not treat a literal triple backtick inside a sentence as a fence', () => {
    // A draft asking to remove that very marker must survive the round trip:
    // counting occurrences used to reject exactly the rewrite that kept it.
    expect(hasUnclosedFence('把文件里的 ``` 标记全部删掉')).toBe(false);
    expect(hasUnclosedFence('第一行\n用 ``` 包住整段再贴回来')).toBe(false);
  });

  it('accepts a closed tilde block that shows a triple backtick of its own', () => {
    // 波浪线围栏里的反引号只是块内的字面内容,不是另一个围栏。旧实现只数反引号,
    // 把块内那一行三反引号当成了未闭合围栏,合法草稿因此被拒绝增强。
    const draft = [
      '看看这段 markdown：',
      '~~~markdown',
      '```',
      '~~~',
      '就这些',
    ].join('\n');
    expect(hasUnclosedFence(draft)).toBe(false);
  });

  it('still reports a tilde fence that was never closed', () => {
    expect(hasUnclosedFence('~~~markdown\nconst a = 1;')).toBe(true);
    // 波浪线围栏里的反引号不闭合它,只有同字符的波浪线才行。
    expect(hasUnclosedFence('~~~markdown\n```\nconst a = 1;')).toBe(true);
  });

  it('keeps the backtick fence behaviour unchanged', () => {
    expect(hasUnclosedFence('```ts\nconst a = 1;\n```')).toBe(false);
    expect(hasUnclosedFence('```ts\nconst a = 1;')).toBe(true);
    // 波浪线不能闭合反引号围栏。
    expect(hasUnclosedFence('```ts\nconst a = 1;\n~~~')).toBe(true);
  });
});

describe('buildEnhancePrompt', () => {
  it('wraps the draft so the model can tell it apart from the instructions', () => {
    const prompt = buildEnhancePrompt('do the thing');
    expect(prompt).toContain('<draft>');
    expect(prompt).toContain('</draft>');
    expect(prompt).toContain('do the thing');
  });
});
