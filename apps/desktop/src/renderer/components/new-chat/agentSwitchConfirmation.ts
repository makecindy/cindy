import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';

/**
 * 隐藏的本地用户 override（规则 20）：键缺失 = 系统默认“显示确认”；用户勾选
 * “下次不再提醒”并确认后，ConfirmDialogProvider 会写入显式 override。删除对应
 * `confirm-dialog.skip:*` localStorage 键即可恢复当前版本默认值，不固化默认快照。
 */
export const AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY = 'new-chat.agent-switch.handoff-risk.v1';

export interface AgentSwitchConfirmationCopy {
  title: string;
  description: string;
  confirmText: string;
  cancelText: string;
  dontShowAgainLabel: string;
}

export interface ConfirmAgentSwitchRiskParams {
  /** 已有切换意图说明用户此前已确认过；后续浏览/改选及撤销均不重复提示。 */
  hasSwitchIntent: boolean;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  copy: AgentSwitchConfirmationCopy;
}

/**
 * Agent 切换确认门。
 *
 * 首次从模型选择器顶部分段进入另一 Agent 的浏览态时提示；已有切换意图代表
 * 用户已经确认过，后续改选模型/来源/effort/Fast 或返回原引擎都直接放行。
 */
export async function confirmAgentSwitchRisk({
  hasSwitchIntent,
  confirm,
  copy,
}: ConfirmAgentSwitchRiskParams): Promise<boolean> {
  if (hasSwitchIntent) return true;

  return confirm({
    title: copy.title,
    description: copy.description,
    // 仅 Agent 切换风险文案禁选；其它 ConfirmDialog 仍保留复制能力。
    textClassName: 'select-none',
    confirmText: copy.confirmText,
    cancelText: copy.cancelText,
    dontShowAgainKey: AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY,
    dontShowAgainLabel: copy.dontShowAgainLabel,
  });
}

export interface RemoteIntentReadbackFreshness {
  /** effect 已清理(切走会话 / 换设备)。 */
  cancelled: boolean;
  /** 发起读回时的本端写序号 vs 响应到达时的当前值(覆盖「已点选但尚未落 store」的窗口)。 */
  writeSeqAtStart: number;
  writeSeqNow: number;
  /** 发起读回时的意图修订号 vs 响应到达时的当前值(覆盖任何来源的实际变更)。 */
  intentRevAtStart: number;
  intentRevNow: number;
}

/**
 * device-link 远程会话的 pending 意图读回结果是否仍然新鲜(可以应用)。
 *
 * 判定必须基于**单调计数**,不能比较意图值本身:意图在途期间从 null 变成非空又清回
 * null(本端登记后撤销,或另一窗口 / 被控端经 sessions:patched 来回改)时,值与引用都会
 * 回到相等,过期的非空响应就会被误判为新鲜、把已取消的意图复活出来,选择器继续显示一个
 * 用户已经放弃的目标引擎,还与被控端权威状态不一致。
 *
 * 两个计数各管一段:store 修订号覆盖**任何来源**的实际变更(含外部回流);本端写序号覆盖
 * 「用户已点选、切换 IPC 还在途、尚未落 store」的空窗。
 */
export function isRemoteIntentReadbackFresh(args: RemoteIntentReadbackFreshness): boolean {
  if (args.cancelled) return false;
  if (args.writeSeqNow !== args.writeSeqAtStart) return false;
  return args.intentRevNow === args.intentRevAtStart;
}
