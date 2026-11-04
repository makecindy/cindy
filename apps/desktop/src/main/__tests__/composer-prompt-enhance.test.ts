import { describe, expect, it } from 'vitest';

import {
  buildEnhancePrompt,
  enhanceComposerPrompt,
} from '../composer-prompt-enhance.js';
import { COMPOSER_ENHANCE_MAX_INPUT_CHARS } from '../../shared/composerPromptEnhance.js';
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

  it('maps an exhausted auxiliary chain to a precondition failure', async () => {
    const request = async (): Promise<UtilityTextResult> => ({
      ok: false,
      reason: 'no_candidate',
      attempts: [],
    });

    await expect(enhanceComposerPrompt(request, 'hello')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('maps an empty rewrite to an internal failure', async () => {
    const request = async () => okResponse('   ');
    await expect(enhanceComposerPrompt(request, 'hello')).rejects.toMatchObject({
      code: 'INTERNAL',
    });
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
