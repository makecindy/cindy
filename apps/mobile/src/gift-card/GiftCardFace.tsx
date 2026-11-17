import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import { GIFT_CARD_VIEW_BOX, giftCardAmountArt, giftCardAmountLabel } from '@cindy/maker-shared/gift-card-amount';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { radius } from '@/theme/tokens';

/**
 * 礼品卡卡面（mobile-design-guide.md §9 登记的品牌露出面），与桌面端兑换弹窗同一张卡。
 *
 * 卡面 = 不含金额的成品图 + 印在上面的金额。品牌红、形象、金额的字形与颜色都属于
 * 卡面图稿（成品图在 `assets/gift-cards/`，金额轮廓在
 * `@cindy/maker-shared/gift-card-amount`），本组件不写任何颜色。四张图与分享网页、
 * 桌面客户端、Platform 后台使用的是同一份文件，faceCode 由服务端下发。
 */
const FACES: Record<string, number> = {
  cindy: require('../../assets/gift-cards/cindy.webp'),
  cat: require('../../assets/gift-cards/cat.webp'),
  bell: require('../../assets/gift-cards/bell.webp'),
  leap: require('../../assets/gift-cards/leap.webp'),
};

// 新版服务端可能下发本版本还不认识的卡面：按默认卡面显示，不出现破图。
const knownFace = (faceCode: string) => (Object.hasOwn(FACES, faceCode) ? faceCode : 'cindy');

/** 金额能否印到这张卡面上；不能时调用方要用普通文字把金额写出来。 */
export function giftCardFaceShowsAmount(faceCode: string, amount: string, currency: string): boolean {
  const label = giftCardAmountLabel(amount, currency);
  return Boolean(label && giftCardAmountArt(knownFace(faceCode), label));
}

export function GiftCardFace({ faceCode, amount, currency, label, testID }: {
  faceCode: string;
  /** 面额（精确十进制字符串）与币种；给出后金额印在卡面上。 */
  amount?: string;
  currency?: string;
  /** 读屏用的整张卡描述（含金额）。 */
  label: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const face = knownFace(faceCode);
  const amountLabel = amount && currency ? giftCardAmountLabel(amount, currency) : null;
  const art = amountLabel ? giftCardAmountArt(face, amountLabel) : null;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={styles.card} testID={testID}>
      <Image source={FACES[face]} contentFit="cover" style={StyleSheet.absoluteFill} />
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
});
