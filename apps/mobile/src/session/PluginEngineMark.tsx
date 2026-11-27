/**
 * 插件引擎的标识(Desktop PluginEngineIcon 的手机版)：插件自己的图标(manifest icon，data URL)，
 * 没有图标时用通用拼图标识。
 *
 * `tint` 给任务列表等状态图标用：非运行时把插件图标按透明度画成灰色剪影(与 Desktop 侧栏一致)；
 * 运行中(保留原色呼吸)以及模型选择器、输入框胶囊不传，保留图标原色。
 */
import { ANTIGRAVITY_MARK_DATA_URL, ANTIGRAVITY_MARK_PATH } from '@cindy/maker-shared/branding';
import Svg, { Path } from 'react-native-svg';
import { Puzzle } from 'lucide-react-native';
import { Image, View } from 'react-native';

import { iconSize, iconStroke, radius, useTheme } from '@/theme';
import { RemoteSourceMark } from './RemoteSourceMark';

export interface PluginEngineMarkProps {
  iconDataUrl?: string | null;
  size?: number;
  /** 单色剪影的颜色；缺省 = 图标原色(通用标识用次要文字色)。 */
  tint?: string;
  /** true → 另一台电脑或分享来的插件引擎：右上角叠远程标记（波纹 + 点）。 */
  remote?: boolean;
  testID?: string;
}

export function PluginEngineMark({ iconDataUrl, size = iconSize.sm, tint, remote, testID }: PluginEngineMarkProps) {
  const { colors } = useTheme();
  const glyph = iconDataUrl === ANTIGRAVITY_MARK_DATA_URL ? (
    <Svg width={size} height={size} viewBox="0 0 24 24" testID={testID}>
      <Path d={ANTIGRAVITY_MARK_PATH} fill={tint ?? colors.textSecondary} />
    </Svg>
  ) : iconDataUrl ? (
    <View accessible={false} pointerEvents="none" style={{ height: size, width: size }} testID={testID}>
      <Image
        accessibilityIgnoresInvertColors
        resizeMode="contain"
        source={{ uri: iconDataUrl }}
        style={{ borderRadius: radius.micro, height: size, width: size, ...(tint ? { tintColor: tint } : {}) }}
      />
    </View>
  ) : (
    <Puzzle
      color={tint ?? colors.textSecondary}
      size={size}
      strokeWidth={iconStroke.regular}
      testID={testID}
    />
  );
  if (!remote) return glyph;
  return (
    <RemoteSourceMark color={tint ?? colors.textSecondary} inset={{ x: 0, y: 0 }} size={size}>
      {glyph}
    </RemoteSourceMark>
  );
}
