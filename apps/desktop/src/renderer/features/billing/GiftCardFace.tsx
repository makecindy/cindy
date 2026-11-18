import {
  GIFT_CARD_VIEW_BOX,
  giftCardAmountArt,
  giftCardAmountLabel,
} from '@cindy/maker-shared/gift-card-amount';

import bellFace from '@/assets/gift-cards/bell.webp';
import catFace from '@/assets/gift-cards/cat.webp';
import cindyFace from '@/assets/gift-cards/cindy.webp';
import leapFace from '@/assets/gift-cards/leap.webp';
import { cn } from '@/lib/utils';

/**
 * 礼品卡卡面（DESIGN.md §15.7 登记的品牌露出面）。
 *
 * 卡面 = 不含金额的成品图 + 印在上面的金额。品牌红、形象、金额的字形与颜色都属于
 * 卡面图稿（成品图在 `assets/gift-cards/`，金额轮廓在
 * `@cindy/maker-shared/gift-card-amount`），本组件不写任何颜色。四张图与分享网页、
 * Platform 后台使用的是同一份文件，faceCode 由服务端下发。
 */
const FACES: Record<string, string> = {
  cindy: cindyFace,
  cat: catFace,
  bell: bellFace,
  leap: leapFace,
};

interface GiftCardFaceProps {
  faceCode: string;
  /** 面额（精确十进制字符串）与币种；给出后金额印在卡面上。 */
  amount?: string;
  currency?: string;
  /** 读屏用的整张卡描述（含金额）；不给时卡面按装饰图处理。 */
  label?: string;
  className?: string;
}

/** 金额能否印到这张卡面上；不能时调用方要用普通文字把金额写出来。 */
export function giftCardFaceShowsAmount(faceCode: string, amount: string, currency: string) {
  const label = giftCardAmountLabel(amount, currency);
  // 新版服务端可能下发本版本还不认识的卡面：按默认卡面排版。
  return Boolean(label && giftCardAmountArt(faceCode in FACES ? faceCode : 'cindy', label));
}

export function GiftCardFace({ faceCode, amount, currency, label, className }: GiftCardFaceProps) {
  // 不认识的卡面退回默认卡面，不显示破图。
  const face = faceCode in FACES ? faceCode : 'cindy';
  const amountLabel = amount && currency ? giftCardAmountLabel(amount, currency) : null;
  const art = amountLabel ? giftCardAmountArt(face, amountLabel) : null;
  return (
    <div
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        'relative aspect-[1200/757] w-full select-none overflow-hidden rounded-xl border border-[var(--border-default)]',
        className,
      )}
    >
      <img src={FACES[face]} alt="" draggable={false} className="block size-full object-cover" />
      {art && (
        <svg
          viewBox={GIFT_CARD_VIEW_BOX}
          aria-hidden="true"
          data-gift-card-amount={amountLabel}
          className="absolute inset-0 size-full"
        >
          <g transform={art.transform} fill={art.fill}>
            {art.glyphs.map((glyph, index) => (
              // 金额的字符按位置排布，顺序即身份。
              <path key={index} d={glyph.d} transform={`translate(${glyph.x} 0)`} />
            ))}
          </g>
        </svg>
      )}
    </div>
  );
}
