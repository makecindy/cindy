import { useState } from 'react';
import type { GiftCardFaceStyle } from '@cindy/maker-shared/gift-card';
import {
  GIFT_CARD_VIEW_BOX,
  bundledGiftCardAmountLayout,
  giftCardAmountArtForLayout,
  giftCardAmountLabel,
  type GiftCardAmountLayout,
} from '@cindy/maker-shared/gift-card-amount';

import bellFace from '@/assets/gift-cards/bell.webp';
import catFace from '@/assets/gift-cards/cat.webp';
import cindyFace from '@/assets/gift-cards/cindy.webp';
import leapFace from '@/assets/gift-cards/leap.webp';
import { cn } from '@/lib/utils';

/**
 * 礼品卡卡面（DESIGN.md §15.7 登记的品牌露出面）。
 *
 * 卡面 = 不含金额的底图 + 印在上面的金额。底图与金额印法由服务端随卡下发（`face`），
 * 新卡面不用发版就能显示；品牌红、形象、金额的颜色都属于卡面图稿，本组件不写任何颜色。
 * 本版本内置的四张卡面（`assets/gift-cards/` 与 `@cindy/maker-shared/gift-card-amount`）
 * 只在服务端没给卡面、或底图取不到时兜底；兜底时底图与印法都用内置的，不混用。
 */
const BUNDLED_FACES: Record<string, string> = {
  cindy: cindyFace,
  cat: catFace,
  bell: bellFace,
  leap: leapFace,
};
const DEFAULT_FACE = 'cindy';

interface GiftCardFaceProps {
  faceCode: string;
  /** 服务端下发的卡面；没有或与 faceCode 不一致时用内置卡面。 */
  face?: GiftCardFaceStyle | null;
  /** 面额（精确十进制字符串）与币种；给出后金额印在卡面上。 */
  amount?: string;
  currency?: string;
  /** 读屏用的整张卡描述（含金额）；不给时卡面按装饰图处理。 */
  label?: string;
  className?: string;
}

/** 内置卡面：图与印法同一来源。本版本不认识的卡面按默认卡面显示，不出现破图。 */
function bundledFace(faceCode: string): { image: string; layout: GiftCardAmountLayout } {
  const code = Object.hasOwn(BUNDLED_FACES, faceCode) ? faceCode : DEFAULT_FACE;
  return { image: BUNDLED_FACES[code], layout: bundledGiftCardAmountLayout(code)! };
}

function serverFace(faceCode: string, face: GiftCardFaceStyle | null | undefined) {
  return face && face.code === faceCode ? face : null;
}

/** 金额能否印到这张卡面上；不能时调用方要用普通文字把金额写出来。 */
export function giftCardFaceShowsAmount(
  faceCode: string,
  amount: string,
  currency: string,
  face?: GiftCardFaceStyle | null,
) {
  const label = giftCardAmountLabel(amount, currency);
  const layout = serverFace(faceCode, face)?.amount ?? bundledFace(faceCode).layout;
  return Boolean(label && giftCardAmountArtForLayout(layout, label));
}

export function GiftCardFace({ faceCode, face, amount, currency, label, className }: GiftCardFaceProps) {
  const remote = serverFace(faceCode, face);
  // 按底图地址记加载结果：换了卡面（地址不同）就重新等这一张。
  const [image, setImage] = useState<{ url: string; state: 'loaded' | 'failed' } | null>(null);
  const remoteState = remote ? (image?.url === remote.imageUrl ? image.state : 'loading') : 'failed';
  const fallback = bundledFace(faceCode);
  // 服务端底图到之前：认识的卡面先显示内置图，新卡面只留同比例的占位，不出现破图或错的卡面。
  const showFallback =
    remoteState === 'failed' || (remoteState === 'loading' && Object.hasOwn(BUNDLED_FACES, faceCode));
  const layout = remoteState === 'loaded' ? remote!.amount : showFallback ? fallback.layout : null;
  const amountLabel = amount && currency ? giftCardAmountLabel(amount, currency) : null;
  const art = amountLabel && layout ? giftCardAmountArtForLayout(layout, amountLabel) : null;
  return (
    <div
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-gift-card-face={remoteState === 'loaded' ? remote!.code : showFallback ? 'bundled' : 'loading'}
      className={cn(
        'relative aspect-[1200/757] w-full select-none overflow-hidden rounded-xl border border-[var(--border-default)]',
        !showFallback && remoteState !== 'loaded' && 'bg-[var(--surface-hover)]',
        className,
      )}
    >
      {showFallback && (
        <img src={fallback.image} alt="" draggable={false} className="absolute inset-0 block size-full object-cover" />
      )}
      {remote && remoteState !== 'failed' && (
        <img
          src={remote.imageUrl}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={() => setImage({ url: remote.imageUrl, state: 'loaded' })}
          onError={() => setImage({ url: remote.imageUrl, state: 'failed' })}
          className={cn('absolute inset-0 block size-full object-cover', remoteState !== 'loaded' && 'opacity-0')}
        />
      )}
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
