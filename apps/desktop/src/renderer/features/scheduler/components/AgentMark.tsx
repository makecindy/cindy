/**
 * AgentMark — 按 schedule.agentKind 显示对应的 Agent 身份 mark
 * ---------------------------------------------------------------------------
 * - 'claude-code' → ClaudeMark（Claude Code CLI 像素脸）
 * - 'codex'       → CodexMark（Codex CLI 花形 + `>_`）
 *
 * 颜色由父级通过 className 传 text-xxx 控制（两个 mark 都消费 currentColor）。
 * 用一个统一入口避免每个调用点都写 if/else，未来加新 agent 也只动这一处。
 */

import { CodexMark } from '@/components/icons/CodexMark';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import type { AgentKind } from '@cindy/maker-scheduler';

interface Props {
  agentKind: AgentKind;
  size?: number;
  className?: string;
}

export function AgentMark({ agentKind, size = 14, className }: Props) {
  if (agentKind === 'codex') return <CodexMark size={size} className={className} />;
  return <ClaudeMark size={size} className={className} />;
}
