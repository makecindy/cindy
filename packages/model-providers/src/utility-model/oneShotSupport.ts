import type {AgentKind} from '../types.js';
  /**
   * 实现了 `Agent.oneShot` 的 agent 集合(当前 claude-code / codex)。PiAgent 继承 BaseAgent
   * 的 not-implemented,选中它调 oneShot 会抛错;help 兜底与任务摘要兜底都据此跳过 Pi,避免
   * best-effort 结果被静默丢弃。Pi 实现 oneShot 后把它加入本集合即可。
   */
  const ONESHOT_CAPABLE_AGENTS: ReadonlySet<AgentKind> = new Set([
    'claude-code',
    'codex',
  ]);
  export function agentSupportsOneShot(agentKind: AgentKind): boolean {
    return ONESHOT_CAPABLE_AGENTS.has(agentKind);
  }

