/**
 * remoteMcpBridgeToken — SSH 远端常驻 codex daemon 直连本机 MCP bridge 用的
 * persistent bearer token 的惰性生成与缓存。
 *
 * 为什么需要它:bridge 主 token 是 per-run 随机(codexHttpBridge 启动时生成),
 * 经 LIZI_MCP_TOKEN env 给本地 codex 子进程——子进程不常驻,每次 spawn 拿当前
 * 值即可。远端 daemon 是常驻进程,env 在其 bootstrap 时固定;若 token 随 app
 * 重启轮换,旧 daemon 的全部 MCP 请求会 401 且无法自愈。因此远端场景单独使用
 * 一个落 safeStorage 的 persistent token,bridge 同时接受两类 token。
 *
 * safeStorage 不可用(如无 keychain 的 Linux)时返回 null:remote MCP 注入链路
 * 据此降级为不注入(记 warn),不影响本地 codex。
 */

import { randomBytes } from 'node:crypto';

import {
  addProviderSecretsClearedListener,
  readRemoteMcpBridgeToken,
  writeRemoteMcpBridgeToken,
} from '../secrets/providerSecretStore.js';

let cached: string | null | undefined;
let clearListenerRegistered = false;
let unregisterClearListener: (() => void) | null = null;

/**
 * token 轮换 (secrets 清空后重新生成) 时的宿主钩子 (maker-host 注入):
 * 远端 CC query 的 Authorization header 是注入时的旧 token 快照 — 不主动
 * 失效的话, 旧 query 在新 bridge 上持续 401 直到用户手动重启
 * (codex-connector R24 P2)。独立于 shutdownCodexEnvironment 路径 —
 * 账号切换在本地 codex turn 忙时会跳过 shutdown, 本钩子照样生效。
 * mcp-integrations 不反向依赖 maker-host, setter 注入解耦。
 */
let tokenRotatedHook: (() => void) | null = null;

export function setRemoteMcpBridgeTokenRotatedHook(fn: (() => void) | null): void {
  tokenRotatedHook = fn;
}

/**
 * 账号切换 clearAll 删除 safeStorage 后,进程内缓存必须一并失效——否则旧账号
 * 远端 daemon env 里的 token 在当前进程内仍可通过 bridge 鉴权(串号)。惰性
 * 注册:模块 import 不触碰全局 listener,首次取 token 时才挂上。
 */
function ensureClearListener(): void {
  if (clearListenerRegistered) return;
  clearListenerRegistered = true;
  unregisterClearListener = addProviderSecretsClearedListener(() => {
    cached = undefined;
    try {
      tokenRotatedHook?.();
    } catch {
      /* 失效失败不阻断 secrets 清理主流程 */
    }
  });
}

/** 读取或首次生成 persistent token;进程内缓存,safeStorage 不可用时返回 null。 */
export function getRemoteMcpBridgeToken(): string | null {
  ensureClearListener();
  if (cached !== undefined) return cached;
  const existing = readRemoteMcpBridgeToken();
  if (existing) {
    cached = existing;
    return existing;
  }
  const created = randomBytes(32).toString('hex');
  cached = writeRemoteMcpBridgeToken(created) ? created : null;
  return cached;
}

/** 测试专用:清进程内缓存并复位监听注册(不动 safeStorage 里的值)。 */
export function resetRemoteMcpBridgeTokenCacheForTests(): void {
  cached = undefined;
  unregisterClearListener?.();
  unregisterClearListener = null;
  clearListenerRegistered = false;
}
