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

export interface AgentSwitchResponseFreshness {
  /** 发起方已放弃(effect 清理:切走会话 / 换设备)。同步调用点传 false。 */
  cancelled: boolean;
  /** 发起时的本端写序号 vs 响应到达时的当前值(覆盖「已点选但尚未落 store」的窗口)。 */
  writeSeqAtStart: number;
  writeSeqNow: number;
  /** 发起时的意图修订号 vs 响应到达时的当前值(覆盖任何来源的实际变更)。 */
  intentRevAtStart: number;
  intentRevNow: number;
}

/**
 * device-link 远程会话的异步意图响应是否仍然新鲜(可以落到展示态)。两个调用点同构:
 * 打开 / 重连时的**权威意图读回**,以及切换 IPC 的**登记 ack**——两者都在 await 期间
 * 可能被更新的状态超车,落下去就会让选择器显示过期引擎,与被控端实际要执行的不一致。
 *
 * 判定必须基于**单调计数**,不能比较意图值本身:意图在途期间从 null 变成非空又清回
 * null(本端登记后撤销,或另一窗口 / 被控端经 sessions:patched 来回改)时,值与引用都会
 * 回到相等,过期响应就会被误判为新鲜。
 *
 * 两个计数各管一段:store 修订号覆盖**任何来源**的实际变更(含外部权威回流);本端写序号
 * 覆盖「用户已点选、切换 IPC 还在途、尚未落 store」的空窗。
 */
export function isAgentSwitchResponseFresh(args: AgentSwitchResponseFreshness): boolean {
  if (args.cancelled) return false;
  if (args.writeSeqNow !== args.writeSeqAtStart) return false;
  return args.intentRevNow === args.intentRevAtStart;
}

/** 切换 ack 到达后该做什么。 */
export type AgentSwitchAckAction =
  /** 登记乐观意图(deferred 常态路径)。 */
  | 'apply-intent'
  /** 同引擎 no-op:清掉展示意图,把这次点选当普通模型/来源切换应用到当前引擎。 */
  | 'same-engine-reselect'
  /** 立即切换已完成(harness / registry 缺省兜底),收敛真实引擎。 */
  | 'apply-switched'
  /** 已被更新的状态超车,本次 ack 作废。 */
  | 'discard';

/**
 * 切换 ack 的分派决策。三类判据作用域**不同**,不能一刀切:
 *
 * - **写序号**(本端点选)对所有分支生效:用户又点了一次,本次 ack 整体作废。
 * - **意图修订号**保护「要把本次选择写成乐观意图值」的分支(apply-intent /
 *   apply-switched):外部权威值更新,就不能用旧选择盖回去。
 * - 同引擎 no-op 不能从 renderer 的「修订号 + 最终值」猜因果：外部 set→clear ABA 与
 *   本次 clear 都会得到「修订号已变 + 当前为空」。新 host 因此返回 CAS 成功后的
 *   `sameEngineRevision`，后续 SET_MODEL 带回该 token 再做一次 CAS；若请求已在 host
 *   内被超车则返回 `sameEngineSuperseded` 直接丢弃。远程入口另由
 *   `supportsSessionAgentSwitchCas` 门控，不会向缺 token 的旧 host 开放；这里的无 token
 *   分支只作本地 harness / 防御性兼容，修订号变化时仍 fail-closed。
 */
export function resolveAgentSwitchAckAction(args: {
  deferred: boolean;
  switched: boolean;
  sameEngineRevision?: number;
  sameEngineSuperseded?: boolean;
  freshness: AgentSwitchResponseFreshness;
}): AgentSwitchAckAction {
  const { freshness } = args;
  if (freshness.cancelled) return 'discard';
  if (freshness.writeSeqNow !== freshness.writeSeqAtStart) return 'discard';
  if (args.deferred) return isAgentSwitchResponseFresh(freshness) ? 'apply-intent' : 'discard';
  if (!args.switched) {
    if (args.sameEngineSuperseded) return 'discard';
    if (args.sameEngineRevision !== undefined) return 'same-engine-reselect';
    return freshness.intentRevNow === freshness.intentRevAtStart
      ? 'same-engine-reselect'
      : 'discard';
  }
  return isAgentSwitchResponseFresh(freshness) ? 'apply-switched' : 'discard';
}
