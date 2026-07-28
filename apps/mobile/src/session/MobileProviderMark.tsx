/**
 * MobileProviderMark —— provider-aware 模型下拉里每行前缀 / trigger 药丸的「来源徽标」。
 *
 * 对齐桌面 ProviderMark:目录供应商用**官方单色 mark**，品牌路径与 provider id/upstream
 * 识别由 @cindy/model-providers/branding 双端共享；未知自定义供应商回退首字母 monogram。与桌面的
 * 一处刻意差异:monogram 容器沿用 pill 圆角(桌面是 4px 方盒)——手机圆角走二元规则
 * (container/pill),不引入中间值。XD mark 非正方形(158:282),渲染时在 size×size 盒内
 * 垂直居中,保证与正方形 mark 同行对齐。
 */
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
import { fontWeight as fontWeightToken, radius, typeScale } from '@/theme/tokens';
import {
  PROVIDER_LOGO_PATHS,
  isProviderLogoKind,
  resolveProviderLogoKind,
  type ProviderLogoRouting,
} from '@cindy/model-providers/branding';
import { resolveModelIconKind } from '@cindy/model-providers/sections';

import { providerMonogram } from './providerModelSections';

const MARK_SIZE = 18;

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    monogram: {
      alignItems: 'center',
      borderColor: c.borderStrong,
      borderRadius: radius.pill,
      borderWidth: 1,
      height: MARK_SIZE,
      justifyContent: 'center',
      width: MARK_SIZE,
    },
    monogramText: {
      color: c.textSecondary,
      fontSize: typeScale.micro,
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
}

/** 渲染单个供应商的来源徽标(官方 mark 或 monogram)。 */
export function MobileProviderMark({ providerId, routing, logoKind, name, color }: MobileProviderMarkProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const fill = color ?? colors.textSecondary;
  // 官方 mark 比 monogram 容器缩一档(桌面同比:行内 mark ≈ 12.3 vs 容器 18),避免视觉过重。
  const glyph = 13;

  const kind = isProviderLogoKind(logoKind)
    ? logoKind
    : resolveProviderLogoKind(providerId ?? '', routing);

  switch (kind) {
    case 'anthropic':
      return (
        <View accessible={false} style={styles.markBox}>
          <Svg width={glyph} height={glyph} viewBox="0 0 24 24">
            <Path d={ANTHROPIC_PROVIDER_PATH} fill={fill} />
          </Svg>
        </View>
      );
    case 'openai':
      return (
        <View accessible={false} style={styles.markBox}>
          <Svg width={glyph} height={glyph} viewBox="0 0 24 24">
            <Path d={OPENAI_PROVIDER_PATH} fill={fill} />
          </Svg>
        </View>
      );
    case 'xd': {
      const w = glyph + 2; // XD mark 横长,宽给一点补偿才与正方形 mark 视觉等重。
      return (
        <View accessible={false} style={styles.markBox}>
          <Svg width={w} height={w * XD_ASPECT} viewBox={XD_VIEW_BOX}>
            {XD_SYMBOL_PATHS.map((p) => (
              <Path key={p} d={p} fill={fill} />
            ))}
          </Svg>
        </View>
      );
    }
  }

  if (kind) {
    return (
      <View accessible={false} style={styles.markBox}>
        <Svg width={glyph} height={glyph} viewBox="0 0 24 24">
          <Path d={PROVIDER_LOGO_PATHS[kind]} fill={fill} />
        </Svg>
      </View>
    );
  }

  return (
    <View style={styles.monogram}>
      <Text style={[styles.monogramText, color ? { color } : null]}>
        {providerMonogram(name)}
      </Text>
    </View>
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
}: MobileModelIconMarkProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const kind = resolveModelIconKind(icon);
  if (kind) {
    const fill = color ?? colors.textSecondary;
    const glyph = 13;
    if (kind === 'cindy') {
      const w = glyph + 2; // 同 MobileProviderMark:XD mark 横长,宽给补偿。
      return (
        <View accessible={false} style={styles.markBox}>
          <Svg width={w} height={w * XD_ASPECT} viewBox={XD_VIEW_BOX}>
            {XD_SYMBOL_PATHS.map((p) => (
              <Path key={p} d={p} fill={fill} />
            ))}
          </Svg>
        </View>
      );
    }
    return (
      <View accessible={false} style={styles.markBox}>
        <Svg width={glyph} height={glyph} viewBox="0 0 24 24">
          <Path
            d={kind === 'claude' ? ANTHROPIC_PROVIDER_PATH : OPENAI_PROVIDER_PATH}
            fill={fill}
          />
        </Svg>
      </View>
    );
  }
  return (
    <MobileProviderMark
      color={color}
      name={name}
      providerId={providerId}
      routing={routing}
      logoKind={logoKind}
    />
  );
}
