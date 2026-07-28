/**
 * subscriptions —— 被控端「控制端订阅 registry」(device-link push 驱动核心)。
 * ---------------------------------------------------------------------------
 * 远程控制改为「被控端单一真相 + 控制端纯镜像」后,被控端按 **topic** 把本机广播
 * scoped 转发给订阅了该 topic 的控制端(见 @cindy/device-link 的 topics.ts):
 *   - `sessions`(轻):会话列表读模型变更 —— 侧边栏订阅,**不**触发被控横幅。
 *   - `session:<id>`(重):单会话实时流 —— 打开会话才订阅,**触发**被控横幅(活跃控制)。
 *   - `'*'`(legacy):老控制端走 link-open(无 subscribe 能力)→ 视作订阅「全部」,
 *     等价旧的「全量转发 + 横幅」行为,保证新被控端不饿死老控制端。
 *
 * 本模块是**纯数据结构**(模块级 Map,无 client / Electron 依赖,可单测);转发动作
 * (client.sendPush)与 tap listener 生命周期由 dispatch.ts 持有 client 后驱动。
 * controllerDeviceId 由 server 填的 `env.src` 提供(防伪造)。
 */

import type { Topic } from '@cindy/device-link';

/** legacy 老控制端(link-open)订阅的「全部」topic 标记。 */
export const LEGACY_TOPIC = '*';

type StoredTopic = Topic | typeof LEGACY_TOPIC;

interface ControllerEntry {
  /** 友好名(横幅展示用),来自 link-open / subscribe 的 controllerName。 */
  name: string;
  topics: Set<StoredTopic>;
  /** link-open 声明的 append-only 控制端能力；旧控制端缺省为空集。 */
  capabilities: Set<string>;
}

/** 控制本机的控制端信息(被控端可见性状态条用)。 */
export interface ActiveController {
  deviceId: string;
  name: string;
}

const registry = new Map<string, ControllerEntry>();

/**
 * topic 生命周期监听(fs-watch 档消费:订阅驱动被控端文件 watch 启停)。
 * 放在数据层触发的原因:订阅的增减入口有四条(subscribe / unsubscribe /
 * clearController / clearAll),在每个入口旁路挂钩容易漏;数据层统一触发,
 * 断链清理(link-close / presence-offline / dropAll)天然覆盖。
 * listener 是可选的纯回调,不注册时零开销;抛错不冒泡(订阅簿记优先)。
 */
type TopicsListener = (topics: readonly string[]) => void;
let topicsSubscribedListener: TopicsListener | null = null;
let topicsReleasedListener: TopicsListener | null = null;

export function setTopicsSubscribedListener(cb: TopicsListener | null): void {
  topicsSubscribedListener = cb;
}

export function setTopicsReleasedListener(cb: TopicsListener | null): void {
  topicsReleasedListener = cb;
}

function notifySubscribed(topics: readonly string[]): void {
  if (!topicsSubscribedListener || topics.length === 0) return;
  try {
    topicsSubscribedListener(topics);
  } catch {
    // 消费方自己 log;簿记不受影响
  }
}

function notifyReleased(topics: readonly string[]): void {
  if (!topicsReleasedListener || topics.length === 0) return;
  try {
    topicsReleasedListener(topics);
  } catch {
    // 同上
  }
}

/** registry 里是否还有任何控制端持有该 topic(legacy '*' 不算——它只覆盖转发,不驱动 watch)。 */
function topicStillHeld(topic: StoredTopic): boolean {
  for (const e of registry.values()) {
    if (e.topics.has(topic)) return true;
  }
  return false;
}

function getOrCreate(deviceId: string, name?: string): ControllerEntry {
  let e = registry.get(deviceId);
  if (!e) {
    e = {
      name: name ?? deviceId.slice(0, 8),
      topics: new Set(),
      capabilities: new Set(),
    };
    registry.set(deviceId, e);
  } else if (name) {
    e.name = name;
  }
  return e;
}

/** 订阅:把 topics 并入该控制端(name 可选,subscribe/link-open 携带时更新)。 */
export function subscribe(
  deviceId: string,
  topics: readonly string[],
  name?: string,
  capabilities?: readonly string[],
): void {
  // Empty/fully-filtered subscribe frames must not create a phantom remote viewer.
  if (topics.length === 0) return;
  const e = getOrCreate(deviceId, name);
  if (capabilities) {
    e.capabilities = new Set(capabilities.filter((value) => typeof value === 'string'));
  }
  for (const t of topics) e.topics.add(t as StoredTopic);
  // 幂等重放也通知(控制端断链重连后 replay subscribe → 消费方按幂等语义恢复 watch)。
  notifySubscribed(topics);
}

/** 更新已有控制端元数据；不为尚无 topic 的连接创建 phantom registry entry。 */
export function updateControllerMetadata(
  deviceId: string,
  name: string,
  capabilities?: readonly string[],
): void {
  const e = registry.get(deviceId);
  if (!e) return;
  e.name = name;
  if (capabilities) {
    e.capabilities = new Set(capabilities.filter((value) => typeof value === 'string'));
  }
}

/** 取消订阅指定 topics;该控制端 topic 清空后整条移除。空 topics 为 no-op。 */
export function unsubscribe(deviceId: string, topics: readonly string[]): void {
  const e = registry.get(deviceId);
  if (!e) return;
  for (const t of topics) e.topics.delete(t as StoredTopic);
  if (e.topics.size === 0) registry.delete(deviceId);
  notifyReleased(topics.filter((t) => !topicStillHeld(t as StoredTopic)));
}

/** 整条移除某控制端(link-close / presence-offline 兜底)。返回是否确实移除。 */
export function clearController(deviceId: string): boolean {
  const e = registry.get(deviceId);
  if (!e) return false;
  const held = [...e.topics];
  registry.delete(deviceId);
  notifyReleased(held.filter((t) => t !== LEGACY_TOPIC && !topicStillHeld(t)));
  return true;
}

/** 清空所有订阅(登出 / 关被控 / 退出)。 */
export function clearAll(): void {
  const held = new Set<StoredTopic>();
  for (const e of registry.values()) for (const t of e.topics) held.add(t);
  registry.clear();
  held.delete(LEGACY_TOPIC);
  notifyReleased([...held]);
}

export function isEmpty(): boolean {
  return registry.size === 0;
}

/** 当前所有订阅控制端 deviceId(dropAllControllers 逐个 closeLink 用)。 */
export function getControllerIds(): string[] {
  return [...registry.keys()];
}

/** 持有该 topic(或 legacy `'*'`)的控制端 deviceId 列表 —— topic-scoped fan-out 依据。 */
export function getControllersForTopic(topic: Topic): string[] {
  const out: string[] = [];
  for (const [id, e] of registry) {
    if (e.topics.has(LEGACY_TOPIC) || e.topics.has(topic)) out.push(id);
  }
  return out;
}

/** 查询 link-open 协商出的控制端能力；未知/已断链控制端一律 false。 */
export function controllerSupports(deviceId: string, capability: string): boolean {
  return registry.get(deviceId)?.capabilities.has(capability) === true;
}

function isControlTopic(t: StoredTopic): boolean {
  return t === LEGACY_TOPIC || t.startsWith('session:');
}

function collectControllers(matches: (topic: StoredTopic) => boolean): ActiveController[] {
  const out: ActiveController[] = [];
  for (const [id, e] of registry) {
    for (const t of e.topics) {
      if (matches(t)) {
        out.push({ deviceId: id, name: e.name });
        break;
      }
    }
  }
  return out;
}

/** 持有具体 session 或 legacy `'*'` 的控制端；只用于被控横幅与 `controlledBy`。 */
export function getControlControllers(): ActiveController[] {
  return collectControllers(isControlTopic);
}

/**
 * 会阻止无人值守更新重启的远程活动。
 * `fs-watch` 虽不触发被控横幅，但代表有人正在实时浏览文件树，重启仍应延后。
 */
export function getUpdateRelaunchControllers(): ActiveController[] {
  return collectControllers((topic) => isControlTopic(topic) || topic.startsWith('fs-watch:'));
}

export const __testing = {
  reset(): void {
    registry.clear();
  },
  /** 测试用:查某控制端当前订阅的 topic 集合。 */
  topicsOf(deviceId: string): string[] {
    return [...(registry.get(deviceId)?.topics ?? [])];
  },
};
