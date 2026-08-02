/**
 * MobileAgentMark —— Claude Code / Codex CLI 的 Agent 身份 mark。
 * 不用于 Anthropic / OpenAI provider 或模型品牌；后两者由 MobileProviderMark 负责。
 */
import Svg, { G, Path, Text as SvgText } from 'react-native-svg';
import { StyleSheet } from 'react-native';

import { iconSize, iconStroke } from '@/theme';

import {
  CLAUDE_AGENT_PATH,
  CODEX_AGENT_FLOWER_PATH,
  CODEX_AGENT_PROMPT_PATH,
} from './vendorIconPaths';

export interface MobileAgentMarkProps {
  agentKind: 'claude-code' | 'codex' | 'pi';
  color: string;
  size?: number;
}

/** 单色 CLI mark；颜色由宿主的主题 / 状态 token 决定。 */
export function MobileAgentMark({ agentKind, color, size = iconSize.sm }: MobileAgentMarkProps) {
  const codexStrokeWidth = size <= iconSize.sm ? iconStroke.regular : iconStroke.thin;
  return (
    <Svg accessible={false} height={size} viewBox="0 0 24 24" width={size}>
      {agentKind === 'pi' ? (
        <SvgText fill={color} fontSize="19" fontWeight="600" textAnchor="middle" x="12" y="18">π</SvgText>
      ) : agentKind === 'codex' ? (
        <G transform="translate(12 12) scale(1.1) translate(-12 -12)">
          <Path
            d={`${CODEX_AGENT_FLOWER_PATH}z`}
            fill="none"
            stroke={color}
            strokeLinejoin="round"
            strokeWidth={codexStrokeWidth}
          />
          <Path
            d={CODEX_AGENT_PROMPT_PATH}
            fill={color}
            stroke={color}
            strokeLinejoin="round"
            strokeWidth={StyleSheet.hairlineWidth}
          />
        </G>
      ) : (
        <Path clipRule="evenodd" d={CLAUDE_AGENT_PATH} fill={color} fillRule="evenodd" />
      )}
    </Svg>
  );
}
