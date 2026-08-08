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
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lockSync } from 'proper-lockfile';

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
/** Claude Code 2.1.219 secureStorage.mutate 使用的同名 proper-lockfile 目标。 */
const CREDENTIAL_WRITE_LOCK_TARGET = '.storage-write';
const CREDENTIAL_WRITE_LOCK_STALE_MS = 15_000;
const CREDENTIAL_WRITE_LOCK_UPDATE_MS = 5_000;
/** 必须短于 lock stale;同步 security 调用期间事件循环无法执行 lock heartbeat。 */
const SECURITY_COMMAND_TIMEOUT_MS = 2_000;

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

type RawBlobReadResult =
  { kind: 'value'; raw: string } | { kind: 'absent' } | { kind: 'unreadable'; cause: unknown };

type BlobReadResult =
  | { kind: 'value'; value: Record<string, unknown>; raw: string }
  | { kind: 'absent' }
  | { kind: 'unreadable'; cause: unknown };

type BlobWriteMode = 'create' | 'update';

export type BoundClaudeAiOAuthState = 'present' | 'absent' | 'unreadable';

function securityEnvironment(): NodeJS.ProcessEnv {
  // `security` 的 exit status 只有 OSStatus 的低 8 位,不能单独证明 errSecItemNotFound。
  // 固定英文 stderr 后才能把 status 44 + 明确的 Keychain not-found 文本作为双重证据。
  return { ...process.env, LC_ALL: 'C', LANG: 'C' };
}

function errorStderr(error: unknown): string {
  if (!error || typeof error !== 'object' || !('stderr' in error)) return '';
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string') return stderr;
  if (Buffer.isBuffer(stderr)) return stderr.toString('utf8');
  return '';
}

function isMacKeychainItemNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  const status = (error as { status?: unknown }).status;
  if (status !== 44) return false;
  const stderr = errorStderr(error);
  return (
    stderr.includes('SecKeychainSearchCopyNext') &&
    stderr.includes('The specified item could not be found in the keychain.')
  );
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code,
  );
}

function unreadableStoreError(cause: unknown): Error {
  return new Error('claude credential store read failed; refusing to modify shared credentials', {
    cause,
  });
}

function withCredentialWriteLock<T>(mutation: () => T): T {
  const dir = claudeConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  let compromised: unknown = null;
  let release: () => void;
  try {
    release = lockSync(path.join(dir, CREDENTIAL_WRITE_LOCK_TARGET), {
      realpath: false,
      stale: CREDENTIAL_WRITE_LOCK_STALE_MS,
      update: CREDENTIAL_WRITE_LOCK_UPDATE_MS,
      onCompromised: (error) => {
        compromised = error;
      },
    });
  } catch (cause) {
    const message = isErrno(cause, 'ELOCKED')
      ? 'claude credential store is busy; refusing to modify shared credentials'
      : 'failed to acquire claude credential write lock; refusing to modify shared credentials';
    throw new Error(message, { cause });
  }

  const noFailure = Symbol('no-failure');
  let failure: unknown | typeof noFailure = noFailure;
  let value!: T;
  try {
    if (compromised) throw compromised;
    value = mutation();
    if (compromised) throw compromised;
  } catch (error) {
    failure = error;
  }
  try {
    release();
  } catch (error) {
    // mutation 的原始错误比随后释放失败更有诊断价值;成功路径则不能把释放失败谎报成成功。
    if (failure === noFailure) failure = error;
    else {
      log.warn('claude credential write lock release failed after mutation error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failure !== noFailure) throw failure;
  return value;
}

/** 读 keychain 条目的**原始文本值**(JSON 字符串),严格区分缺失与不可读。 */
function readBlobRawMac(): RawBlobReadResult {
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-a', keychainAccount(), '-w', '-s', KEYCHAIN_SERVICE],
      {
        encoding: 'utf-8',
        env: securityEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SECURITY_COMMAND_TIMEOUT_MS,
      },
    );
    const text = out.trim();
    return text.length > 0
      ? { kind: 'value', raw: text }
      : { kind: 'unreadable', cause: new Error('keychain item returned an empty value') };
  } catch (error) {
    return isMacKeychainItemNotFound(error)
      ? { kind: 'absent' }
      : { kind: 'unreadable', cause: error };
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
function writeBlobMac(blob: Record<string, unknown>, mode: BlobWriteMode): void {
  const json = JSON.stringify(blob);
  const hex = Buffer.from(json, 'utf-8').toString('hex');
  const updateFlag = mode === 'update' ? ' -U' : '';
  const interactiveCmd = `add-generic-password${updateFlag} -a "${keychainAccount()}" -s "${KEYCHAIN_SERVICE}" -X "${hex}"\n`;
  if (decideKeychainWriteMode(interactiveCmd.length) === 'stdin') {
    execFileSync('security', ['-i'], {
      env: securityEnvironment(),
      input: interactiveCmd,
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: SECURITY_COMMAND_TIMEOUT_MS,
    });
  } else {
    const args = ['add-generic-password'];
    if (mode === 'update') args.push('-U');
    args.push('-a', keychainAccount(), '-s', KEYCHAIN_SERVICE, '-X', hex);
    execFileSync('security', args, {
      env: securityEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: SECURITY_COMMAND_TIMEOUT_MS,
    });
  }
}

function deleteItemMac(): void {
  try {
    execFileSync(
      'security',
      ['delete-generic-password', '-a', keychainAccount(), '-s', KEYCHAIN_SERVICE],
      {
        env: securityEnvironment(),
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: SECURITY_COMMAND_TIMEOUT_MS,
      },
    );
  } catch (error) {
    // 读取后到删除前,Claude CLI 可能已先删掉同一条目;此时目标状态已经达成。
    if (!isMacKeychainItemNotFound(error)) throw error;
  }
}

/** 读 ~/.claude/.credentials.json 的**原始文本值**,仅 ENOENT 算缺失。 */
function readBlobRawFile(): RawBlobReadResult {
  try {
    const text = fs.readFileSync(credentialsFilePath(), 'utf-8').trim();
    return text.length > 0
      ? { kind: 'value', raw: text }
      : { kind: 'unreadable', cause: new Error('credential file is empty') };
  } catch (error) {
    return isErrno(error, 'ENOENT') ? { kind: 'absent' } : { kind: 'unreadable', cause: error };
  }
}

function writeBlobFile(blob: Record<string, unknown>, mode: BlobWriteMode): void {
  const file = credentialsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const contents = JSON.stringify(blob, null, 2);
  if (mode === 'create') {
    // `wx` 是 create-only:即使另一个 Cindy / Claude 进程刚刚创建了共享文件,
    // 也只会 EEXIST 失败,绝不会像 rename 那样把对方的新 blob 覆盖掉。
    fs.writeFileSync(file, contents, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
  } else {
    // 已确认存在时仍用同目录原子替换;唯一临时名避免多个进程踩同一个固定 `.tmp`。
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, contents, {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o600,
      });
      fs.renameSync(tmp, file);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort temp cleanup */
      }
      throw error;
    }
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

/** 平台分流读原始文本。 */
function readBlobRaw(): RawBlobReadResult {
  return process.platform === 'darwin' ? readBlobRawMac() : readBlobRawFile();
}

function readBlob(): BlobReadResult {
  const result = readBlobRaw();
  if (result.kind !== 'value') return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.raw);
  } catch (cause) {
    return { kind: 'unreadable', cause };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      kind: 'unreadable',
      cause: new Error('credential store root must be a JSON object'),
    };
  }
  return { kind: 'value', value: parsed as Record<string, unknown>, raw: result.raw };
}

/**
 * 共享 blob 在首次读取后可能被 Claude CLI 改写。已有值的 mutation 在落盘前至少要求连续
 * 两次读取同一原始快照;检测到变化就以新快照继续确认,而不是拿旧副本覆盖新字段。
 *
 * `security` / 普通文件没有 compare-and-swap,无法阻止另一进程恰好在最后确认后写入;这里
 * 收窄并检测可观察到的竞争窗口。absent 不需要连续确认,后续 create-only 本身会原子拒绝抢占。
 */
function stabilizeExistingBlob(
  initial: BlobReadResult,
): Exclude<BlobReadResult, { kind: 'unreadable' }> {
  if (initial.kind === 'unreadable') throw unreadableStoreError(initial.cause);
  if (initial.kind === 'absent') return initial;
  let previous = initial;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = readBlob();
    if (latest.kind === 'unreadable') throw unreadableStoreError(latest.cause);
    if (latest.kind === 'absent') return latest;
    if (latest.raw === previous.raw) return latest;
    previous = latest;
  }
  throw new Error(
    'claude credential store changed repeatedly; refusing to overwrite shared credentials',
  );
}

/**
 * 写 blob 并**写后回读校验**。任一后端若写入被截断 / 部分写,回读对不上即抛 ——
 * 绝不让损坏值静默留在凭证库(本 bug 根因正是「写失败 + 留下截断值」无人察觉)。
 * 校验通过才返回,失败则抛,由调用方决定如何反馈。
 */
function writeBlob(blob: Record<string, unknown>, mode: BlobWriteMode): void {
  if (process.platform === 'darwin') writeBlobMac(blob, mode);
  else writeBlobFile(blob, mode);
  const verification = readBlobRaw();
  if (
    !blobRoundtrips(JSON.stringify(blob), verification.kind === 'value' ? verification.raw : null)
  ) {
    throw new Error(
      'claude credential store write verification failed (value missing or corrupted after write)',
    );
  }
}

// ── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 读取当前 Claude.ai OAuth 凭证(claudeAiOauth 段);无 / 解析失败 → null。
 * getState 自动兼容本地登录 + 登录后状态判定都用它。
 */
export function readClaudeAiOAuth(): ClaudeAiOAuth | null {
  if (!isNativeProviderAuthBound('anthropic')) return null;
  const result = readBlob();
  if (result.kind !== 'value') return null;
  const oauth = result.value.claudeAiOauth as ClaudeAiOAuth | undefined;
  if (oauth && typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0) {
    return oauth;
  }
  return null;
}

/** 是否存在可用的 Claude.ai OAuth 登录(有 accessToken)。 */
export function hasClaudeAiOAuth(): boolean {
  return readClaudeAiOAuth() != null;
}

/**
 * Mutation callers must distinguish a confirmed absence from an unreadable
 * shared store. Read-only status paths intentionally keep using the nullable
 * API above so a transient Keychain failure does not throw across the UI.
 */
export function getBoundClaudeAiOAuthState(): BoundClaudeAiOAuthState {
  if (!isNativeProviderAuthBound('anthropic')) return 'absent';
  const result = readBlob();
  if (result.kind === 'unreadable') return 'unreadable';
  if (result.kind === 'absent') return 'absent';
  const oauth = result.value.claudeAiOauth as ClaudeAiOAuth | undefined;
  return typeof oauth?.accessToken === 'string' && oauth.accessToken.length > 0
    ? 'present'
    : 'absent';
}

/** Legacy upgrade probe; intentionally bypasses owner binding once at migration time. */
export function hasClaudeAiOAuthUnbound(): boolean {
  const result = readBlob();
  if (result.kind !== 'value') return false;
  const oauth = result.value.claudeAiOauth as ClaudeAiOAuth | undefined;
  return typeof oauth?.accessToken === 'string' && oauth.accessToken.length > 0;
}

/**
 * 写入 Claude.ai OAuth 凭证 —— 读改写,保留 blob 里 claudeAiOauth 以外的字段
 * (cc 可能存了其它内容)。失败抛错让上层反馈。
 */
export function writeClaudeAiOAuth(oauth: ClaudeAiOAuth): void {
  withCredentialWriteLock(() => {
    let result = readBlob();
    if (result.kind === 'unreadable') throw unreadableStoreError(result.cause);
    result = stabilizeExistingBlob(result);
    if (result.kind === 'value') {
      writeBlob({ ...result.value, claudeAiOauth: oauth }, 'update');
    } else {
      try {
        writeBlob({ claudeAiOauth: oauth }, 'create');
      } catch (createError) {
        // create-only 仍防御不遵守 Claude 锁协议的旧进程:抢占时重读新值再合并。
        const raced = stabilizeExistingBlob(readBlob());
        if (raced.kind !== 'value') throw createError;
        writeBlob({ ...raced.value, claudeAiOauth: oauth }, 'update');
      }
    }
    log.info('claude oauth credential written', {
      storage: process.platform === 'darwin' ? 'keychain' : 'file',
      hasRefresh: Boolean(oauth.refreshToken),
    });
  });
}

/**
 * 清除 Claude.ai OAuth 凭证(登出)。
 * ⚠️ 这是系统级 Claude Code 凭证库,清除会**同时**登出本地 `claude` CLI —— 调用方需在
 * UI confirm 里讲清。读改写删 claudeAiOauth;若 blob 删空了则连条目/文件一起删。
 */
export function clearClaudeAiOAuth(): void {
  withCredentialWriteLock(() => {
    let result = readBlob();
    if (result.kind === 'unreadable') throw unreadableStoreError(result.cause);
    result = stabilizeExistingBlob(result);
    if (result.kind === 'absent') return;
    const plan = planClaudeAiOAuthClear(result.value);
    switch (plan.action) {
      case 'noop':
        return;
      case 'delete':
        // 整个 blob 只有 claudeAiOauth → 删掉整条条目 / 文件。
        if (process.platform === 'darwin') deleteItemMac();
        else {
          try {
            fs.unlinkSync(credentialsFilePath());
          } catch (error) {
            if (!isErrno(error, 'ENOENT')) throw error;
          }
        }
        break;
      case 'write':
        // 还有 cc 的 mcpOAuth 等其它字段 → 写回裁剪后的整块(保留它们);writeBlob 自带写后校验。
        writeBlob(plan.next, 'update');
        break;
    }
    log.info('claude oauth credential cleared');
  });
}
