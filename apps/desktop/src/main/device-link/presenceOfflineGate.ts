/**
 * presenceOfflineGate.ts — 发送门禁用的「presence 显式离线」判据(纯逻辑,可单测)。
 * ---------------------------------------------------------------------------
 * 订阅重放 fan-out 与 invoke-result outbox 全量 flush 用它跳过注定弹回
 * DEVICE_OFFLINE 的盲发(2026-08-08 线上:单日 369 条 relay-error,叠进当晚的
 * relay 聚合背压)。
 *
 * 为什么不能只查当代 presence 视图:presence 是增量广播,视图只在连接代内有效,
 * 一进入非 online 就整体清空;而 relay 重连的时序是「connecting(清空)→ online
 * → 立刻 ws-online 全量重放」——重放跑在本代首帧 presence 到达**之前**,只查当代
 * 视图的判据必然返回 false,门禁在这条(恰是盲发主路径)上形同虚设。本模块在
 * 清空时转存已知的 offline 结论,让门禁在「当代还不知道」的窗口里沿用上一代事实。
 *
 * 不变量:
 * 1. **当代优先**:当代视图有该设备就只看当代;跨代事实仅在当代未知时兜底。
 * 2. **fail-open**:从未观察到离线的设备一律放行——恢复窗口的首发不能被拦死,
 *    收敛交给既有事件(重试前置门 / presence 翻转重放 / link-open 定向 flush)。
 * 3. **单帧让位**:收到该设备任一 presence 帧(无论 online / offline)即丢弃跨代
 *    结论,判据改由当代视图回答。
 * 4. **链路作用域**:reset()(登出 / 失去持有权)整体清空,不串到下一段链路或账号。
 */

export interface PresenceOfflineGate {
  /** 门禁判据:是否**明确**已知该设备离线(当代事实优先,跨代事实兜底)。 */
  isExplicitlyOffline(deviceId: string): boolean;
  /**
   * 连接代次结束(status 进入非 online、当代视图即将清空)时调用:转存本代已知的
   * offline 结论。只存 offline——online 的设备本就该放行,陈旧的 online 无门禁价值。
   */
  carryOverGenerationEnd(currentOnlineView: Iterable<readonly [string, boolean]>): void;
  /** 收到该设备的权威 presence 帧:跨代结论让位给当代事实。 */
  observePresence(deviceId: string): void;
  /** 链路 / 账号翻篇:清空跨代事实。 */
  reset(): void;
  /** 只读:当前保留的跨代离线设备数(供测试与诊断)。 */
  carriedOverCount(): number;
}

/**
 * @param getCurrentOnline 读当代 presence 在线视图;返回 undefined = 当代未知。
 *   刻意用注入而非自持:当代视图在 index.ts 有其它消费方(词典同步对端选择、
 *   getState 投影),必须保持单一真相,本模块只叠加跨代层。
 */
export function createPresenceOfflineGate(
  getCurrentOnline: (deviceId: string) => boolean | undefined,
): PresenceOfflineGate {
  const carriedOverOffline = new Set<string>();

  return {
    isExplicitlyOffline(deviceId: string): boolean {
      const current = getCurrentOnline(deviceId);
      if (current !== undefined) return current === false;
      return carriedOverOffline.has(deviceId);
    },

    carryOverGenerationEnd(currentOnlineView): void {
      for (const [deviceId, online] of currentOnlineView) {
        if (!online) carriedOverOffline.add(deviceId);
      }
    },

    observePresence(deviceId: string): void {
      carriedOverOffline.delete(deviceId);
    },

    reset(): void {
      carriedOverOffline.clear();
    },

    carriedOverCount(): number {
      return carriedOverOffline.size;
    },
  };
}
