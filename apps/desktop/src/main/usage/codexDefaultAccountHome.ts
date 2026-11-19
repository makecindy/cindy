/**
 * apps/desktop/src/main/usage/codexDefaultAccountHome.ts
 *
 * 额度读取／重置的 `openai` 目标属于 OpenAI 账号池的默认账号（官方 CLI 的 `~/.codex`）。
 * Windows 没有建链接权限时，或 `codex-home` 仍有旧私有登录及断开标记时，内置连接的
 * adapter 可能没有可用登录，而账号池默认账号本身仍能正常运行任务。
 *
 * 账号池使用非旧版默认账号，且当前 owner 已授权系统默认登录时，读取该账号自己的目录，
 * 与账号池运行任务时的选择一致。内置登录文件仍指向同一凭证时，保留 adapter 的读取和
 * 恢复确认。旧私有文件的存在不能覆盖当前授权；独立登录、撤销授权或旧版默认账号同样走原 adapter。
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { CodexRateLimitAccountIdentity, CodexRateLimitResetServiceDeps } from './codexRateLimitReset.js';
import { codexAuthPathsShareIdentity } from '../maker-host/codex-auth-link.js';
import { getCodexHome } from '../maker-host/codex-home-path.js';
import { isNativeProviderAuthBoundToSharedSystemCredential } from '../maker-host/nativeProviderAuthBinding.js';
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

function defaultAccountAvailable(): boolean {
  const pool = readPool('openai');
  return Boolean(pool && !pool.disconnected && pool.legacyCodexDefault !== true
    && pool.accounts.some((account) => account.id === 'default'));
}

/** The default account's CLI home selected by its current owner authorization. */
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
  const systemAuth = path.join(home, 'auth.json');
  try {
    // Keyring-only logins keep the original reader: the account bridge needs this file.
    if (!(await stat(systemAuth)).isFile()) return null;
  } catch {
    return null;
  }
  if (await codexAuthPathsShareIdentity(path.join(nativeHome, 'auth.json'), systemAuth)) return null;
  // Read authorization after the filesystem checks, and recheck the pool after that read.
  return await isNativeProviderAuthBoundToSharedSystemCredential('openai')
    && defaultAccountAvailable() && accountDirectory('openai', 'default') === home ? home : null;
}

/** Identity of that home, with the credential guard used before a redemption. */
export async function readDefaultCodexHomeIdentity(
  home: string,
  assertCurrent: () => Promise<void>,
): Promise<CodexRateLimitAccountIdentity & { canDispatch: () => boolean }> {
  await assertCurrent();
  const auth = await readNativeAccount('openai', home, {
    codexCanDispatch: () => assertCurrent().then(() => true, () => false),
  });
  const tokens = await readNativeCodexTokens(home);
  await assertCurrent();
  if (!auth.authenticated || !auth.identity || !tokens.canDispatch())
    throw new Error('PRECONDITION_FAILED: ChatGPT account changed');
  return { email: auth.identity, accountId: tokens.chatgptAccountId, canDispatch: tokens.canDispatch };
}

/**
 * Wraps the built-in connection's reset target. Each call decides again, so changed authorization
 * or a removed default account takes effect at once; the reset service's identity bracket
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
      const { canDispatch, ...identity } = await readDefaultCodexHomeIdentity(home, () => assertHome(home));
      credentials.set(identity, { home, current: canDispatch });
      return identity;
    },
    readRateLimits: async () => {
      const home = await resolveHome();
      if (!home) return native.readRateLimits();
      await assertHome(home);
      const result = await codexAccountRpc(home, 'account/rateLimits/read', {},
        () => assertHome(home).then(() => true, () => false));
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
