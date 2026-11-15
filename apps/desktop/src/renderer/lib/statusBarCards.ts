/**
 * statusBarCards —— 底栏状态卡片（货币 chip 的「用量明细」卡、任务窗口 chip 的档位卡）的
 * **互斥**协调器：同一时刻只允许展开一张。打开一张会立刻请求另一张关闭 —— 用户要求
 * 「该窗体为唯一窗体，显示 ¥ 的窗体就不要显示 [] 的，反之亦然」。
 *
 * 悬浮卡的节奏（打开延迟 / 离开宽限）也放在这里：两张卡必须是同一套手感，
 * 各写一份数字必然漂移（`TodaySpendChip` 的 `QUOTA_POPOVER_*` 与本模块取值一致）。
 *
 * **登记单位是「实例」而不是「卡片种类」**：分屏 / Orca 面板会同时挂载多个会话视图，
 * 于是同一种卡片可能同时存在两份（两个 chip 各有自己的 `open` state）。若只按种类登记，
 * 后挂载的那份会覆盖先挂载那份的关闭回调，且「种类已经是当前」会让第二份跳过关闭动作，
 * 两张卡就会一起亮着。所以句柄持有 token，`request()` 认的是「我这个实例」。
 */

/** 悬浮后延迟这么久才展开（与用量卡一致）：扫过去不该弹卡。 */
export const STATUS_CARD_HOVER_OPEN_DELAY_MS = 300;
/** 指针离开后的宽限：够移到卡片上，不至于闪一下就没。 */
export const STATUS_CARD_HOVER_CLOSE_GRACE_MS = 200;

export type StatusBarCardId = 'quota' | 'context-window';

/** 一个卡片实例的协调句柄（由 `registerStatusBarCard` 返回）。 */
export type StatusBarCardHandle = {
  /** 声明本实例成为当前展开的卡片：其它实例（含同种类的另一张）立刻关闭。 */
  request: () => void;
  /** 本实例收起时让出「当前卡片」位置（不然后续 request 会误判成"已经是我"）。 */
  release: () => void;
  /** 本实例卸载：注销登记（若自己是当前卡片，位置一并让出）。 */
  unregister: () => void;
};

const registrations = new Map<symbol, { id: StatusBarCardId; close: () => void }>();
let activeToken: symbol | null = null;

/** 注册某张卡片实例的「立刻关闭」入口；返回句柄（卸载时调用 `unregister`）。 */
export function registerStatusBarCard(id: StatusBarCardId, close: () => void): StatusBarCardHandle {
  const token = Symbol(id);
  registrations.set(token, { id, close });
  // 注销后的句柄不再有任何协调权限：卸载路径可能把清理排在下一次 request 之后执行，
  // 已销毁的实例不该再抢独占位、也不该再把别人关掉。
  let registered = true;
  return {
    request() {
      if (!registered) return;
      if (activeToken === token) return;
      activeToken = token;
      // 关掉所有**其它实例**：包括同种类的另一张（分屏场景），这是本协调器的全部意义。
      for (const [otherToken, entry] of [...registrations]) {
        if (otherToken !== token) entry.close();
      }
    },
    release() {
      if (!registered) return;
      if (activeToken === token) activeToken = null;
    },
    unregister() {
      registered = false;
      registrations.delete(token);
      if (activeToken === token) activeToken = null;
    },
  };
}

/** 仅供测试：清掉跨用例的注册状态。 */
export function resetStatusBarCardsForTest(): void {
  registrations.clear();
  activeToken = null;
}
