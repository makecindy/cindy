import { describe, expect, it } from 'vitest';
import { sanitizeDeepSeekV4CustomTools } from '../../providers/deepseek';

const bodyWithExecTool = (model: string) => ({
  model,
  tools: [
    { type: 'custom', name: 'apply_patch' },
    { type: 'custom', name: 'exec' },
  ],
});

describe('DeepSeek custom tool sanitization', () => {
  it('strips non-apply_patch custom tools for official gateway model ids', () => {
    const next = sanitizeDeepSeekV4CustomTools(bodyWithExecTool('deepseek/deepseek-v4-pro'));
    expect(next?.tools).toEqual([{ type: 'custom', name: 'apply_patch' }]);
  });

  // #8559: custom providers spell DeepSeek models without the vendor prefix
  // ("deepseek-flash"), and variants add suffixes — the sanitizer used to match
  // only the two exact gateway ids, so the exec tool slipped through and the
  // upstream request died with a 400.
  it('strips custom tools for unprefixed custom-provider model ids (#8559)', () => {
    for (const model of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']) {
      const next = sanitizeDeepSeekV4CustomTools(bodyWithExecTool(model));
      expect(next?.tools, model).toEqual([{ type: 'custom', name: 'apply_patch' }]);
    }
  });

  it('matches mixed-case ids preserved verbatim by custom-provider projection', () => {
    for (const model of ['DeepSeek-V4-Pro', 'vendor/DeepSeek-V4-Pro']) {
      const next = sanitizeDeepSeekV4CustomTools(bodyWithExecTool(model));
      expect(next?.tools, model).toEqual([{ type: 'custom', name: 'apply_patch' }]);
    }
  });

  it('strips custom tools for third-party vendor-prefixed spellings', () => {
    const next = sanitizeDeepSeekV4CustomTools(
      bodyWithExecTool('openrouter/deepseek/deepseek-chat'),
    );
    expect(next?.tools).toEqual([{ type: 'custom', name: 'apply_patch' }]);
  });

  it('leaves non-DeepSeek models untouched', () => {
    expect(sanitizeDeepSeekV4CustomTools(bodyWithExecTool('gpt-5.5'))).toBeNull();
    expect(sanitizeDeepSeekV4CustomTools(bodyWithExecTool('notdeepseek-x'))).toBeNull();
  });

  it('drops tool_choice referencing a removed custom tool', () => {
    const next = sanitizeDeepSeekV4CustomTools({
      model: 'deepseek-flash',
      tools: [{ type: 'custom', name: 'exec' }],
      tool_choice: { type: 'custom', name: 'exec' },
    });
    expect(next?.tools).toBeUndefined();
    expect(next?.tool_choice).toBeUndefined();
  });
});
