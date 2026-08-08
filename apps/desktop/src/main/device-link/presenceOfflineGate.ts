/**
 * presenceOfflineGate.ts — 发送门禁用的「已知离线」判据(纯逻辑,可单测)。
 * ---------------------------------------------------------------------------
 * 订阅重放 fan-out 与 invoke-result outbox 全量 flush 用它跳过注定弹回
 * DEVICE_OFFLINE 的盲发(2026-08-08 线上:单日 369 条 relay-error,叠进当晚的
 * relay 聚合背压)。
 *
 * 门禁要回答的问题只有一个:**现在往这台设备发帧,relay 能不能路由到?**
 * 因此判据不是「presence 状态机怎么说」,而是按证据的新鲜度排优先级(review 三轮
 * 收敛的结论,每一层都由一次真实缺陷推出来):
 *
 *   1. **入站可达证据**(最新的因果证据,最高优先)——刚收到来自它的帧,说明帧
 *      发出时对端活着、relay 到它的路由是通的。这比任何**早于该帧**的 presence
 *      结论都新,因此覆盖当代 presence 的 false:presence 滞后或误报持续时,旧的
 *      false 会一直挡住一个明显可达的 peer(定向 flush 首轮失败后的无参重试、
 *      订阅重放都被拦,直到 TTL 丢结果)。任何**新的** presence 帧到达即让位——
 *      presence 是持续状态源,以最新一帧为准,可达证据不做永久豁免。
 *   2. **当代 presence 值**——本连接代内的权威状态。
 *   3. **跨代离线结论**(当代未知时兜底)——presence 是增量广播,视图只在连接代
 *      内有效、一进入非 online 就整体清空;而 relay 重连的时序是「connecting
 *      (清空)→ online → 立刻 ws-online 全量重放」,重放跑在本代首帧 presence
 *      **之前**。不保留上一代的 offline 结论,门禁在这条(恰是盲发主路径)上
 *      形同虚设。
 *   4. 以上都没有 → **fail-open**。门禁是减量优化、不是安全边界:宁可多发几帧,
 *      不可长期挡住恢复或漏投在途结果。
 *
 * 其它不变量:
 * - **连接代次边界**:代次结束时,入站可达证据随旧连接失效(新连接的路由状态全新)
 *   而清空;当代已知 offline 的设备转存为跨代结论,但**被可达证据覆盖过的不转存**
 *   ——那一代对它的最终判断是「可达」,转存成 offline 会自相矛盾。
 * - **链路作用域**:reset()(登出 / 失去持有权)整体清空,不串到下一段链路或账号。
 */

export interface PresenceOfflineGate {
  /** 门禁判据:是否**明确**已知该设备当前发不过去(优先级链见文件头)。 */
  isExplicitlyOffline(deviceId: string): boolean;
  /**
   * 连接代次结束(status 进入非 online、当代视图即将清空)时调用:转存本代已知的
   * offline 结论,并丢弃随旧连接失效的入站可达证据。只存 offline——online 的设备
   * 本就该放行,陈旧的 online 无门禁价值。
   */
  carryOverGenerationEnd(currentOnlineView: Iterable<readonly [string, boolean]>): void;
  /**
   * 收到来自该设备的入站帧(link-open / invoke / push 任一):记为本代最新的可达
   * 证据。热路径调用,实现保持 O(1) 且无分配。
   */
  observeReachable(deviceId: string): void;
  /**
   * 收到该设备的权威 presence 帧:清掉早于本帧的可达证据与跨代结论,判据交回
   * 当代 presence 值(调用方负责先把本帧写入当代视图)。
   */
  observePresenceFrame(deviceId: string): void;
  /** 链路 / 账号翻篇:清空全部本地证据。 */
  reset(): void;
  /** 只读:当前保留的跨代离线结论数(供测试与诊断)。 */
  carriedOverCount(): number;
  /** 只读:当前持有入站可达证据的设备数(供测试与诊断)。 */
  reachableCount(): number;
}

/**
 * @param getCurrentOnline 读当代 presence 在线视图;返回 undefined = 当代未知。
 *   刻意用注入而非自持:当代视图在 index.ts 有其它消费方(词典同步对端选择、
 *   getState 投影),必须保持单一真相,本模块只叠加证据层。
 */
export function createPresenceOfflineGate(
  getCurrentOnline: (deviceId: string) => boolean | undefined,
): PresenceOfflineGate {
  /** 本代收到过入站帧的设备(最新因果证据,覆盖当代 presence)。 */
  const reachableThisGeneration = new Set<string>();
  /** 上一代明确为 offline 的设备(当代未知时兜底)。 */
  const carriedOverOffline = new Set<string>();

  return {
    isExplicitlyOffline(deviceId: string): boolean {
      if (reachableThisGeneration.has(deviceId)) return false;
      const current = getCurrentOnline(deviceId);
      if (current !== undefined) return current === false;
      return carriedOverOffline.has(deviceId);
    },

    carryOverGenerationEnd(currentOnlineView): void {
      for (const [deviceId, online] of currentOnlineView) {
        // 被可达证据覆盖过的设备不转存:本代对它的最终判断是「可达」。
        if (!online && !reachableThisGeneration.has(deviceId)) {
          carriedOverOffline.add(deviceId);
        }
      }
      reachableThisGeneration.clear();
    },

    observeReachable(deviceId: string): void {
      reachableThisGeneration.add(deviceId);
      if (carriedOverOffline.size > 0) carriedOverOffline.delete(deviceId);
    },

    observePresenceFrame(deviceId: string): void {
      reachableThisGeneration.delete(deviceId);
      carriedOverOffline.delete(deviceId);
    },

    reset(): void {
      reachableThisGeneration.clear();
      carriedOverOffline.clear();
    },

    carriedOverCount(): number {
      return carriedOverOffline.size;
    },

    reachableCount(): number {
      return reachableThisGeneration.size;
    },
  };
}
