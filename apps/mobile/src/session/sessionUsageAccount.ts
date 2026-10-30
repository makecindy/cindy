/**
 * 任务菜单的账号余量读哪台电脑(与桌面 apps/desktop/src/renderer/lib/usageAccountLocation.ts 同口径)。
 *
 * 远程 Agent 让 Agent 在另一台电脑上用那台的登录与供应商发模型请求,余量事实也只在那台。被控电脑上
 * 同名的账号与这一轮无关,不能拿来展示。任务价值、上下文等任务数据仍在被控电脑上读。
 */
import type { ProviderView } from '@cindy/model-providers/registry';

import { isProviderShareAgentDeviceId } from './remoteAgentCatalogs';

export type SessionUsageAccount =
  /** Agent 就在被控电脑上:读被控电脑(原有行为)。 */
  | { kind: 'host' }
  /** Agent 在同账号的另一台电脑:手机直接经 device-link 读那台(与读它的模型目录同一条路)。 */
  | { kind: 'device'; deviceId: string }
  /**
   * 读不到那份账号:别人分享的供应商(分享者的余量不对外开放)、共享任务访客(Agent 在任务主人的
   * 其他电脑上),或没指定来源(那台按自己的默认规则挑,无从得知用的哪个账号)。只显示任务价值。
   */
  | { kind: 'unreadable' };

export function resolveSessionUsageAccount(input: {
  /** Agent 现在所在的电脑(null = 被控电脑本身)。 */
  agentDeviceId: string | null;
  providerId: string | null | undefined;
  /** 任务属于别人账号的共享任务(手机是访客)。 */
  sharedTaskGuest: boolean;
  /** SSH 远程工作区:Agent 跑在远端主机上,与电脑端同口径忽略残留的 agentDeviceId。 */
  remoteHostId?: string | null;
}): SessionUsageAccount {
  const agent = input.agentDeviceId;
  if (!agent || input.remoteHostId?.trim()) return { kind: 'host' };
  if (isProviderShareAgentDeviceId(agent) || input.sharedTaskGuest || !input.providerId?.trim()) {
    return { kind: 'unreadable' };
  }
  return { kind: 'device', deviceId: agent };
}

/** 用量卡上的来源名:名称后接登录身份(名称里已含身份时不重复)。 */
export function formatProviderAccountLabel(
  provider: Pick<ProviderView, 'name' | 'openAiAccount' | 'subscriptionAccount'> | undefined,
): string | undefined {
  const identity = provider?.openAiAccount?.identity?.trim()
    || provider?.subscriptionAccount?.identity?.trim();
  const name = provider?.name?.trim();
  return name && identity && !name.includes(identity) ? `${name} · ${identity}` : name;
}
