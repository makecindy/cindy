import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';

type NativeProviderId = 'anthropic' | 'openai' | 'xai';
const NATIVE_PROVIDER_IDS = ['anthropic', 'openai', 'xai'] as const satisfies readonly NativeProviderId[];
type BindingFile = Partial<Record<NativeProviderId, string>> & {
  legacyClaimOwner?: string;
  /**
   * 被**显式登出**过、且尚未重新授权的 provider（值 = 执行登出的 owner，仅供诊断）。
   *
   * 登出会先删凭证再解绑，但删除是 best-effort 的（Anthropic 的文件删除吞 ENOENT 之外的
   * 错误、`logoutGrok` 忽略 secret store 的失败返回）。删除失败时 slot 已空、凭证却还在，
   * 自动认领会立刻把它绑回来——等于悄悄撤销用户刚做的登出。
   *
   * 判定**不比对 owner**：标记说的是「这份残留凭证已被弃用」，而凭证存在共享的系统
   * keychain / CLI 里，换个账号它也还是登出那个账号的凭证——按 owner 比对等于给下一个
   * 账号开了继承别人凭证的口子（PR #548 review）。解除只有一条路：用户再次显式授权
   * （`bindNativeProviderAuth` 清除），那时凭证已由本人重新写入。
   */
  revoked?: Partial<Record<NativeProviderId, string>>;
};

function bindingPath(): string {
  return path.join(app.getPath('userData'), 'native-provider-auth.json');
}

/**
 * 读绑定文件，**区分「确实还没有这个文件」与「有但读不出来」**。
 *
 * 只读判定（isNativeProviderAuthBound）两者都当空处理即可——空 = 未绑定 = fail-closed。
 * 但认领路径不行：把损坏 / 不可读一律当成「名额空着」，等于在归属信息丢失的那一刻
 * 把共享 keychain 里的凭证判给当前账号，而且随后的 writeBindings 会把损坏文件连同
 * 里面原有的归属一起覆盖掉，永久失去恢复依据（PR #548 review）。
 */
type BindingRead =
  | { ok: true; bindings: BindingFile }
  /** 文件本身读不出来 / 根不是对象：整份归属都无从判断，没有可挽救的部分。 */
  | { ok: false; reason: 'unreadable' }
  /** 根有效、各 provider 归属可信，只有 revoked 这个字段被改坏。 */
  | { ok: false; reason: 'badRevoked'; bindings: Omit<BindingFile, 'revoked'> };

function readBindingsOrFail(): BindingRead {
  let raw: string;
  try {
    raw = fs.readFileSync(bindingPath(), 'utf8');
  } catch (err) {
    // 文件不存在 = 合法的首次状态（还没有任何人绑定过）；其它读失败（EACCES / EIO 等）
    // 说明归属不明，不能当成空。
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { ok: true, bindings: {} };
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'unreadable' };
    }
    // revoked 也要验型:下游用 `provider in bindings.revoked` 判定,而 `in` 的右操作数是
    // 原始值时直接抛 TypeError —— 一个被手工修坏的字段会让认领、迁移、登出乃至重新授权
    // 全部炸在这里(PR #548 review)。
    //
    // 但坏的只是这一个字段:同一份文件里各 provider 的归属仍然是可信的,要单独交出来。
    // 认领 / 迁移 / 登出照样得 fail-closed(不知道谁被撤销过就不能认领),而显式授权可以
    // 只修 revoked、保住其余归属 —— 否则一次「修复」会把别人的 owner 抹掉,反倒开出新的
    // 误认领口子(PR #548 review)。
    const revoked = (value as { revoked?: unknown }).revoked;
    if (revoked !== undefined && (typeof revoked !== 'object' || revoked === null || Array.isArray(revoked))) {
      const { revoked: _bad, ...rest } = value as BindingFile;
      return { ok: false, reason: 'badRevoked', bindings: rest };
    }
    return { ok: true, bindings: value as BindingFile };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

function readBindings(): BindingFile {
  const read = readBindingsOrFail();
  return read.ok ? read.bindings : {};
}

function writeBindings(value: BindingFile): void {
  const file = bindingPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Return true only when the native OAuth credential is explicitly bound to this owner. */
export function isNativeProviderAuthBound(provider: NativeProviderId): boolean {
  const owner = getActiveAppSession().dataOwnerId;
  // During unit/bootstrap code paths there may be no committed owner yet.
  // Owner-bound sessions are fail-closed; pre-session callers retain legacy
  // behavior until authentication commits an owner boundary.
  if (!owner) return true;
  return readBindings()[provider] === owner;
}

/** Bind newly completed native OAuth to the current data owner. */
export function bindNativeProviderAuth(provider: NativeProviderId): void {
  const owner = getActiveAppSession().dataOwnerId;
  if (!owner) throw new Error('cannot bind native provider auth without an active data owner');
  const read = readBindingsOrFail();
  if (read.ok) {
    const bindings = read.bindings;
    // 显式授权 = 用户重新表达了「我要连它」，撤销标记就此作废。
    if (bindings.revoked && provider in bindings.revoked) {
      const revoked = { ...bindings.revoked };
      delete revoked[provider];
      bindings.revoked = revoked;
    }
    writeBindings({ ...bindings, [provider]: owner });
    return;
  }
  // 归属信息有损:用户正在显式授权,不写等于让他连不上,所以必须写;但写法要保守。
  //
  //   · badRevoked —— 各 provider 的归属仍然可信,原样保留。直接重写成「只有本次授权的这
  //     一家」会抹掉别人的 owner,那份凭证下一次就被自动认领给当前账号,等于用一次修复换
  //     来一个新的越权口子。
  //   · unreadable —— 连 legacyClaimOwner 带各家 owner 一起没了,无可保留;同样不能就这么
  //     写一份「只有我」的干净文件,那会让其余 provider 的残留凭证在文件恢复可读后立刻可被
  //     认领(PR #548 review)。
  //
  // 两种情形共用同一条保守收尾:凡是归属无从确认的 provider,一律按「撤销过」对待,自动继承
  // 就此关闭 —— 无从得知谁被撤销过时,丢弃标记等于给所有残留凭证放行。用户对它们各自显式
  // 授权即可恢复。
  const salvaged = read.reason === 'badRevoked' ? read.bindings : {};
  const suppressed: Partial<Record<NativeProviderId, string>> = {};
  for (const other of NATIVE_PROVIDER_IDS) {
    if (other !== provider) suppressed[other] = owner;
  }
  writeBindings({ ...salvaged, revoked: suppressed, [provider]: owner });
}

/**
 * Remove the current owner binding after logout/invalidation.
 *
 * `revoked: true` 只用于**用户显式登出**：它会留下一个持久标记，挡住后续的自动认领。
 * 服务端作废凭证（401 invalidate）不传——那不是用户意图，凭证也已被清掉，用户之后在本机
 * CLI 重新登录时仍应享有设计内的自动继承。
 */
export function unbindNativeProviderAuth(
  provider: NativeProviderId,
  opts?: { revoked?: boolean },
): void {
  // 归属读不出来时放弃写入。用户的意图是「登出这一个 provider」,不是「把其余 provider 的
  // 归属清空」—— 而把损坏文件覆盖成一份只剩撤销标记的新文件正是后者,其余 provider 从此
  // 无主,下一次可信读取就会把它们的残留凭证认领给当前账号(PR #548 review)。
  //
  // 不写也是安全的:文件读不出来时 isNativeProviderAuthBound 已经一律 false(用户看到的就是
  // 未连接),claimDetectedNativeProviderAuth 也已在同一条件下拒绝认领 —— 撤销标记要挡的那
  // 件事,此刻本来就发生不了。凭证删除在调用方,不受这里影响。
  const read = readBindingsOrFail();
  if (!read.ok) return;
  const bindings = read.bindings;
  const owner = getActiveAppSession().dataOwnerId;
  const marking = opts?.revoked === true && !!owner;
  if (!(provider in bindings) && !marking) return;
  delete bindings[provider];
  if (marking) bindings.revoked = { ...(bindings.revoked ?? {}), [provider]: owner as string };
  writeBindings(bindings);
}

/**
 * Claim pre-binding native OAuth credentials for the first verified cloud
 * owner. The durable marker prevents a later account from inheriting a
 * credential that was left in a shared CLI/keychain store after logout.
 */
export function migrateLegacyNativeProviderAuthBindings(
  ownerId: string,
  available: Partial<Record<NativeProviderId, boolean>>,
): void {
  // 同 claimDetectedNativeProviderAuth:一次性迁移也是写路径,归属读不出来就不能推进
  // (还会把 legacyClaimOwner 名额一起消费掉,损失不可逆)。
  const read = readBindingsOrFail();
  if (!read.ok) return;
  const bindings = read.bindings;
  if (bindings.legacyClaimOwner) return;

  const next: BindingFile = { ...bindings, legacyClaimOwner: ownerId };
  for (const provider of NATIVE_PROVIDER_IDS) {
    // 显式登出过的 provider 一律跳过:这条一次性迁移同样不能把用户弃用掉的残留凭证
    // 认领回来(PR #548 review)。
    if (bindings.revoked && provider in bindings.revoked) continue;
    if (available[provider] && !next[provider]) next[provider] = ownerId;
  }
  writeBindings(next);
}

/**
 * Claim an auto-detected local CLI credential for the current owner.
 *
 * Applies to every native provider, not just Codex. Two independent holes make
 * the intended first-owner auto-connect strand forever without this repair:
 *   - the one-shot legacy migration above can consume `legacyClaimOwner` while a
 *     credential is not visible yet (the Codex ~/.codex reconcile hardlink is
 *     created after startup, so its probe reads false);
 *   - the migration only runs for cloud owners that hold the legacy namespace
 *     claim, so local-mode owners — and cloud owners whose claim marker is
 *     absent — never get a chance to inherit at all, no matter how visible the
 *     credential is. Anthropic and xAI read their credential synchronously and
 *     are therefore immune to the first hole but not to the second.
 *
 * This repairs exactly that: only when the slot has no owner, the credential
 * exists, and no OTHER account won the legacy claim. An existing binding is
 * never overwritten, so account switches stay fail-closed like
 * migrateLegacyNativeProviderAuthBindings.
 */
export function claimDetectedNativeProviderAuth(
  provider: NativeProviderId,
  hasCredential: () => boolean,
): boolean {
  const owner = getActiveAppSession().dataOwnerId;
  if (!owner) return false;
  // A session boundary in flight means `owner` is about to be replaced: writing
  // now would hand the outgoing account's credential to the incoming one.
  // Callers reached from an async settle (Codex reconcile) additionally pin an
  // owner+generation snapshot; this guard is the floor every caller gets.
  if (isAppSessionBoundaryPending()) return false;
  // 归属文件读不出来 = 归属不明,一律不认领:这条路径是**写**路径,把损坏当空会把共享
  // keychain 里可能属于别人的凭证判给当前账号,并覆盖掉原有归属(PR #548 review)。
  const read = readBindingsOrFail();
  if (!read.ok) return false;
  const bindings = read.bindings;
  // Key-presence, not truthiness: a corrupted/empty-string slot must count as
  // "claimed by unknown" and fail closed, never as re-claimable (matches
  // unbindNativeProviderAuth's `in` pattern).
  if (provider in bindings) return false;
  if ('legacyClaimOwner' in bindings && bindings.legacyClaimOwner !== owner) return false;
  // 被显式登出过就绝不自动认领,且**不比对 owner**:凭证在共享的系统 keychain / CLI 里,
  // 换个账号它仍是登出那个账号的凭证 —— 按 owner 比对等于给下一个账号开了继承别人凭证
  // 的口子。解除只有「用户再次显式授权」一条路(PR #548 review)。
  if (bindings.revoked && provider in bindings.revoked) return false;
  if (!hasCredential()) return false;
  writeBindings({ ...bindings, [provider]: owner });
  return true;
}
