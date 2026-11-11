/**
 * feishu/moduleScope.ts
 * ---------------------------------------------------------------------------
 * 飞书传输层的「实例作用域」。
 *
 * 这个包的各模块(wsClient / outbound / storage / ownerGuard / dualDelivery / ipc)
 * 历史上都是模块级单例。为了让同一进程里能跑多份飞书 bot(设置页那份 + 伙伴自有的
 * 若干份), 模块状态改成按 FeishuScope 存放(见 scopeSlot), 代码里的函数签名不变:
 *
 *   - 每个 FeishuIM 实例持有一个 FeishuScope; 它的所有公开方法都在
 *     `runInScope(scope, …)` 里执行, 内部的 await / 定时器 / Promise 链靠
 *     AsyncLocalStorage 自动带着作用域;
 *   - Lark SDK 的回调(WebSocket 事件、就绪 / 错误信号)在注册时用 bindScope 显式绑定;
 *   - 没有作用域的调用(设置页 IPC、单测直接调模块函数)落在默认作用域上 ——
 *     默认作用域 = 第一个不带 secretKeyPrefix 创建的 FeishuIM(设置页那份)。
 *
 * `setHost / getHost / getLog` 保留原名, 现在都是对当前作用域的读写。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { IMHost } from '../types.js';
import { defaultLogger, type Logger } from '../logger.js';
import { FeishuEventBus } from './events.js';

export interface FeishuScopeOptions {
  host: IMHost | null;
  log?: Logger;
  /** host.secrets 键名前缀(伙伴自有连接按连接 id 隔离; 设置页那份为空)。 */
  secretKeyPrefix?: string;
  /** 是否注册 `feishuBot:*` 设置卡 IPC 并广播状态(只有设置页那份为 true)。 */
  ipc?: boolean;
  /** 对外开放: 非主人的私聊与群 @ 进业务层(带非主人标记), 命令仍只认主人。 */
  guests?: boolean;
  /** Runtime ownership is independent of the owner's saved announcement preference. */
  shouldAnnounceLifecycle?: () => boolean;
}

export interface FeishuScope {
  host: IMHost | null;
  log: Logger;
  readonly secretKeyPrefix: string;
  readonly ipc: boolean;
  readonly guests: boolean;
  readonly shouldAnnounceLifecycle?: () => boolean;
  readonly events: FeishuEventBus;
  /** 各模块的实例状态(scopeSlot 按 symbol 懒建)。 */
  readonly slots: Map<symbol, unknown>;
}

const als = new AsyncLocalStorage<FeishuScope>();
let defaultScope: FeishuScope | null = null;

export function createFeishuScope(options: FeishuScopeOptions): FeishuScope {
  return {
    host: options.host,
    log: options.log ?? defaultLogger('im:feishu'),
    secretKeyPrefix: options.secretKeyPrefix ?? '',
    ipc: options.ipc !== false,
    guests: options.guests === true,
    shouldAnnounceLifecycle: options.shouldAnnounceLifecycle,
    events: new FeishuEventBus(),
    slots: new Map(),
  };
}

/** 把一个作用域登记为默认作用域(设置页那份 FeishuIM 在构造时调用)。 */
export function registerDefaultScope(scope: FeishuScope): void {
  defaultScope = scope;
}

/** 当前作用域: AsyncLocalStorage 里的那份, 否则默认作用域(没有就惰性建一个空壳)。 */
export function getScope(): FeishuScope {
  const active = als.getStore();
  if (active) return active;
  if (!defaultScope) defaultScope = createFeishuScope({ host: null });
  return defaultScope;
}

export function runInScope<T>(scope: FeishuScope, fn: () => T): T {
  return als.run(scope, fn);
}

/** 把回调绑定到某个作用域(Lark SDK 回调、IPC handler 这类从外部进来的入口)。 */
export function bindScope<A extends unknown[], R>(
  scope: FeishuScope,
  fn: (...args: A) => R,
): (...args: A) => R {
  return (...args: A) => als.run(scope, () => fn(...args));
}

/** 某个模块在当前作用域里的状态, 第一次访问时按 create 建。 */
export function scopeSlot<T>(key: symbol, create: () => T): T {
  const scope = getScope();
  const existing = scope.slots.get(key);
  if (existing !== undefined) return existing as T;
  const created = create();
  scope.slots.set(key, created);
  return created;
}

/** 兼容入口: 设置当前(默认)作用域的 host 与 logger。 */
export function setHost(host: IMHost, log: Logger): void {
  const scope = getScope();
  scope.host = host;
  scope.log = log;
}

export function getHost(): IMHost {
  const host = getScope().host;
  if (!host) {
    throw new Error('FeishuIM not initialized — call createFeishuIM(host) first');
  }
  return host;
}

export function getLog(): Logger {
  return getScope().log;
}

export function makeScopedLogger(scope: string): Logger {
  const host = getScope().host;
  return host?.createLogger?.(`im:feishu:${scope}`) ?? defaultLogger(`im:feishu:${scope}`);
}
