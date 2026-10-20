// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { getTabKind, hydrateTabState } from '../../../registry';
import '../index';

function hydrate(raw: unknown) {
  return hydrateTabState(getTabKind('web-browser'), raw) as Record<string, unknown>;
}

describe('web-browser hydrateState · previewRequestId', () => {
  it('合法凭据在 hydrate 后保留(每次 TabBody 渲染前都会 hydrate,丢了 report 就带不上)', () => {
    const valid = `${'a_-'.repeat(14)}a`; // 43 字符 base64url
    expect(hydrate({ url: 'https://a.example/', previewRequestId: valid })).toMatchObject({
      url: 'https://a.example/',
      previewRequestId: valid,
      isAudible: false,
    });
  });

  it('形状非法 / 非字符串的凭据被丢弃;普通标签状态不含该字段', () => {
    expect(hydrate({ url: 'https://a.example/', previewRequestId: 'short' })).not.toHaveProperty(
      'previewRequestId',
    );
    expect(hydrate({ url: 'https://a.example/', previewRequestId: 42 })).not.toHaveProperty(
      'previewRequestId',
    );
    expect(hydrate({ url: 'https://a.example/' })).not.toHaveProperty('previewRequestId');
    expect(hydrate(null)).not.toHaveProperty('previewRequestId');
  });
});
