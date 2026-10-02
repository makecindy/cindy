/**
 * subscriptionRefcount —— 控制端「device-link 订阅」的按窗口引用计数(纯数据结构)。
 * ---------------------------------------------------------------------------
 * 背景:控制端是多窗口的(「在新窗口打开」开副窗)。每个窗口的 renderer 各自镜像一份
 * remoteProjectsStore,都会调 `deviceLink.subscribe(deviceId, topics)`。但被控端的订阅
 * registry 只按 controllerDeviceId 记一份(不分窗口),控制端主进程→relay 的订阅也只有
 * 一条逻辑通道。若某个窗口关闭时直接向 relay 发 unsubscribe,会把其它窗口还在用的订阅
 * 一起拆掉,弄断它们的实时推送。
 *
 * 本模块在控制端主进程按 (deviceId, topic) 记录「哪些窗口正在用」:
 *  - subscribe:**总是转发**(幂等;兼容被控端重启 / WS 重连重订阅),只额外记一笔引用。
 *  - unsubscribe:只有当某 topic 的引用降到 0(最后一个窗口释放)才真正向 relay 发 unsubscribe。
 *  - 窗口销毁(webContents 'destroyed'):释放该窗口持有的所有引用,聚合出降零 topics。
 *
 * 纯模块级 Map,无 Electron / client 依赖,可单测。forward 动作(remoteSubscribe /
 * remoteUnsubscribe)由 ipc.ts 持有 deps 后驱动。windowId = WebContents.id。
 */

/** deviceId → topic → 持有该订阅的窗口集合。 */
const registry = new Map<string, Map<string, Set<number>>>();

/**
 * 记录一个窗口对 (deviceId, topics) 的订阅意图。返回需要向 relay 转发的 topics ——
 * subscribe 幂等,**恒为传入的全部 topics**(去重),调用方据此转发 remoteSubscribe。
 */
export function recordSubscribe(
  windowId: number,
  deviceId: string,
  topics: readonly string[],
): string[] {
  let byTopic = registry.get(deviceId);
  if (!byTopic) {
    byTopic = new Map();
    registry.set(deviceId, byTopic);
  }
  const forwarded = new Set<string>();
  for (const t of topics) {
    let set = byTopic.get(t);
    if (!set) {
      set = new Set();
      byTopic.set(t, set);
    }
    set.add(windowId);
    forwarded.add(t);
  }
  return [...forwarded];
}

/**
 * 释放一个窗口对 (deviceId, topics) 的订阅。返回**引用降到 0**的 topics —— 只有这些才
 * 真正需要向 relay 发 unsubscribe。从未记录过的 topic 视作降零返回(保持「总转发」的幂等
 * 语义,对被控端无害)。
 */
export function recordUnsubscribe(
  windowId: number,
  deviceId: string,
  topics: readonly string[],
): string[] {
  const byTopic = registry.get(deviceId);
  const zeroed: string[] = [];
  for (const t of topics) {
    const set = byTopic?.get(t);
    if (set) {
      set.delete(windowId);
      if (set.size === 0) {
        byTopic!.delete(t);
        zeroed.push(t);
      }
    } else {
      zeroed.push(t); // 从未记录 → 视作降零(幂等转发)
    }
  }
  if (byTopic && byTopic.size === 0) registry.delete(deviceId);
  return zeroed;
}

/**
 * 窗口销毁:释放该窗口持有的所有 (deviceId, topic) 引用,按 deviceId 聚合返回降零 topics。
 * 调用方对每条 { deviceId, topics } 转发 remoteUnsubscribe。
 */
export function recordWindowGone(windowId: number): Array<{ deviceId: string; topics: string[] }> {
  const out: Array<{ deviceId: string; topics: string[] }> = [];
  for (const [deviceId, byTopic] of registry) {
    const zeroed: string[] = [];
    for (const [t, set] of byTopic) {
      if (set.delete(windowId) && set.size === 0) {
        byTopic.delete(t);
        zeroed.push(t);
      }
    }
    if (zeroed.length > 0) out.push({ deviceId, topics: zeroed });
    if (byTopic.size === 0) registry.delete(deviceId);
  }
  return out;
}

/** 清空所有引用(WS 整体断开 / 登出 / disconnectAll)。 */
export function resetAll(): void {
  registry.clear();
}

/** 清空某个目标设备的所有订阅引用(本机主动关闭控制该设备 / link 已整体关闭)。 */
export function resetDevice(deviceId: string): void {
  registry.delete(deviceId);
}

/**
 * Snapshot current logical subscriptions for replay after relay reconnect or
 * peer presence recovery. The returned topics are de-duplicated by construction.
 */
export function snapshotSubscriptions(deviceId?: string): Array<{ deviceId: string; topics: string[] }> {
  const out: Array<{ deviceId: string; topics: string[] }> = [];
  for (const [id, byTopic] of registry) {
    if (deviceId && id !== deviceId) continue;
    const topics = [...byTopic.keys()];
    if (topics.length > 0) out.push({ deviceId: id, topics });
  }
  return out;
}

export const __testing = {
  reset: resetAll,
  /** 测试用:查某 (deviceId, topic) 当前持有窗口数。 */
  refCount(deviceId: string, topic: string): number {
    return registry.get(deviceId)?.get(topic)?.size ?? 0;
  },
  snapshotSubscriptions,
};
