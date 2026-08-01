import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';
import type { AgentSwitchIntentRecord } from '@/lib/makerChatStore';

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
  /** 发起读回时的本端写序号 vs 响应到达时的当前值。 */
  writeSeqAtStart: number;
  writeSeqNow: number;
  /** 发起读回时的意图引用 vs 响应到达时的当前引用。 */
  intentAtStart: AgentSwitchIntentRecord | null;
  intentNow: AgentSwitchIntentRecord | null;
}

/**
 * device-link 远程会话的 pending 意图读回结果是否仍然新鲜(可以应用)。
 *
 * 单纯比较「当前意图 === 发起时意图」不够:用户在途期间登记又撤销(null → 已登记 → null)
 * 会让两次读数再次相等,过期的非空响应就会把已撤销的意图恢复出来,选择器继续显示一个
 * 用户已经放弃的目标引擎。因此本端写入用单调序号判定(A→B→A 也能识别),外部回流
 * (被控端 push / 另一窗口)再用引用比较兜住。
 */
export function isRemoteIntentReadbackFresh(args: RemoteIntentReadbackFreshness): boolean {
  if (args.cancelled) return false;
  if (args.writeSeqNow !== args.writeSeqAtStart) return false;
  return args.intentNow === args.intentAtStart;
}
