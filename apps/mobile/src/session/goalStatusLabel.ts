/**
 * mobile 侧 goal 状态标签与 reason 文案的纯逻辑。
 *
 * 单独成 .ts 而不是留在 ContextSheetGoalView.tsx 里: 组件文件会拉进 react-native,
 * 单测环境跑不起来 —— 与仓库其它 *Model 模块同规, 纯判定抽出来单测。
 */
import { i18n } from '@/i18n';
import type { MobileGoalStatus } from '@cindy/maker-shared/device-link-contract';

/**
 * goal-host 在「上游过载」时写进 GoalState.lastReason 的判据串。
 *
 * 过载与账号限流共用 `usageLimited`(都是可恢复 + 到点自动续跑), 状态本身分不出两者,
 * 状态标签要说对话就得看这个 reason。判据来源是桌面 main 侧的
 * goal-host/usageLimit.ts:OVERLOAD_LAST_REASON —— mobile 不能 import 那边, 因此镜像
 * 一份常量(与 remoteSessionStore 里镜像过载进度判定同规)。两侧改动必须同步。
 */
export const GOAL_OVERLOAD_LAST_REASON = 'model service at capacity';

/**
 * 状态标签映射。值用 getter 惰性求值(i18n.t 在访问时调用,不冻结语言),
 * 既保留 `GOAL_STATUS_LABEL[status]` 索引用法给外部调用方,又跟随语言切换。
 */
export const GOAL_STATUS_LABEL: Record<MobileGoalStatus, string> = {
  get active() { return i18n.t('interaction.contextSheet.goalStatus.active'); },
  get paused() { return i18n.t('interaction.contextSheet.goalStatus.paused'); },
  get blocked() { return i18n.t('interaction.contextSheet.goalStatus.blocked'); },
  get complete() { return i18n.t('interaction.contextSheet.goalStatus.complete'); },
  get budgetLimited() { return i18n.t('interaction.contextSheet.goalStatus.budgetLimited'); },
  get usageLimited() { return i18n.t('interaction.contextSheet.goalStatus.usageLimited'); },
};

/**
 * 状态标签(考虑 lastReason)。usageLimited 有两种来源, 过载那种说「用量受限」是假信息:
 * 账号从没被限流, 只是上游暂时没有可用容量(review #844 codex P1)。
 *
 * 抽成函数而不是在各调用点分别判: 这个标签有两处渲染(Context 面板的状态 chip 与会话页
 * 顶部), 分开写迟早漂移。
 */
export function goalStatusLabel(
  status: MobileGoalStatus,
  lastReason?: string | null,
): string {
  if (status === 'usageLimited' && lastReason === GOAL_OVERLOAD_LAST_REASON) {
    return i18n.t('interaction.contextSheet.goalStatus.capacityLimited');
  }
  return GOAL_STATUS_LABEL[status];
}

/**
 * lastReason 的展示文案。内部判据串是英文(goal-host 写给自己看的), 直接渲染等于把实现
 * 细节推给用户 —— 过载这条本 PR 新引入, 必须本地化(review #844 codex P1)。
 * 其它 reason 的裸英文是既有行为, 未在本 PR 内一并处理。
 */
export function goalReasonText(lastReason?: string | null): string | null {
  if (!lastReason) return null;
  if (lastReason === GOAL_OVERLOAD_LAST_REASON) {
    return i18n.t('interaction.contextSheet.goalCapacityHint');
  }
  return lastReason;
}
