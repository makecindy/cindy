/**
 * 本机任务按供应商记「本机」用量(provider-groups.md §7；账本见 usage/providerPartyUsageStore)：
 *  - 任务归本机建的供应商组：记在组那个供应商上，Agent 在组里哪台电脑运行都算，并记下是哪台(绑定里的组内电脑)；
 *  - 否则只在 Agent 就在本机运行时，记在任务用的供应商上(组内电脑记为本机)。Agent 在别的电脑运行(远程 Agent、
 *    别的电脑上的组)或 SSH 远程工作区的任务不记，那一份由运行它的电脑记在「我的其他电脑」下。
 *  - 任务归另一台电脑上的组、分到的不是组所在电脑本身：组所在电脑经手不到，另记一份(组所在电脑的坐标)报告给它，
 *    它的「用量」块才算得全(provider-group/usageReporter)。分到组所在电脑本身的由它自己记。
 * 绑定只在换电脑、发送前检查时核对，任务被挪出组而绑定还没清掉的空档里不能照它记：任务此刻所在的电脑与供应商
 * 和绑定那台对得上才按组记，对不上按没有组处理。
 * 每个任务实例一个计量器(Claude 的累计值跟着 SDK 进程走)，与受邀者用量同一套算法。
 */
import type { AgentEvent, Session } from '@cindy/maker-core';

import { PROVIDER_GROUP_LOCAL_MEMBER_KEY } from '../../shared/providerGroup.js';
import { PROVIDER_SHARE_AGENT_DEVICE_PREFIX } from '../../shared/providerShare.js';
import type { ProviderGroupBinding } from '../provider-group/bindings.js';
import { createGuestUsageMeter, type GuestUsageSample } from '../remote-agent/host/guestUsage.js';

export interface SessionProviderPartyUsageDeps {
  /** 任务现在用的供应商；跟随默认路由时为 null。 */
  providerOf(sessionId: string): string | null;
  bindingOf(sessionId: string): ProviderGroupBinding | null;
  /** 本机的设备 id(另一台电脑上的组把本机记作 `device:<本机>:…`)；读不到为 null。 */
  selfDeviceId?(): string | null;
  record(usage: { kind: string; providerId: string; memberKey: string; samples: GuestUsageSample[] }): void;
  /** 记下要报告给组所在电脑的一份。 */
  recordForGroup?(usage: {
    groupDeviceId: string;
    kind: string;
    providerId: string;
    memberKey: string;
    samples: GuestUsageSample[];
  }): void;
}

/** 任务此刻在哪：Agent 所在电脑(null = 本机)与用的供应商(跟随默认路由时为 null)。 */
export interface SessionUsageLocation {
  agentDeviceId: string | null;
  providerId: string | null;
  selfDeviceId?: string | null;
}

/**
 * 任务此刻是不是就在绑定记的那台组内电脑上运行。组内电脑的键是组所在电脑的坐标：组所在电脑自己是 `local`，
 * 同账号电脑 `device:<设备>:<供应商>`，分享来的电脑 `share:<分享>:<供应商>`。任务没记供应商(跟随默认路由)
 * 时只比电脑。
 */
export function bindingMatchesLocation(binding: ProviderGroupBinding, location: SessionUsageLocation): boolean {
  const remote = binding.groupDeviceId ?? null;
  // 换成组所在电脑的坐标：本机的组里 null 就是本机；另一台电脑的组里本机是 `device:<本机>`。
  const here = location.agentDeviceId ?? (remote ? (location.selfDeviceId ?? null) : null);
  const providerMatches = (providerId: string) => location.providerId === null || location.providerId === providerId;
  const key = binding.memberKey;
  if (key === PROVIDER_GROUP_LOCAL_MEMBER_KEY) return here === remote && providerMatches(binding.providerId);
  for (const prefix of ['device:', 'share:'] as const) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const split = rest.indexOf(':');
    if (split <= 0) return false;
    const id = rest.slice(0, split);
    const at = prefix === 'device:' ? id : `${PROVIDER_SHARE_AGENT_DEVICE_PREFIX}${id}`;
    return here === at && providerMatches(rest.slice(split + 1));
  }
  return false;
}

/** 这一轮要不要报告给另一台电脑上的组：要报告时给出组所在电脑与它坐标下的供应商、组内电脑。 */
export function groupUsageReportOf(input: {
  binding: ProviderGroupBinding | null;
  remoteHostId: string | null;
} & SessionUsageLocation): { groupDeviceId: string; providerId: string; memberKey: string } | null {
  const binding = input.binding;
  if (input.remoteHostId || !binding?.groupDeviceId) return null;
  // 分到组所在电脑本身(它那边的 `local`)：它在自己那里就记到了，再报会算两次。
  if (binding.memberKey === PROVIDER_GROUP_LOCAL_MEMBER_KEY) return null;
  if (!bindingMatchesLocation(binding, input)) return null;
  return { groupDeviceId: binding.groupDeviceId, providerId: binding.providerId, memberKey: binding.memberKey };
}

/** 这一轮记在本机的哪个供应商上、算在哪台组内电脑；不记返回 null。 */
export function localUsageProviderOf(input: {
  binding: ProviderGroupBinding | null;
  remoteHostId: string | null;
} & SessionUsageLocation): { providerId: string; memberKey: string } | null {
  if (input.remoteHostId) return null;
  if (input.binding && !input.binding.groupDeviceId && bindingMatchesLocation(input.binding, input)) {
    return { providerId: input.binding.providerId, memberKey: input.binding.memberKey };
  }
  if (input.agentDeviceId || !input.providerId) return null;
  return { providerId: input.providerId, memberKey: PROVIDER_GROUP_LOCAL_MEMBER_KEY };
}

const meters = new WeakMap<Session, ReturnType<typeof createGuestUsageMeter>>();

export function recordSessionProviderPartyUsage(
  deps: SessionProviderPartyUsageDeps,
  session: Session,
  event: AgentEvent,
): void {
  if (event.type !== 'done' && event.type !== 'status') return;
  let meter = meters.get(session);
  if (!meter) {
    meter = createGuestUsageMeter(session.agentKind);
    meters.set(session, meter);
  }
  // 每一轮都喂给计量器，不记的轮次也要更新 Claude 的累计基线。
  const samples = meter.observe(event, session.model);
  if (samples.length === 0) return;
  const binding = deps.bindingOf(session.id);
  const location: SessionUsageLocation = {
    agentDeviceId: session.agentDeviceId,
    providerId: deps.providerOf(session.id),
    selfDeviceId: deps.selfDeviceId?.() ?? null,
  };
  const target = localUsageProviderOf({ binding, remoteHostId: session.remoteHostId, ...location });
  if (target) deps.record({ kind: session.agentKind, ...target, samples });
  const report = groupUsageReportOf({ binding, remoteHostId: session.remoteHostId, ...location });
  if (report) deps.recordForGroup?.({ kind: session.agentKind, ...report, samples });
}
