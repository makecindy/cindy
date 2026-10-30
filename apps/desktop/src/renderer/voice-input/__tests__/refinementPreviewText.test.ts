import { describe, expect, it } from 'vitest';

import { buildRefinementPreviewText } from '../refinementPreviewText';

describe('buildRefinementPreviewText', () => {
  it('does not splice a shifted raw suffix after filler words are removed', () => {
    expect(buildRefinementPreviewText('嗯那个我们今天先不要提交', '我们今天')).toBe('嗯那个我们今天先不要提交');
  });

  it('does not expand the text with an unvalidated streaming result', () => {
    expect(buildRefinementPreviewText('今天测试', '今天测试语音输入')).toBe('今天测试');
  });

  it('keeps the raw text visible when preview is empty', () => {
    expect(buildRefinementPreviewText('今天测试', '')).toBe('今天测试');
  });
});
