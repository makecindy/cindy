/**
 * ssh-host-prefs-store —— 每台 SSH 远端机器的本地偏好(displayName +
 * autoConnect + agentProxy)。
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

// pref 联合类型 / URL 校验 / 迁移缺省端口的真源在 shared (preload 与
// renderer 表单共用同一份, 消除手写镜像的结构漂移) — 这里 re-export 保持
// main 侧既有引用点不变。旧数据 ({enabled, localHost, localPort} 无 mode,
// PR #715 动态端口方案) 迁移为 mode='tunnel' + LEGACY_AGENT_PROXY_REMOTE_PORT。
import {
  LEGACY_AGENT_PROXY_REMOTE_PORT,
  normalizeAgentProxyUrl,
  redactAgentProxyUrlForLog,
  type SshHostAgentProxyPref,
} from '../../shared/agentProxyConfig.js';

export { LEGACY_AGENT_PROXY_REMOTE_PORT, normalizeAgentProxyUrl };
export type { SshHostAgentProxyPref };

function isValidPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;
}

/**
 * 固定远端端口拒收特权/知名服务端口 (<1024): 隧道保活的残留清理会定点
 * kill 占着固定端口的 sshd 会话, 若用户把端口配成 22 (SSH 服务) 等, 清理
 * 路径可能误杀系统 sshd 主服务 (review: PR #992 codex-connector P1)。
 * 高端口 (>=1024) 由用户显式指定、归属自担; 低端口一刀切拒收。
 */
export function isAllowedAgentProxyRemotePort(v: unknown): v is number {
  return isValidPort(v) && (v as number) >= 1024;
}

export interface SshHostPref {
  displayName?: string;
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
  if (v.mode === 'env') {
    const proxyUrl = normalizeAgentProxyUrl(v.proxyUrl);
    if (!proxyUrl) {
      log.warn('invalid agentProxy.proxyUrl in prefs — dropping (was it hand-edited?)', {
        proxyUrl: redactAgentProxyUrlForLog(v.proxyUrl),
      });
      return undefined;
    }
    return { enabled: v.enabled === true, mode: 'env', proxyUrl };
  }
  // mode='tunnel' 或缺省 (旧数据迁移路径)。
  const localHost = typeof v.localHost === 'string' ? v.localHost.trim() : '';
  const localPort = typeof v.localPort === 'number' ? v.localPort : NaN;
  // 引号与空白同样拒 (与 IPC normalizeAgentProxyInput / renderer 校验对齐,
  // review: PR #715 copilot R8): 手编 prefs 的脏值不应在启动时被恢复成
  // 可用 pref, 然后晚到 net.connect 才以难懂的方式失败。
  if (!localHost || /\s/.test(localHost) || localHost.includes("'") || localHost.includes('"')) {
    log.warn('invalid agentProxy.localHost in prefs — dropping (was it hand-edited?)', {
      localHost: '[redacted]',
    });
    return undefined;
  }
  if (!isValidPort(localPort)) {
    log.warn('invalid agentProxy.localPort in prefs — dropping (was it hand-edited?)', {
      localPort: v.localPort,
    });
    return undefined;
  }
  if (!isAllowedAgentProxyRemotePort(v.remotePort ?? LEGACY_AGENT_PROXY_REMOTE_PORT)) {
    log.warn('agentProxy.remotePort in privileged/service range — dropping (must be >=1024)', {
      remotePort: v.remotePort,
    });
    return undefined;
  }
  const remotePort = isValidPort(v.remotePort) ? v.remotePort : LEGACY_AGENT_PROXY_REMOTE_PORT;
  return { enabled: v.enabled === true, mode: 'tunnel', localHost, localPort, remotePort };
}

function normalize(raw: unknown): SshHostPrefs {
  if (!raw || typeof raw !== 'object') return {};
  const out: SshHostPrefs = {};
  for (const [hostId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const agentProxy = normalizeAgentProxy(v.agentProxy);
    out[hostId] = {
      ...(typeof v.displayName === 'string' && v.displayName.trim()
        ? { displayName: v.displayName.trim() }
        : {}),
      autoConnect: v.autoConnect === true,
      ...(agentProxy ? { agentProxy } : {}),
    };
  }
  return out;
}

export function getSshHostDisplayName(hostId: string): string {
  return readSshHostPrefs()[hostId]?.displayName?.trim() || hostId;
}

export function setSshHostDisplayName(hostId: string, displayName: string): void {
  patchSshHostPref(hostId, { displayName });
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
  patchSshHostPref(hostId, { agentProxy });
}

/** Persist related alias-local fields in one atomic prefs-file replacement. */
export function patchSshHostPref(
  hostId: string,
  patch: { displayName?: string; agentProxy?: SshHostAgentProxyPref | null },
): void {
  const current = { ...readSshHostPrefs() };
  const next: SshHostPref = {
    autoConnect: current[hostId]?.autoConnect === true,
    ...(current[hostId]?.displayName ? { displayName: current[hostId].displayName } : {}),
    ...(current[hostId]?.agentProxy ? { agentProxy: current[hostId].agentProxy } : {}),
  };

  if (patch.displayName !== undefined) {
    const normalized = patch.displayName.trim();
    if (normalized && normalized !== hostId) next.displayName = normalized;
    else delete next.displayName;
  }

  if (patch.agentProxy !== undefined) {
    // null explicitly clears; undefined means the caller did not edit this field.
    delete next.agentProxy;
    if (patch.agentProxy) {
      const normalized = normalizeAgentProxy(patch.agentProxy);
      if (!normalized) {
        throw new Error('invalid agentProxy pref: localHost/localPort malformed');
      }
      next.agentProxy = { ...normalized, enabled: patch.agentProxy.enabled === true };
    }
  }

  current[hostId] = next;
  writePrefs(current);
  const ap = next.agentProxy;
  log.info('ssh host local prefs written', {
    hostId,
    displayNameCustomized: !!next.displayName,
    enabled: ap?.enabled === true,
    mode: ap?.mode ?? null,
    // 脱敏: proxyUrl 即使将来校验放宽也不原样进日志 (review: PR #992
    // copilot — URL 可能带 userinfo), 只记录 scheme://host:port。
    target: ap
      ? ap.mode === 'tunnel'
        ? `remote:${ap.remotePort} -> ${ap.localHost}:${ap.localPort}`
        : redactAgentProxyUrlForLog(ap.proxyUrl)
      : null,
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
