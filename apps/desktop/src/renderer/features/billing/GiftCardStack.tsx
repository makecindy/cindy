import type { GiftCardFaceStyle } from '@cindy/maker-shared/gift-card';

import { cn } from '@/lib/utils';

import { GiftCardFace } from './GiftCardFace';

interface GiftCardStackProps {
  faceCode: string;
  /** 服务端下发的卡面；没有时用内置卡面。 */
  face?: GiftCardFaceStyle | null;
  amount: string;
  currency: string;
  /** 张数大于 1 时在卡面下方露出第二张卡的边，表示同样的卡有好几张。 */
  count: number;
  label: string;
  className?: string;
}

/**
 * 礼品卡卡面（DESIGN.md 登记的品牌露出面）。多张同样的卡叠放：后一张略窄、只露出
 * 底边，不加倾斜、阴影或动效，卡面本身仍是同一份成品图。
 */
export function GiftCardStack({ faceCode, face, amount, currency, count, label, className }: GiftCardStackProps) {
  const stacked = count > 1;
  return (
    <div className={cn('relative', stacked && 'pb-3', className)}>
      {stacked && (
        <div aria-hidden="true" className="absolute inset-x-[6%] bottom-0">
          <GiftCardFace faceCode={faceCode} face={face} amount={amount} currency={currency} />
        </div>
      )}
      <div className="relative">
        <GiftCardFace faceCode={faceCode} face={face} amount={amount} currency={currency} label={label} />
      </div>
    </div>
  );
}
