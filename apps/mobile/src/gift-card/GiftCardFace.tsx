import { useState } from 'react';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import type { GiftCardFaceStyle } from '@cindy/maker-shared/gift-card';
import {
  GIFT_CARD_VIEW_BOX,
  bundledGiftCardAmountLayout,
  giftCardAmountArtForLayout,
  giftCardAmountLabel,
  type GiftCardAmountLayout,
} from '@cindy/maker-shared/gift-card-amount';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { radius } from '@/theme/tokens';

/**
 * 礼品卡卡面（mobile-design-guide.md §9 登记的品牌露出面），与桌面端兑换弹窗同一张卡。
 *
 * 卡面 = 不含金额的底图 + 印在上面的金额。底图与金额印法由服务端随卡下发（`face`），
 * 新卡面不用发版就能显示；品牌红、形象、金额的颜色都属于卡面图稿，本组件不写任何颜色。
 * 本版本内置的四张卡面（`assets/gift-cards/` 与 `@cindy/maker-shared/gift-card-amount`）
 * 只在服务端没给卡面、或底图取不到时兜底；兜底时底图与印法都用内置的，不混用。
 */
const BUNDLED_FACES: Record<string, number> = {
  cindy: require('../../assets/gift-cards/cindy.webp'),
  cat: require('../../assets/gift-cards/cat.webp'),
  bell: require('../../assets/gift-cards/bell.webp'),
  leap: require('../../assets/gift-cards/leap.webp'),
};
const DEFAULT_FACE = 'cindy';

/** 内置卡面：图与印法同一来源。本版本不认识的卡面按默认卡面显示，不出现破图。 */
function bundledFace(faceCode: string): { image: number; layout: GiftCardAmountLayout } {
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
): boolean {
  const label = giftCardAmountLabel(amount, currency);
  const layout = serverFace(faceCode, face)?.amount ?? bundledFace(faceCode).layout;
  return Boolean(label && giftCardAmountArtForLayout(layout, label));
}

export function GiftCardFace({ faceCode, face, amount, currency, label, testID }: {
  faceCode: string;
  /** 服务端下发的卡面；没有或与 faceCode 不一致时用内置卡面。 */
  face?: GiftCardFaceStyle | null;
  /** 面额（精确十进制字符串）与币种；给出后金额印在卡面上。 */
  amount?: string;
  currency?: string;
  /** 读屏用的整张卡描述（含金额）。 */
  label: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
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
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={[styles.card, !showFallback && remoteState !== 'loaded' && styles.loading]}
      testID={testID}
    >
      {showFallback ? <Image source={fallback.image} contentFit="cover" style={StyleSheet.absoluteFill} /> : null}
      {remote && remoteState !== 'failed' ? (
        <Image
          source={{ uri: remote.imageUrl }}
          contentFit="cover"
          style={[StyleSheet.absoluteFill, remoteState !== 'loaded' && styles.hidden]}
          onLoad={() => setImage({ url: remote.imageUrl, state: 'loaded' })}
          onError={() => setImage({ url: remote.imageUrl, state: 'failed' })}
          testID={testID ? `${testID}.remote` : undefined}
        />
      ) : null}
      {art ? (
        <Svg viewBox={GIFT_CARD_VIEW_BOX} style={StyleSheet.absoluteFill} testID={testID ? `${testID}.amount` : undefined}>
          <G transform={art.transform} fill={art.fill}>
            {/* 金额的字符按位置排布，顺序即身份。 */}
            {art.glyphs.map((glyph, index) => <Path key={index} d={glyph.d} transform={`translate(${glyph.x} 0)`} />)}
          </G>
        </Svg>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  // 1px 描边让象牙白与夜色卡面在深浅两种面板上都和背景分得开。
  card: { width: '100%', maxWidth: 420, alignSelf: 'center', aspectRatio: 1200 / 757, borderRadius: radius.container, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  // 新卡面的底图还没取到：只留同比例的中性占位。
  loading: { backgroundColor: colors.surfaceChip },
  hidden: { opacity: 0 },
});
