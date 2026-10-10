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
  agentKind: 'claude-code' | 'codex' | 'pi' | 'cursor';
  color: string;
  size?: number;
}

/** 单色 CLI mark；颜色由宿主的主题 / 状态 token 决定。 */
export function MobileAgentMark({ agentKind, color, size = iconSize.sm }: MobileAgentMarkProps) {
  const codexStrokeWidth = size <= iconSize.sm ? CODEX_SMALL_STROKE : CODEX_LARGE_STROKE;
  return (
    <Svg accessible={false} height={size} viewBox="0 0 24 24" width={size}>
      {agentKind === 'cursor' ? (
        <Path fill={color} d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
      ) : agentKind === 'pi' ? (
        // Keep all three strokes in one native path. Separate horizontal/vertical
        // paths have degenerate bounds and can disappear in the iOS SVG renderer.
        <Path
          d="M3.6 6.6h16.8 M8.4 6.6v11.8 M15.6 6.6v9.6c0 1.5.9 2.2 2.4 2.2"
          fill="none"
          stroke={color}
          strokeWidth={PI_STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
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
