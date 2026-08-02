/**
 * 手机端跨 Agent 切换的纯契约适配：只接收 desktop main 的公开 pending intent，
 * 不在控制端持久化第二份真相。
 */
import type {
  MobileSessionAgentSwitchIntent,
} from '@cindy/maker-shared/device-link-contract';

import type { MobileAgentCapabilities } from './agentCapabilities';
import type { RemoteSession } from './types';

export type MobileSessionAgentKind = 'claude-code' | 'codex' | 'pi';

/** 将不可信 device-link payload 收窄为公开 intent；非法值按“无意图”处理。 */
export function normalizeSessionAgentSwitchIntent(
  value: unknown,
): MobileSessionAgentSwitchIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    item.targetAgentKind !== 'claude-code'
    && item.targetAgentKind !== 'codex'
    && item.targetAgentKind !== 'pi'
  ) return null;
  if (typeof item.model !== 'string' || item.model.length === 0) return null;
  // providerId 缺失(undefined)按 null 处理,与桌面 projectPendingAgentSwitchIntent 的
  // `providerId ?? null` 语义对齐——只有出现非 string / 非 null / 非 undefined 的脏值才判非法,
  // 避免协议演进或旧 host 漏发该字段时把合法 pending intent 静默丢弃。
  if (item.providerId != null && typeof item.providerId !== 'string') return null;
  if (item.effort !== undefined && typeof item.effort !== 'string') return null;
  if (item.fastMode !== undefined && typeof item.fastMode !== 'boolean') return null;
  return {
    targetAgentKind: item.targetAgentKind,
    model: item.model,
    providerId: typeof item.providerId === 'string' ? item.providerId : null,
    ...(typeof item.effort === 'string' && item.effort.length > 0
      ? { effort: item.effort }
      : {}),
    ...(typeof item.fastMode === 'boolean' ? { fastMode: item.fastMode } : {}),
  };
}

/** DB 会话行的 cc/codex 映射到 maker agent kind。 */
export function sessionAgentKind(session: Pick<RemoteSession, 'agentKind'>): MobileSessionAgentKind {
  return session.agentKind === 'codex' || session.agentKind === 'pi'
    ? session.agentKind
    : 'claude-code';
}

/** 手机是否应展示 Agent 分段；远程 SSH / Orca 会话继续保持单 Agent。 */
export function supportsMobileSessionAgentSwitch(
  session: Pick<RemoteSession, 'remoteHostId' | 'orcaRole'>,
  capabilities: MobileAgentCapabilities | null,
): boolean {
  return capabilities?.supportsSessionAgentSwitch === true
    && !session.remoteHostId
    && !session.orcaRole;
}

export function mobileAgentLabel(agentKind: MobileSessionAgentKind): string {
  return agentKind === 'codex' ? 'Codex' : agentKind === 'pi' ? 'Pi' : 'Claude Code';
}

export function mobileAgentLabelFromUnknown(agentKind: unknown): string {
  return agentKind === 'codex' ? 'Codex' : agentKind === 'pi' ? 'Pi' : 'Claude Code';
}

export function mobileAgentVendor(agentKind: MobileSessionAgentKind): 'cc' | 'codex' | 'pi' {
  return agentKind === 'claude-code' ? 'cc' : agentKind;
}
