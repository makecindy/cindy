/**
 * MobileAgentMark —— Claude Code / Codex CLI 的 Agent 身份 mark。
 * 不用于 Anthropic / OpenAI provider 或模型品牌；后两者由 MobileProviderMark 负责。
 */
import Svg, { G, Path } from 'react-native-svg';

import { iconSize } from '@/theme';

import {
  CLAUDE_AGENT_PATH,
  CODEX_AGENT_FLOWER_PATH,
  CODEX_AGENT_PROMPT_PATH,
} from './vendorIconPaths';

// Brand geometry in the shared 24-unit viewBox, matching Desktop PiMark / CodexMark.
const PI_STROKE = 2.4;
const CODEX_PROMPT_STROKE = 0.5;
const CODEX_SMALL_STROKE = 2;
const CODEX_LARGE_STROKE = 1.6;

export interface MobileAgentMarkProps {
  agentKind: 'claude-code' | 'codex' | 'pi';
  color: string;
  size?: number;
}

/** 单色 CLI mark；颜色由宿主的主题 / 状态 token 决定。 */
export function MobileAgentMark({ agentKind, color, size = iconSize.sm }: MobileAgentMarkProps) {
  const codexStrokeWidth = size <= iconSize.sm ? CODEX_SMALL_STROKE : CODEX_LARGE_STROKE;
  return (
    <Svg accessible={false} height={size} viewBox="0 0 24 24" width={size}>
      {agentKind === 'pi' ? (
        <G fill="none" stroke={color} strokeWidth={PI_STROKE} strokeLinecap="round" strokeLinejoin="round"><Path d="M3.6 6.6h16.8" /><Path d="M8.4 6.6v11.8" /><Path d="M15.6 6.6v9.6c0 1.5.9 2.2 2.4 2.2" /></G>
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
            strokeWidth={CODEX_PROMPT_STROKE}
          />
        </G>
      ) : (
        <Path clipRule="evenodd" d={CLAUDE_AGENT_PATH} fill={color} fillRule="evenodd" />
      )}
    </Svg>
  );
}
