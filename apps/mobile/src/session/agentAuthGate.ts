/**
 * agentAuthGate —— 手机端「发送前」的 agent 鉴权门禁(纯逻辑,零 react-native)。
 *
 * 对齐桌面 useVendorAuthGate / useVendorReadiness 的判定规则:某 agent 是否可用 =
 * 被控端有没有「已连接的模型供应商」(connectedProvidersForAgent > 0)。连接状态由
 * 被控端 host 注入(XD: api_key 是否存在 / Anthropic: claude.ai OAuth / OpenAI: codex
 * OAuth),经 `maker:provider:list` 隧道取回 —— 与模型选择器同一份数据,不需要新通道。
 *
 * fail-open:目录还没拉到(loading)、拉取失败(旧被控端 CHANNEL_NOT_ALLOWED / 瞬断)、
 * 或回了空目录时判 'unknown',调用方不拦截 —— 拦错了会把可用的发送路径堵死,而放过
 * 去顶多撞上层一的友好错误提示(describeAgentAuthError)兜底。
 */
import { connectedProvidersForAgent } from '@cindy/model-providers/registry';
import type { ProviderView } from '@cindy/model-providers/registry';

import { i18n } from '@/i18n';

export type AgentAuthGateVerdict = 'ready' | 'unauthenticated' | 'unknown';

export interface AgentAuthGateInput {
  /** 被控端供应商目录(useDeviceProviders 的产物)。 */
  providers: ProviderView[];
  /** 目录拉取中(首拉且无缓存)。 */
  loading: boolean;
  /** 目录拉取失败(典型:旧被控端不识别通道)。 */
  error: string | null;
  agentKind: 'claude-code' | 'codex';
  /**
   * true = 已建会话的发送门禁:计入 suspended 来源(停用是准入轴,不打断运行中
   * 会话,门禁只回答「凭证还连着吗」)。缺省 false = 新建草稿:suspended 不算可
   * 路由来源,全停时如实报 unauthenticated,别让草稿创建到 Main 侧才被拒
   * (PR #744 review 第十、十四轮)。
   */
  existingSessionRoute?: boolean;
}

/** 判定某 agent 在被控端是否有已连接来源;不确定时回 'unknown'(调用方不拦截)。 */
export function agentAuthGateVerdict(input: AgentAuthGateInput): AgentAuthGateVerdict {
  if (input.loading || input.error !== null || input.providers.length === 0) return 'unknown';
  return connectedProvidersForAgent(input.providers, input.agentKind, {
    includeSuspended: input.existingSessionRoute === true,
  }).length > 0
    ? 'ready'
    : 'unauthenticated';
}

/** 未鉴权时的提示文案(与 describeAgentAuthError 的引导口径一致)。 */
export function agentAuthGateHint(agentKind: 'claude-code' | 'codex'): string {
  const label = agentKind === 'claude-code' ? 'Claude' : 'Codex';
  return i18n.t('session.row.authGateHint', { agent: label });
}
