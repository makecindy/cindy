/**
 * MobileProviderMark —— provider-aware 模型下拉里每行前缀 / trigger 药丸的「来源徽标」。
 *
 * 对齐桌面 ProviderMark:目录供应商用**官方单色 mark**，品牌路径与 provider id/upstream
 * 识别由 @cindy/model-providers/branding 双端共享；未知自定义供应商回退首字母 monogram，使用与桌面一致的 4px 方盒。XD mark 非正方形(158:282),渲染时在 size×size 盒内
 * 垂直居中,保证与正方形 mark 同行对齐。
 */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import Svg, { Path } from 'react-native-svg';

import {
  ANTHROPIC_PROVIDER_PATH,
  OPENAI_PROVIDER_PATH,
  XD_ASPECT,
  XD_SYMBOL_PATHS,
  XD_VIEW_BOX,
} from '@/components/vendorIconPaths';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight as fontWeightToken, lineHeight, radius, typeScale } from '@/theme/tokens';
import {
  PROVIDER_LOGO_PATHS,
  isProviderLogoKind,
  resolveProviderLogoKind,
  type ProviderLogoRouting,
} from '@cindy/model-providers/branding';
import { resolveModelIconKind } from '@cindy/model-providers/sections';

import { providerMonogram } from './providerModelSections';
import { RemoteSourceMark } from './RemoteSourceMark';

const MARK_SIZE = 18;
/** 官方 mark 的字形边长:比 monogram 容器缩一档(桌面同比:行内 mark ≈ 12.3 vs 容器 18),避免视觉过重。 */
const GLYPH_SIZE = 13;
/** XD mark 横长,宽给一点补偿才与正方形 mark 视觉等重。 */
const XD_WIDTH = GLYPH_SIZE + 2;

/** 各形态字形右上角相对盒右上角的内缩:远程波纹贴着字形(字形在盒内居中)。 */
const GLYPH_INSET = { x: (MARK_SIZE - GLYPH_SIZE) / 2, y: (MARK_SIZE - GLYPH_SIZE) / 2 };
const XD_INSET = { x: (MARK_SIZE - XD_WIDTH) / 2, y: (MARK_SIZE - XD_WIDTH * XD_ASPECT) / 2 };
const MONOGRAM_INSET = { x: 0, y: 0 };

/** remote → 叠远程标记(右上角波纹 + 点);图形本身大小与位置不变。 */
function withRemote(
  node: ReactNode,
  remote: boolean | undefined,
  inset: { x: number; y: number },
  color: string,
) {
  if (!remote) return node;
  return (
    <RemoteSourceMark color={color} inset={inset} size={MARK_SIZE}>
      {node}
    </RemoteSourceMark>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    monogram: {
      alignItems: 'center',
      borderColor: c.borderStrong,
      borderRadius: radius.micro,
      borderWidth: 1,
      height: MARK_SIZE,
      justifyContent: 'center',
      width: MARK_SIZE,
    },
    monogramText: {
      color: c.textSecondary,
      fontSize: typeScale.micro,
      lineHeight: lineHeight.micro,
      fontWeight: fontWeightToken.semibold,
      // CJK / 拉丁字母在小圆点里视觉重心略偏下,nudge -0.5 居中。
      includeFontPadding: false,
      textAlign: 'center',
    },
    markBox: {
      alignItems: 'center',
      height: MARK_SIZE,
      justifyContent: 'center',
      width: MARK_SIZE,
    },
  });

export interface MobileProviderMarkProps {
  /** 供应商 id(目录 id → 官方 mark；未知 / 缺省 → monogram)。 */
  providerId?: string;
  /** 用户重命名 provider 后用持久化 upstream 继续识别品牌。 */
  routing?: ProviderLogoRouting;
  /** 被控端剥离 routing 前解析出的非敏感品牌;device-link 场景优先使用。 */
  logoKind?: string;
  /** 供应商展示名(monogram 取首字母;官方 mark 分支不消费)。 */
  name: string;
  /** mark 单色;缺省 textSecondary(列表行口径,trigger 场景可传 textPrimary)。 */
  color?: string;
  /** true → 另一台电脑上的供应商:右上角叠远程标记(波纹 + 点),图形不缩放不移位。 */
  remote?: boolean;
}

/** 渲染单个供应商的来源徽标(官方 mark 或 monogram)。 */
export function MobileProviderMark({
  providerId,
  routing,
  logoKind,
  name,
  color,
  remote,
}: MobileProviderMarkProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const fill = color ?? colors.textSecondary;

  const kind = isProviderLogoKind(logoKind)
    ? logoKind
    : resolveProviderLogoKind(providerId ?? '', routing);

  switch (kind) {
    case 'anthropic':
      return withRemote(
        <View accessible={false} style={styles.markBox}>
          <Svg width={GLYPH_SIZE} height={GLYPH_SIZE} viewBox="0 0 24 24">
            <Path d={ANTHROPIC_PROVIDER_PATH} fill={fill} />
          </Svg>
        </View>,
        remote,
        GLYPH_INSET,
        fill,
      );
    case 'openai':
      return withRemote(
        <View accessible={false} style={styles.markBox}>
          <Svg width={GLYPH_SIZE} height={GLYPH_SIZE} viewBox="0 0 24 24">
            <Path d={OPENAI_PROVIDER_PATH} fill={fill} />
          </Svg>
        </View>,
        remote,
        GLYPH_INSET,
        fill,
      );
    case 'xd':
      return withRemote(
        <View accessible={false} style={styles.markBox}>
          <Svg width={XD_WIDTH} height={XD_WIDTH * XD_ASPECT} viewBox={XD_VIEW_BOX}>
            {XD_SYMBOL_PATHS.map((p) => (
              <Path key={p} d={p} fill={fill} />
            ))}
          </Svg>
        </View>,
        remote,
        XD_INSET,
        fill,
      );
  }

  if (kind) {
    return withRemote(
      <View accessible={false} style={styles.markBox}>
        <Svg width={GLYPH_SIZE} height={GLYPH_SIZE} viewBox="0 0 24 24">
          <Path d={PROVIDER_LOGO_PATHS[kind]} fill={fill} />
        </Svg>
      </View>,
      remote,
      GLYPH_INSET,
      fill,
    );
  }

  return withRemote(
    <View style={[styles.monogram, { borderColor: fill }]}>
      <Text style={[styles.monogramText, color ? { color } : null]}>
        {providerMonogram(name)}
      </Text>
    </View>,
    remote,
    MONOGRAM_INSET,
    fill,
  );
}

export interface MobileModelIconMarkProps {
  /** 模型条目的展示图标 id(CatalogModel.icon,AI Gateway / 目录设定);undefined = 未设定。 */
  icon?: string;
  /** 回落用的来源供应商 id / 展示名(与 MobileProviderMark 同语义)。 */
  providerId?: string;
  routing?: ProviderLogoRouting;
  logoKind?: string;
  name: string;
  color?: string;
  /** 同 MobileProviderMark.remote。 */
  remote?: boolean;
}

/**
 * 模型行 / composer 药丸的图标 —— 统一规则(与桌面 ModelIconMark 同源,共享
 * resolveModelIconKind 口径):模型条目带 `icon`(**AI Gateway / 目录设定**)就渲染
 * 对应厂牌 mark;缺省或未知值回落来源供应商标。禁止在客户端按 model id 猜厂牌。
 */
export function MobileModelIconMark({
  icon,
  providerId,
  routing,
  logoKind,
  name,
  color,
  remote,
}: MobileModelIconMarkProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const kind = resolveModelIconKind(icon);
  if (kind) {
    const fill = color ?? colors.textSecondary;
    if (kind === 'cindy') {
      return withRemote(
        <View accessible={false} style={styles.markBox}>
          <Svg width={XD_WIDTH} height={XD_WIDTH * XD_ASPECT} viewBox={XD_VIEW_BOX}>
            {XD_SYMBOL_PATHS.map((p) => (
              <Path key={p} d={p} fill={fill} />
            ))}
          </Svg>
        </View>,
        remote,
        XD_INSET,
        fill,
      );
    }
    return withRemote(
      <View accessible={false} style={styles.markBox}>
        <Svg width={GLYPH_SIZE} height={GLYPH_SIZE} viewBox="0 0 24 24">
          <Path
            d={kind === 'claude' ? ANTHROPIC_PROVIDER_PATH : OPENAI_PROVIDER_PATH}
            fill={fill}
          />
        </Svg>
      </View>,
      remote,
      GLYPH_INSET,
      fill,
    );
  }
  return (
    <MobileProviderMark
      color={color}
      name={name}
      providerId={providerId}
      routing={routing}
      logoKind={logoKind}
      remote={remote}
    />
  );
}
