import { describe, expect, it } from 'vitest';

import { buildReviewPrompt } from '../reviewPrompt.js';
import { buildReviewFollowUpMessage } from '../reviewFollowUp.js';
import { detectReviewReplyLanguage } from '../reviewReplyLanguage.js';

describe('detectReviewReplyLanguage', () => {
  it.each([
    [['price.ts に平均価格を返す関数 average を追加してください。'], 'ja'],
    [['장바구니 합계 함수를 수정해 주세요. `subtotal` 버그입니다.'], 'ko'],
    [['远程连接设备这里有几个 bug 要处理一下'], 'zh'],
    [['請修正 /Users/me/app/src/cart.ts 的折扣計算'], 'zh'],
    [['Please fix the discount in `cart.ts`.'], null],
  ] as const)('detects %j as %s', (texts, expected) => {
    expect(detectReviewReplyLanguage(texts)).toBe(expected);
  });

  it('ignores code, paths and identifiers when the prose is CJK', () => {
    expect(detectReviewReplyLanguage([
      '修正してください: /Users/me/very/long/path/to/project/src/components/Cart.tsx\n```ts\nexport function applyDiscountToEveryLineItemInTheCart() {}\n```',
    ])).toBe('ja');
  });
});

describe('review language pinning', () => {
  it('tells a Chinese-language review prompt to answer a Japanese task in Japanese', () => {
    const built = buildReviewPrompt({
      context: [
        { role: 'user', text: 'price.ts に average を追加してください。' },
        { role: 'assistant', text: '追加しました。' },
      ],
      workspace: null,
      changeSet: null,
      artifacts: [],
    });
    expect(built.replyLanguage).toBe('ja');
    expect(built.prompt).toContain('用户在本任务中使用日语：全部结论必须用日语书写');
  });

  it('names the user language in the hidden follow-up turn', () => {
    expect(buildReviewFollowUpMessage('P1: 除数が間違っています', 'ja')).toContain(
      "Reply in Japanese, the language of the user's own messages in this task.",
    );
    expect(buildReviewFollowUpMessage('P1: bug', null)).toContain(
      'Reply in the language the user has been using in this task',
    );
  });
});
