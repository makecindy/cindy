/**
 * 本轮消耗的是哪台电脑的账号额度 —— 任务底部用量 chip 读谁的订阅余量。
 *
 * 远程 Agent(协议见 docs/dev-rules/protocol-compatibility.md「远程 Agent」)让 Agent 在另一台
 * 电脑上用那台的登录与供应商发模型请求,余量事实也只在那台。任务所在电脑(本机,或远程控制的
 * 被控电脑)的账号与这一轮无关,不能拿来展示。
 */
import { isProviderShareAgentDeviceId } from '../../shared/providerShare';

export type UsageAccountLocation =
  /** Agent 就在任务所在电脑:本机任务读本机,远程控制的任务读被控电脑(原有行为)。 */
  | { kind: 'task' }
  /** 远程控制的任务把 Agent 挪到了本机:读本机账号。 */
  | { kind: 'local' }
  /** Agent 在同账号的另一台电脑:经 device-link 读那台的余量镜像(与模型选择器同一份)。 */
  | { kind: 'device'; deviceId: string }
  /**
   * 读不到那份账号:别人分享的供应商(分享者的余量不对受邀者开放)、共享任务访客(Agent 在任务主人
   * 的其他电脑上),或没指定来源(那台按自己的默认规则挑,本机无从得知用的哪个账号)。
   * 只显示任务价值,不拿本机或被控电脑的账号凑数。
   */
  | { kind: 'unreadable' };

export const TASK_USAGE_ACCOUNT: UsageAccountLocation = { kind: 'task' };

export function resolveUsageAccountLocation(input: {
  /** 远程控制的任务所在的被控电脑;本机任务为 null / undefined。 */
  taskDeviceId: string | null | undefined;
  /** 任务记录的 Agent 所在电脑(null / undefined = 任务所在电脑)。 */
  agentDeviceId: string | null | undefined;
  /** 挂着的换位置意图:undefined = 位置不变,null = 换回任务所在电脑。chip 按意图显示下一轮。 */
  pendingAgentDeviceId?: string | null;
  /** chip 展示的来源(意图期内为意图的来源)。 */
  providerId: string | null | undefined;
  selfDeviceId: string | null | undefined;
  /** 任务属于别人账号的共享任务(本机是访客)。 */
  sharedTaskGuest?: boolean;
  /** SSH 远程工作区:Agent 跑在远端主机上,与 main 同口径忽略残留的 agentDeviceId。 */
  remoteHostId?: string | null;
}): UsageAccountLocation {
  if (input.remoteHostId) return TASK_USAGE_ACCOUNT;
  const agent =
    input.pendingAgentDeviceId !== undefined ? input.pendingAgentDeviceId : input.agentDeviceId;
  if (!agent || agent === input.taskDeviceId) return TASK_USAGE_ACCOUNT;
  if (!input.taskDeviceId && agent === input.selfDeviceId) return TASK_USAGE_ACCOUNT;
  if (isProviderShareAgentDeviceId(agent) || input.sharedTaskGuest || !input.providerId?.trim()) {
    return { kind: 'unreadable' };
  }
  if (agent === input.selfDeviceId) return { kind: 'local' };
  return { kind: 'device', deviceId: agent };
}
