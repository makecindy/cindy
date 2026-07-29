/**
 * ssh-host-prefs-store —— 每台 SSH 远端机器的本地偏好(autoConnect + agentProxy)。
 *
 * 设计上跟 ~/.ssh/config 解耦: 不污染用户的 ssh config (那是 ssh 客户端通用配置),
 * 用一个独立 JSON 落 <userData>/ssh-host-prefs.json. 数据极小, 同步 R/W + 内存
 * cache, 跟 codex-auth-mode-store / memory-settings-store 同套路。
 *
 * Schema:
 *   {
 *     "<hostId>": {
 *       "autoConnect": true,
 *       "agentProxy": { "enabled": true, "localHost": "127.0.0.1", "localPort": 7890 }
 *     },
 *     ...
 *   }
 *
 * 缺失 host 默认 autoConnect=false (启动不自动连, 新建对话不显远程项目入口)、
 * agentProxy=未开启。这样老用户升级零破坏 —— 没有 prefs 文件就当所有 host 都没勾。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger.js';

const log = createLogger('ssh-host-prefs-store');

/**
 * Agent 流量经 SSH 隧道走本地 Proxy 的 per-host 配置。
 * Cindy 不提供 Proxy, 只建隧道: 远端 127.0.0.1:<forwardPort> → 本地
 * localHost:localPort (用户自己的 Proxy, 如 Clash 的 7890 混合端口)。
 */
export interface SshHostAgentProxyPref {
  enabled: boolean;
  localHost: string;
  localPort: number;
}

export interface SshHostPref {
  autoConnect: boolean;
  agentProxy?: SshHostAgentProxyPref;
}

export type SshHostPrefs = Record<string, SshHostPref>;

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'ssh-host-prefs.json');
}

function normalizeAgentProxy(raw: unknown): SshHostAgentProxyPref | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const localHost = typeof v.localHost === 'string' ? v.localHost.trim() : '';
  const localPort = typeof v.localPort === 'number' ? v.localPort : NaN;
  // 引号与空白同样拒 (与 IPC normalizeAgentProxyInput / renderer 校验对齐,
  // review: PR #715 copilot R8): 手编 prefs 的脏值不应在启动时被恢复成
  // 可用 pref, 然后晚到 net.connect 才以难懂的方式失败。
  if (!localHost || /\s/.test(localHost) || localHost.includes("'") || localHost.includes('"')) {
    return undefined;
  }
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) return undefined;
  return { enabled: v.enabled === true, localHost, localPort };
}

function normalize(raw: unknown): SshHostPrefs {
  if (!raw || typeof raw !== 'object') return {};
  const out: SshHostPrefs = {};
  for (const [hostId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const agentProxy = normalizeAgentProxy(v.agentProxy);
    out[hostId] = {
      autoConnect: v.autoConnect === true,
      ...(agentProxy ? { agentProxy } : {}),
    };
  }
  return out;
}

let cached: SshHostPrefs | null = null;

/** 同步读取全部 prefs, 第一次从盘读, 后续走 cache. */
export function readSshHostPrefs(): SshHostPrefs {
  if (cached) return cached;
  const file = settingsFilePath();
  try {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf-8');
      cached = normalize(JSON.parse(text));
      log.info('ssh host prefs loaded', { hosts: Object.keys(cached).length, path: file });
      return cached;
    }
  } catch (err) {
    log.warn('ssh-host-prefs.json read failed → falling back to empty', {
      error: err instanceof Error ? err.message : String(err),
      path: file,
    });
    try { fs.unlinkSync(file); } catch { /* no-op */ }
  }
  cached = {};
  return cached;
}

/** 单 host 的 autoConnect 标志, 缺失即 false. */
export function getSshHostAutoConnect(hostId: string): boolean {
  return readSshHostPrefs()[hostId]?.autoConnect === true;
}

/** 单 host 的 agentProxy 配置; 未配置 / enabled=false / 数据非法 → null. */
export function getSshHostAgentProxy(hostId: string): SshHostAgentProxyPref | null {
  const pref = readSshHostPrefs()[hostId]?.agentProxy;
  if (!pref || pref.enabled !== true) return null;
  return pref;
}

/** 写入单 host 的 agentProxy 配置 (null = 关闭并清除), atomic write + 更新 cache. */
export function setSshHostAgentProxy(hostId: string, agentProxy: SshHostAgentProxyPref | null): void {
  const current = { ...readSshHostPrefs() };
  // 不 spread 旧 entry — 旧 agentProxy 会借 spread 复活, null 语义就是清除。
  const next: SshHostPref = { autoConnect: current[hostId]?.autoConnect === true };
  if (agentProxy) {
    const normalized = normalizeAgentProxy(agentProxy);
    if (!normalized) {
      throw new Error(`invalid agentProxy pref: localHost/localPort malformed`);
    }
    next.agentProxy = { ...normalized, enabled: agentProxy.enabled === true };
  }
  current[hostId] = next;
  writePrefs(current);
  log.info('ssh host agentProxy written', {
    hostId,
    enabled: next.agentProxy?.enabled === true,
    localTarget: next.agentProxy ? `${next.agentProxy.localHost}:${next.agentProxy.localPort}` : null,
  });
}

function writePrefs(prefs: SshHostPrefs): void {
  const file = settingsFilePath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  cached = prefs;
}

/** 写入单 host 的 autoConnect, atomic write + 更新 cache. */
export function setSshHostAutoConnect(hostId: string, autoConnect: boolean): void {
  const current = { ...readSshHostPrefs() };
  current[hostId] = { ...current[hostId], autoConnect };
  writePrefs(current);
  log.info('ssh host autoConnect written', { hostId, autoConnect });
}

/** 是否至少一台 host 勾了 autoConnect. 新建对话「添加远程项目」入口的可见性 gate. */
export function hasAnyAutoConnectHost(): boolean {
  const prefs = readSshHostPrefs();
  for (const id of Object.keys(prefs)) {
    if (prefs[id]?.autoConnect) return true;
  }
  return false;
}

/** host 被删时清理 prefs (避免长尾僵尸 key). */
export function removeSshHostPref(hostId: string): void {
  const current = readSshHostPrefs();
  if (!(hostId in current)) return;
  const next = { ...current };
  delete next[hostId];
  writePrefs(next);
  log.info('ssh host pref removed', { hostId });
}
