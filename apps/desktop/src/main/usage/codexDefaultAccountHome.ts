/**
 * apps/desktop/src/main/usage/codexDefaultAccountHome.ts
 *
 * 额度读取／重置的 `openai` 目标属于 OpenAI 账号池的默认账号（官方 CLI 的 `~/.codex`）。
 * 通常内置连接的 `codex-home/auth.json` 就是它的共享链接，原有读取直接可用；Windows 没有
 * 建链接权限时内置连接改走独立登录（auth-adapters 的 `link-unsupported`），在用户没有另行
 * 登录前 Cindy 目录里没有任何登录，原有读取只会报未登录，而默认账号本身正常运行任务
 * （2026-11-13 实测：设置页默认账号一直显示「配额更新失败」）。
 *
 * 只有「内置连接没有自己的登录文件、默认账号目录有登录文件」时才改读默认账号自己的目录，
 * 读法与其它池内账号相同；内置连接有任何登录条目（共享链接、独立登录、恢复流程）或默认账号
 * 仍是旧版私有目录时，一律保留原读取。
 */

import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CodexRateLimitAccountIdentity, CodexRateLimitResetServiceDeps } from './codexRateLimitReset.js';
import { getCodexHome } from '../maker-host/codex-home-path.js';
import { accountDirectory, readPool } from '../subscription-accounts/store.js';
import {
  codexAccountRpc,
  readNativeAccount,
  readNativeCodexTokens,
} from '../subscription-accounts/nativeCli.js';

type ResetTarget = Pick<
  CodexRateLimitResetServiceDeps,
  'readRateLimits' | 'consumeResetCredit' | 'readAccountIdentity' | 'recordRateLimitSnapshot'
>;

async function entryMissing(file: string): Promise<boolean> {
  try {
    // lstat: even a dangling link is still the built-in connection's own entry.
    await lstat(file);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function defaultAccountAvailable(): boolean {
  const pool = readPool('openai');
  return Boolean(pool && !pool.disconnected && pool.legacyCodexDefault !== true
    && pool.accounts.some((account) => account.id === 'default'));
}

/** The default account's CLI home when the built-in connection has no login entry of its own. */
export async function detachedDefaultCodexHome(): Promise<string | null> {
  if (!defaultAccountAvailable()) return null;
  let home: string;
  try {
    home = accountDirectory('openai', 'default');
  } catch {
    return null;
  }
  const nativeHome = getCodexHome();
  if (path.resolve(home) === path.resolve(nativeHome)) return null;
  try {
    // Keyring-only logins keep the original reader: the account bridge needs this file.
    if (!(await stat(path.join(home, 'auth.json'))).isFile()) return null;
  } catch {
    return null;
  }
  if (!await entryMissing(path.join(nativeHome, 'auth.json'))) return null;
  // Pool authorization can change while the filesystem checks yield.
  return defaultAccountAvailable() && accountDirectory('openai', 'default') === home ? home : null;
}

/** Identity of that home, with the credential guard used before a redemption. */
export async function readDefaultCodexHomeIdentity(
  home: string,
): Promise<CodexRateLimitAccountIdentity & { canDispatch: () => boolean }> {
  const auth = await readNativeAccount('openai', home);
  const tokens = await readNativeCodexTokens(home);
  if (!auth.authenticated || !auth.identity || !tokens.canDispatch())
    throw new Error('PRECONDITION_FAILED: ChatGPT account changed');
  return { email: auth.identity, accountId: tokens.chatgptAccountId, canDispatch: tokens.canDispatch };
}

/**
 * Wraps the built-in connection's reset target. Each call decides again, so a later built-in
 * login or a removed default account takes effect at once; the reset service's identity bracket
 * rejects a read or redemption that straddles the switch.
 */
export function withDetachedDefaultCodexHome(
  native: ResetTarget,
  assertScope: () => void,
  resolveHome: () => Promise<string | null> = detachedDefaultCodexHome,
): ResetTarget {
  // A concurrent read must not replace the credential proof that this redemption verified.
  const credentials = new WeakMap<CodexRateLimitAccountIdentity,
    { home: string | null; current: () => boolean }>();
  const assertHome = async (home: string) => {
    assertScope();
    if (await resolveHome() !== home) throw new Error('PRECONDITION_FAILED: ChatGPT account changed');
    assertScope();
  };
  return {
    readAccountIdentity: async () => {
      const home = await resolveHome();
      if (!home) {
        const identity = await native.readAccountIdentity();
        credentials.set(identity, { home: null, current: () => true });
        return identity;
      }
      await assertHome(home);
      const { canDispatch, ...identity } = await readDefaultCodexHomeIdentity(home);
      await assertHome(home);
      credentials.set(identity, { home, current: canDispatch });
      return identity;
    },
    readRateLimits: async () => {
      const home = await resolveHome();
      if (!home) return native.readRateLimits();
      await assertHome(home);
      const result = await codexAccountRpc(home, 'account/rateLimits/read', {});
      await assertHome(home);
      return result as Awaited<ReturnType<ResetTarget['readRateLimits']>>;
    },
    consumeResetCredit: async (params, identity) => {
      const bound = identity && credentials.get(identity);
      const home = await resolveHome();
      assertScope();
      if (!bound || bound.home !== home) throw new Error('PRECONDITION_FAILED: ChatGPT account changed');
      if (!home) return native.consumeResetCredit(params, identity);
      await assertHome(home);
      const canDispatch = async () => {
        try {
          // The CLI may await startup after this request was admitted; recheck revocation before send.
          await assertHome(home);
          return bound.current();
        } catch {
          return false;
        }
      };
      if (!await canDispatch()) throw new Error('PRECONDITION_FAILED: ChatGPT account changed');
      const result = await codexAccountRpc(home, 'account/rateLimitResetCredit/consume', params, canDispatch);
      await assertHome(home);
      return result as Awaited<ReturnType<ResetTarget['consumeResetCredit']>>;
    },
    // Like other pool accounts, a default-home read does not overwrite the built-in usage cache.
    recordRateLimitSnapshot: async (snapshot, identity) => {
      const bound = identity && credentials.get(identity);
      if (!bound || bound.home !== null || await resolveHome()) return;
      assertScope();
      await native.recordRateLimitSnapshot(snapshot, identity);
    },
  };
}
