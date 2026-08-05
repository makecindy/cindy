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
/** 当前进程曾成功建立过 link 的控制端；短时断线 push 队列据此按设备隔离补发。 */
const knownControllerIds = new Set<string>();
/**
 * 普通断线会清掉 active registry，但保留最后明确持有的 topic，避免离线期间的
 * session push 被错误地补发给只订阅 sessions 或其它 session 的控制端。
 */
const rememberedTopicsByController = new Map<string, Set<StoredTopic>>();
/**
 * link-open/subscribe 协商出的能力也要跨普通断线保留。link-open 会先恢复
 * controller metadata、再等现代控制端 replay subscribe；这段窗口内不能把
 * 新控制端误判成 legacy，否则 set-model 的显式 provider null 会被当成占位。
 */
const rememberedCapabilitiesByController = new Map<string, Set<string>>();

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

function normalizeCapabilities(capabilities: readonly string[]): Set<string> {
  return new Set(capabilities.filter((value) => typeof value === 'string'));
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
  knownControllerIds.add(deviceId);
  const e = getOrCreate(deviceId, name);
  if (capabilities) {
    e.capabilities = normalizeCapabilities(capabilities);
    rememberedCapabilitiesByController.set(deviceId, new Set(e.capabilities));
  }
  for (const t of topics) e.topics.add(t as StoredTopic);
  // Remember the topic contract across ordinary disconnects, but not across explicit revocation.
  const remembered = rememberedTopicsByController.get(deviceId) ?? new Set<StoredTopic>();
  for (const t of topics) remembered.add(t as StoredTopic);
  rememberedTopicsByController.set(deviceId, remembered);
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
  if (capabilities) {
    const normalized = normalizeCapabilities(capabilities);
    rememberedCapabilitiesByController.set(deviceId, new Set(normalized));
    if (e) e.capabilities = normalized;
  }
  // Do not recreate a topic entry during link-open; modern controllers must still
  // replay subscribe before their remembered topics become active.
  if (e) e.name = name;
}

export function controllerHasTopic(deviceId: string, topic: string): boolean {
  return registry.get(deviceId)?.topics.has(topic as StoredTopic) === true;
}

/** 取消订阅指定 topics;该控制端 topic 清空后整条移除。空 topics 为 no-op。 */
export function unsubscribe(deviceId: string, topics: readonly string[]): void {
  const e = registry.get(deviceId);
  const remembered = rememberedTopicsByController.get(deviceId);
  if (!e && !remembered) return;
  if (e) {
    for (const t of topics) e.topics.delete(t as StoredTopic);
  }
  if (remembered) {
    for (const t of topics) remembered.delete(t as StoredTopic);
    if (remembered.size === 0) {
      rememberedTopicsByController.delete(deviceId);
      knownControllerIds.delete(deviceId);
    }
  }
  if (e?.topics.size === 0) registry.delete(deviceId);
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

/** 显式撤销/账号边界使用：释放 active topics，并删除断线恢复状态。 */
export function forgetKnownController(deviceId: string): void {
  clearController(deviceId);
  knownControllerIds.delete(deviceId);
  rememberedTopicsByController.delete(deviceId);
  rememberedCapabilitiesByController.delete(deviceId);
}

/** 清空所有订阅(登出 / 关被控 / 退出)。 */
export function clearAll(): void {
  const held = new Set<StoredTopic>();
  for (const e of registry.values()) for (const t of e.topics) held.add(t);
  registry.clear();
  knownControllerIds.clear();
  rememberedTopicsByController.clear();
  rememberedCapabilitiesByController.clear();
  held.delete(LEGACY_TOPIC);
  notifyReleased([...held]);
}

export function isEmpty(): boolean {
  return registry.size === 0;
}

/** 普通断线后是否仍有可用于离线队列精确路由的 remembered topic。 */
export function hasRememberedTopics(): boolean {
  return rememberedTopicsByController.size > 0;
}

/** 当前所有订阅控制端 deviceId(dropAllControllers 逐个 closeLink 用)。 */
export function getControllerIds(): string[] {
  return [...registry.keys()];
}

/** 当前进程曾成功建立 link 的控制端；登出/停服务时由 clearAll 一起清空。 */
export function getKnownControllerIds(): string[] {
  return [...knownControllerIds];
}

/** 断线前曾持有该 topic(或 legacy `'*'`)的控制端。 */
export function getKnownControllersForTopic(topic: Topic): string[] {
  const out: string[] = [];
  for (const [deviceId, topics] of rememberedTopicsByController) {
    if (topics.has(LEGACY_TOPIC) || topics.has(topic)) out.push(deviceId);
  }
  return out;
}

/** 该控制端曾切换到现代 topic 订阅协议(而非 legacy wildcard)。 */
export function hasRememberedModernTopics(deviceId: string): boolean {
  const topics = rememberedTopicsByController.get(deviceId);
  return topics !== undefined && [...topics].some((topic) => topic !== LEGACY_TOPIC);
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
  return registry.get(deviceId)?.capabilities.has(capability) === true
    || rememberedCapabilitiesByController.get(deviceId)?.has(capability) === true;
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
    knownControllerIds.clear();
    rememberedTopicsByController.clear();
    rememberedCapabilitiesByController.clear();
  },
  /** 测试用:查某控制端当前订阅的 topic 集合。 */
  topicsOf(deviceId: string): string[] {
    return [...(registry.get(deviceId)?.topics ?? [])];
  },
};
