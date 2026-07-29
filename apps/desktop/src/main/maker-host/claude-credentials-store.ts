/**
 * claude-credentials-store —— 读/写系统 Claude Code 的 OAuth 凭证(claudeAiOauth)。
 *
 * 设计目标:'oauth' 模式下与**本地已登录的 Claude Code 自动兼容**(像 Codex reconcile
 * ~/.codex/auth.json 那样),并让 Cindy 的浏览器授权结果落到同一处,cc 子进程原生读取。
 *
 * 存储位置(与 cc-code utils/secureStorage 完全一致,默认 config dir = ~/.claude):
 *   - macOS  → 系统 Keychain 的 generic-password,service = "Claude Code-credentials"
 *              (经 /usr/bin/security CLI 读写 —— 与 cc 同一访问者二进制,不触发额外 ACL 弹窗)
 *   - 其它   → <~/.claude>/.credentials.json 明文文件
 *
 * blob 形态(顶层对象,可能含 cc 写的其它字段,**读改写时保留**):
 *   { "claudeAiOauth": { accessToken, refreshToken, expiresAt, scopes, subscriptionType, ... }, ... }
 *
 * 我们只读 / 写 `claudeAiOauth` 这一段。token 到期刷新由 host 负责(claude-oauth-refresh,
 * 刷新结果写回本 store)—— cc >= 2.1.198 在 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST 下不再
 * 自读本凭证库,凭证经 env 显式递入子进程,cc 侧无 refresh token 可用(见 auth-adapters)。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  blobRoundtrips,
  decideKeychainWriteMode,
  planClaudeAiOAuthClear,
} from './claude-credentials-blob.js';
import { isNativeProviderAuthBound } from './nativeProviderAuthBinding.js';

const log = desktopMakerLogger.child('claude-credentials-store');

/** 默认 config dir(prod、无 CLAUDE_CONFIG_DIR override 时)= ~/.claude。 */
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** macOS Keychain service 名 —— 对齐 cc getMacOsKeychainStorageServiceName(prod 默认目录无后缀)。 */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function keychainAccount(): string {
  try {
    return process.env.USER || os.userInfo().username;
  } catch {
    return 'claude-code-user';
  }
}

function credentialsFilePath(): string {
  return path.join(claudeConfigDir(), '.credentials.json');
}

/** OAuth 凭证段(claudeAiOauth)。 */
export interface ClaudeAiOAuth {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  scopes?: string[];
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  [k: string]: unknown;
}

// ── 整个 blob 的读写(保留 claudeAiOauth 以外的字段) ───────────────────────────

/** 读 keychain 条目的**原始文本值**(JSON 字符串);条目不存在 / 读不到 → null。 */
function readBlobRawMac(): string | null {
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-a', keychainAccount(), '-w', '-s', KEYCHAIN_SERVICE],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const text = out.trim();
    return text.length > 0 ? text : null;
  } catch {
    // 条目不存在 → 视为无凭证
    return null;
  }
}

/**
 * 写 keychain 条目。
 *
 * 历史坑:原实现固定走 `security -i`(stdin 交互模式,目的是 hex 不出现在 ps/argv)。但该
 * 交互解释器输入行缓冲 ~4096B,**大 blob 会被静默截断**写入损坏值并 exit 1 —— 用户在同一
 * keychain 条目里存了多个 cc mcpOAuth token 时极易触发(登录 / 登出都中招)。
 * 现按整行命令长度分流:不超限走 stdin(保留隐私属性),超限改走直接 argv 传 hex
 * (ARG_MAX≈1MB,不截断),代价仅是大 blob 时 hex 短暂出现在同用户可见的 argv(规则 9:
 * 用代码确保写入确定性,而非赌 blob 不会变大)。
 */
function writeBlobMac(blob: Record<string, unknown>): void {
  const json = JSON.stringify(blob);
  const hex = Buffer.from(json, 'utf-8').toString('hex');
  const interactiveCmd = `add-generic-password -U -a "${keychainAccount()}" -s "${KEYCHAIN_SERVICE}" -X "${hex}"\n`;
  if (decideKeychainWriteMode(interactiveCmd.length) === 'stdin') {
    execFileSync('security', ['-i'], { input: interactiveCmd, stdio: ['pipe', 'ignore', 'ignore'] });
  } else {
    execFileSync(
      'security',
      ['add-generic-password', '-U', '-a', keychainAccount(), '-s', KEYCHAIN_SERVICE, '-X', hex],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
  }
}

function deleteItemMac(): void {
  try {
    execFileSync(
      'security',
      ['delete-generic-password', '-a', keychainAccount(), '-s', KEYCHAIN_SERVICE],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
  } catch {
    /* 条目不存在 → no-op */
  }
}

/** 读 ~/.claude/.credentials.json 的**原始文本值**;文件不存在 / 空 → null。 */
function readBlobRawFile(): string | null {
  try {
    const text = fs.readFileSync(credentialsFilePath(), 'utf-8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function writeBlobFile(blob: Record<string, unknown>): void {
  // 文件后端整块原子写(tmp + rename),无 keychain 那种行长度上限 —— Win/Linux 不受截断 bug 影响。
  const file = credentialsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(blob, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
}

/** 平台分流读原始文本。 */
function readBlobRaw(): string | null {
  return process.platform === 'darwin' ? readBlobRawMac() : readBlobRawFile();
}

function readBlob(): Record<string, unknown> | null {
  const raw = readBlobRaw();
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // 解析失败(含历史截断损坏值)→ 视为无凭证,不抛
    return null;
  }
}

/**
 * 写 blob 并**写后回读校验**。任一后端若写入被截断 / 部分写,回读对不上即抛 ——
 * 绝不让损坏值静默留在凭证库(本 bug 根因正是「写失败 + 留下截断值」无人察觉)。
 * 校验通过才返回,失败则抛,由调用方决定如何反馈。
 */
function writeBlob(blob: Record<string, unknown>): void {
  if (process.platform === 'darwin') writeBlobMac(blob);
  else writeBlobFile(blob);
  if (!blobRoundtrips(JSON.stringify(blob), readBlobRaw())) {
    throw new Error('claude credential store write verification failed (value missing or corrupted after write)');
  }
}

// ── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 读取当前 Claude.ai OAuth 凭证(claudeAiOauth 段);无 / 解析失败 → null。
 * getState 自动兼容本地登录 + 登录后状态判定都用它。
 */
export function readClaudeAiOAuth(): ClaudeAiOAuth | null {
  if (!isNativeProviderAuthBound('anthropic')) return null;
  const blob = readBlob();
  const oauth = blob?.claudeAiOauth as ClaudeAiOAuth | undefined;
  if (oauth && typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0) {
    return oauth;
  }
  return null;
}

/** 是否存在可用的 Claude.ai OAuth 登录(有 accessToken)。 */
export function hasClaudeAiOAuth(): boolean {
  return readClaudeAiOAuth() != null;
}

/** Legacy upgrade probe; intentionally bypasses owner binding once at migration time. */
export function hasClaudeAiOAuthUnbound(): boolean {
  const blob = readBlob();
  const oauth = blob?.claudeAiOauth as ClaudeAiOAuth | undefined;
  return typeof oauth?.accessToken === 'string' && oauth.accessToken.length > 0;
}

/**
 * 写入 Claude.ai OAuth 凭证 —— 读改写,保留 blob 里 claudeAiOauth 以外的字段
 * (cc 可能存了其它内容)。失败抛错让上层反馈。
 */
export function writeClaudeAiOAuth(oauth: ClaudeAiOAuth): void {
  const blob = readBlob() ?? {};
  blob.claudeAiOauth = oauth;
  writeBlob(blob);
  log.info('claude oauth credential written', {
    storage: process.platform === 'darwin' ? 'keychain' : 'file',
    hasRefresh: Boolean(oauth.refreshToken),
  });
}

/**
 * 清除 Claude.ai OAuth 凭证(登出)。
 * ⚠️ 这是系统级 Claude Code 凭证库,清除会**同时**登出本地 `claude` CLI —— 调用方需在
 * UI confirm 里讲清。读改写删 claudeAiOauth;若 blob 删空了则连条目/文件一起删。
 */
export function clearClaudeAiOAuth(): void {
  const plan = planClaudeAiOAuthClear(readBlob());
  switch (plan.action) {
    case 'noop':
      return;
    case 'delete':
      // 整个 blob 只有 claudeAiOauth → 删掉整条条目 / 文件。
      if (process.platform === 'darwin') deleteItemMac();
      else { try { fs.unlinkSync(credentialsFilePath()); } catch { /* no-op */ } }
      break;
    case 'write':
      // 还有 cc 的 mcpOAuth 等其它字段 → 写回裁剪后的整块(保留它们);writeBlob 自带写后校验。
      writeBlob(plan.next);
      break;
  }
  log.info('claude oauth credential cleared');
}
