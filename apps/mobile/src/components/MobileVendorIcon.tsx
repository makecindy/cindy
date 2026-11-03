import { Animated } from 'react-native';
import { useSessionBreathing } from '@/hooks/useSessionBreathing';
import { RemoteSourceMark } from '@/session/RemoteSourceMark';
import { useTheme } from '@/theme';

import { MobileAgentMark } from './MobileAgentMark';

type AgentMarkKind = 'claude-code' | 'codex' | 'pi';

/**
 * 各字形笔画右上角在自身方框里的位置(0–1,已留出与波纹点的间隙),与桌面 VendorIcon 的
 * REMOTE_SIGNAL_ANCHOR 同一套。π 在手机端是 24 单位画布里的描边路径(右上沿约 20.4, 6.6),
 * 比桌面的 π 字符大,按路径定。
 */
const REMOTE_SIGNAL_ANCHOR: Record<AgentMarkKind, { x: number; y: number }> = {
  'claude-code': { x: 0.95, y: 0.13 },
  codex: { x: 0.9, y: 0.1 },
  pi: { x: 0.93, y: 0.19 },
};

interface MobileVendorIconProps {
  color?: string;
  running?: boolean;
  size?: number;
  vendor: 'cc' | 'codex' | string;
  /**
   * Agent 在另一台电脑运行:右上角外侧叠与模型胶囊同款的单波纹 + 点(随图标取色与呼吸),
   * 图标本身大小与位置不变(与桌面侧栏同一种做法)。
   */
  remote?: boolean;
}

export function MobileVendorIcon({
  color: colorOverride,
  running = false,
  size = 12,
  vendor,
  remote = false,
}: MobileVendorIconProps) {
  const { colors } = useTheme();
  const opacity = useSessionBreathing(running);
  const color = colorOverride ?? (running ? colors.statusAccent : colors.textTertiary);

  const agentKind: AgentMarkKind = vendor === 'codex' || vendor === 'pi' ? vendor : 'claude-code';
  const mark = <MobileAgentMark agentKind={agentKind} color={color} size={size} />;
  const anchor = REMOTE_SIGNAL_ANCHOR[agentKind];
  return (
    <Animated.View
      accessible
      accessibilityLabel={vendor === 'codex' ? 'Codex' : vendor === 'pi' ? 'Pi' : 'Claude Code'}
      accessibilityRole="image"
      style={{ alignItems: 'center', height: size, justifyContent: 'center', opacity, width: size }}
    >
      {remote ? (
        <RemoteSourceMark
          color={color}
          inset={{ x: (1 - anchor.x) * size, y: anchor.y * size }}
          size={size}
        >
          {mark}
        </RemoteSourceMark>
      ) : (
        mark
      )}
    </Animated.View>
  );
}
