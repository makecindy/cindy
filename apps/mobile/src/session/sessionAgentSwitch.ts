/**
 * 手机端跨 Agent 切换的纯契约适配：只接收 desktop main 的公开 pending intent，
 * 不在控制端持久化第二份真相。
 */
import type { MobileAgentCapabilities } from './agentCapabilities';
import type { RemoteSession, RemoteSessionAgentSwitchIntent } from './types';

export type MobileSessionAgentKind = 'claude-code' | 'codex' | 'pi';

/** 将不可信 device-link payload 收窄为公开 intent；非法值按“无意图”处理。 */
export function normalizeSessionAgentSwitchIntent(
  value: unknown,
): RemoteSessionAgentSwitchIntent | null {
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
  if (item.fastMode !== undefined && (typeof item.fastMode !== 'boolean' && item.fastMode !== 'ultrafast')) return null;
  // 远程 Agent:只在这笔切换同时换 Agent 所在电脑时出现(null = 改回被控电脑本机)。
  // 缺省 = 位置不变;非空 string / null 之外的脏值与其它字段同口径判非法。
  if (
    item.agentDeviceId !== undefined
    && item.agentDeviceId !== null
    && (typeof item.agentDeviceId !== 'string' || item.agentDeviceId.length === 0)
  ) return null;
  return {
    targetAgentKind: item.targetAgentKind,
    model: item.model,
    providerId: typeof item.providerId === 'string' ? item.providerId : null,
    ...(typeof item.effort === 'string' && item.effort.length > 0
      ? { effort: item.effort }
      : {}),
    ...((typeof item.fastMode === 'boolean' || item.fastMode === 'ultrafast') ? { fastMode: item.fastMode } : {}),
    ...(item.agentDeviceId !== undefined
      ? { agentDeviceId: item.agentDeviceId as string | null }
      : {}),
  };
}

/** DB 会话行的 cc/codex 映射到 maker agent kind。 */
export function sessionAgentKind(session: Pick<RemoteSession, 'agentKind'>): MobileSessionAgentKind {
  return session.agentKind === 'codex' || session.agentKind === 'pi'
    ? session.agentKind
    : 'claude-code';
}

/** 手机是否应展示 Agent 分段；远程 SSH 仍由被控端能力限制。 */
export function supportsMobileSessionAgentSwitch(
  session: Pick<RemoteSession, 'remoteHostId' | 'orcaRole'>,
  capabilities: MobileAgentCapabilities | null,
): boolean {
  return capabilities?.supportsSessionAgentSwitch === true
    && !session.remoteHostId;
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

/** 任务的 Agent 是否在同账号另一台电脑上运行(desktop sessions.agent_device_id 非空)。 */
export function sessionAgentRunsOnOtherComputer(
  session: Pick<RemoteSession, 'agentDeviceId'> | null | undefined,
): boolean {
  return typeof session?.agentDeviceId === 'string' && session.agentDeviceId.length > 0;
}

/** pending intent 是否同时改 Agent 所在电脑(带 agentDeviceId 键,null = 改回被控电脑)。 */
export function intentChangesAgentLocation(
  intent: RemoteSessionAgentSwitchIntent | null | undefined,
): boolean {
  return !!intent && intent.agentDeviceId !== undefined;
}

/**
 * 下一条消息时 Agent 所在的电脑(与桌面 effectiveAgentDeviceId 同口径):pending intent 带
 * 位置就用它,否则用任务当前的位置。null = 被控电脑本机。
 */
export function effectiveAgentDeviceId(
  session: Pick<RemoteSession, 'agentDeviceId'> | null | undefined,
  intent: RemoteSessionAgentSwitchIntent | null | undefined,
): string | null {
  if (intent && intent.agentDeviceId !== undefined) return intent.agentDeviceId;
  return sessionAgentRunsOnOtherComputer(session) ? session!.agentDeviceId! : null;
}

/**
 * 选回任务当前的运行位置时不带位置，覆盖挂着的搬迁意图。
 * 固定位置的任务只接受当前电脑的目录。null 位置值指被控电脑。
 */
export function resolveAgentLocationPick(input: {
  movable: boolean;
  session: Pick<RemoteSession, 'agentDeviceId'> | null | undefined;
  catalogDeviceId: string | null;
}): { agentDeviceId?: string | null } | null {
  const current = effectiveAgentDeviceId(input.session, null);
  if (input.catalogDeviceId === current) return {};
  return input.movable ? { agentDeviceId: input.catalogDeviceId } : null;
}

/** agent_switch 边界行里 Agent 换电脑后的目标位置;缺 toAgentDeviceId 键 = 没换电脑。 */
export type AgentSwitchLocationTarget =
  | { kind: 'named'; name: string }
  | { kind: 'thisComputer' }
  | { kind: 'otherComputer' };

export function readAgentSwitchLocationTarget(
  data: Record<string, unknown> | undefined,
): AgentSwitchLocationTarget | null {
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'toAgentDeviceId')) return null;
  const name = typeof data.toAgentDeviceName === 'string' ? data.toAgentDeviceName.trim() : '';
  if (name) return { kind: 'named', name };
  return data.toAgentDeviceId === null ? { kind: 'thisComputer' } : { kind: 'otherComputer' };
}
