/**
 * RemoteSourceMark —— 「另一台电脑上的供应商」图标(移植自桌面
 * apps/desktop/src/renderer/components/icons/RemoteSourceMark.tsx)。
 *
 * 品牌图形右上角加一道波纹和一个点标出远端:仍是**一个**图标位,一眼读出「这个供应商,
 * 在远处」。不在 Logo 旁另放电脑图标(2026-10-06 用户裁决)。
 *
 * 与桌面同一种做法:图形保持原大小、原位置(与本机同列图标对齐),波纹叠在字形右上角,
 * 不占布局(2026-10-08 用户裁决:早先缩小品牌塞进同一方框的做法让 Logo 偏到左下)。
 * 由 MobileProviderMark / MobileModelIconMark 的 `remote` 调用,它们知道字形在盒里的位置。
 * 波纹与点跟随 color(与供应商 mark 同色),Light / Dark 走主题 token。
 */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { useTheme } from '@/theme';

/** 品牌区在 16 单位画布里的边长(左下对齐)。 */
const BRAND_UNITS = 12.5;
/** 波纹在品牌区右上外侧占的带宽(16 单位画布)。 */
const SIGNAL_BAND_UNITS = 16 - BRAND_UNITS;
/** 波纹按官方 mark 字形边长定比例,与桌面 13px Logo 上的波纹同大。 */
const SIGNAL_MARK_SIZE = 13;

export function RemoteSourceMark({
  size,
  inset,
  color,
  children,
}: {
  /** children 的盒边长;外层同大,布局与不带标记时一致。 */
  size: number;
  /** 字形笔画右上角相对盒右上角的内缩;波纹贴着字形而不是盒角。 */
  inset: { x: number; y: number };
  color?: string;
  /** 品牌图形。 */
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const stroke = color ?? colors.textSecondary;
  const unit = SIGNAL_MARK_SIZE / BRAND_UNITS;
  const band = SIGNAL_BAND_UNITS * unit;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ height: size, width: size }}
    >
      {children}
      <Svg
        height={unit * 16}
        style={[styles.signal, { right: inset.x - band, top: inset.y - band }]}
        viewBox="0 0 16 16"
        width={unit * 16}
      >
        {/* 波纹描边是 16 单位画布里的图形几何(与桌面同值、随 size 缩放),不是阶梯图标描边。 */}
        <Path
          d="M12 1.4A2.6 2.6 0 0 1 14.6 4"
          fill="none"
          stroke={stroke}
          strokeLinecap="round"
          strokeWidth={1.4}
        />
        <Circle cx={12.6} cy={3.4} fill={stroke} r={0.95} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  signal: {
    position: 'absolute',
  },
});
