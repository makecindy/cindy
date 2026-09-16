/**
 * statusBarCards —— 底栏状态卡片（货币 chip 的「用量明细」卡、任务窗口 chip 的档位卡）的
 * **互斥**协调器：同一时刻只允许展开一张。打开一张会立刻请求另一张关闭 —— 用户要求
 * 「该窗体为唯一窗体，显示 ¥ 的窗体就不要显示 [] 的，反之亦然」。
 *
 * 悬浮卡的节奏（打开延迟 / 离开宽限）也放在这里：两张卡必须是同一套手感，
 * 各写一份数字必然漂移（`TodaySpendChip` 的 `QUOTA_POPOVER_*` 与本模块取值一致）。
 */

/** 悬浮后延迟这么久才展开（与用量卡一致）：扫过去不该弹卡。 */
export const STATUS_CARD_HOVER_OPEN_DELAY_MS = 300;
/** 指针离开后的宽限：够移到卡片上，不至于闪一下就没。 */
export const STATUS_CARD_HOVER_CLOSE_GRACE_MS = 200;

export type StatusBarCardId = 'quota' | 'context-window';

const closeHandlers = new Map<StatusBarCardId, () => void>();
let activeCard: StatusBarCardId | null = null;

/** 注册某张卡片的「立刻关闭」入口；返回反注册函数（组件卸载时调用）。 */
export function registerStatusBarCard(id: StatusBarCardId, close: () => void): () => void {
  closeHandlers.set(id, close);
  return () => {
    if (closeHandlers.get(id) === close) closeHandlers.delete(id);
    if (activeCard === id) activeCard = null;
  };
}

/** 声明自己成为当前展开的卡片：其它卡片立刻关闭。 */
export function requestStatusBarCard(id: StatusBarCardId): void {
  if (activeCard === id) return;
  activeCard = id;
  for (const [otherId, close] of [...closeHandlers]) {
    if (otherId !== id) close();
  }
}

/** 自己收起时让出「当前卡片」位置（不然后续 request 会误判成"已经是我"）。 */
export function releaseStatusBarCard(id: StatusBarCardId): void {
  if (activeCard === id) activeCard = null;
}

/** 仅供测试：清掉跨用例的注册状态。 */
export function resetStatusBarCardsForTest(): void {
  closeHandlers.clear();
  activeCard = null;
}
