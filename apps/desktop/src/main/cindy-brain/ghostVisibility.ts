/**
 * Ghost 可见性分类的 main 侧唯一真源。
 *
 * ghost_info、ghost_call 及其 setup waiter 都必须调用本函数，判序固定为：
 * 不存在 → 未登录 → 已下线 → 当前工作目录停用 → 未启用。
 *
 * ghost_info 是免审批的只读查询，但会用 GHOST_ASLEEP /
 * GHOST_DISABLED_IN_WORKDIR 明确区分已安装插件的不可见原因；这项存在性
 * 披露是产品有意接受的取舍，不要重新合并成 GHOST_NOT_FOUND。
 */

import { compareCindyVersions } from '@cindy/plugin-protocol';
import { isValidGhostId, type InstalledGhost } from '../../shared/ghost.js';
import {
  findInstalledGhostByInstanceId,
  formatInstalledGhostAmbiguity,
  installedGhostStoragePart,
  installedGhostLogicalIdentity,
  deliveryNamespaceFields,
  resolveInstalledGhost,
  hasDeliveryNamespace,
} from '../../shared/pluginIdentity.js';
import { t } from '../i18n.js';

export type GhostVisibilityResult =
  | { ok: true; ghost: InstalledGhost }
  | {
      ok: false;
      errorCode: 'GHOST_NOT_FOUND' | 'GHOST_NAMESPACE_MISMATCH' | 'GHOST_ASLEEP' | 'GHOST_DISABLED_IN_WORKDIR' | 'GHOST_RETIRED' | 'GHOST_AMBIGUOUS';
      message: string;
      candidates?: Array<{ ghostId: string; namespace: string | null }>;
    };

export interface GhostVisibilityDeps {
  listGhosts: () => InstalledGhost[];
  /** Fresh exact-instance lookup, never a completed authorization cache. */
  findInstalledInstance?: (instanceKey: string) => InstalledGhost | undefined;
  isAvailableForActiveSession: (ghostId: string) => boolean;
  isDisabledForWorkdir: (ghostId: string, workdir: string | null) => boolean;
  /**
   * Whether discovery lists this copy for the Agent (for example it has tools or
   * a manual). A bare name must pick its version among the same candidates that
   * `ghost_list` shows, so a panel-only copy cannot win over a listed one.
   */
  isDiscoverable?: (ghost: InstalledGhost) => boolean;
}

/** Discovery policy only: never merge installation identity, credentials or state.
 * A disabled/unavailable copy cannot hide a usable one. Organizations and
 * unresolved legacy identities remain independent.
 */
export function preferLatestLocalOrPublicGhosts(
  ghosts: InstalledGhost[],
  isEligible: (ghost: InstalledGhost) => boolean = () => true,
): InstalledGhost[] {
  const pairs = new Map<string, { local: InstalledGhost[]; public: InstalledGhost[] }>();
  for (const ghost of ghosts) {
    if (ghost.namespaceState === 'pending' || ghost.namespaceState === 'unconfirmed' ||
        !hasDeliveryNamespace(ghost) || (ghost.namespace !== null && ghost.namespace !== 'local')) continue;
    const pair = pairs.get(ghost.manifest.id) ?? { local: [], public: [] };
    pair[ghost.namespace === 'local' ? 'local' : 'public'].push(ghost);
    pairs.set(ghost.manifest.id, pair);
  }
  const hidden = new Set<InstalledGhost>();
  for (const pair of pairs.values()) {
    // Duplicate physical identities or invalid historical versions need explicit
    // addressing; do not manufacture a winner from iteration order.
    if (pair.local.length !== 1 || pair.public.length !== 1) continue;
    const local = pair.local[0]!;
    const published = pair.public[0]!;
    const localEligible = isEligible(local);
    const publicEligible = isEligible(published);
    if (!localEligible && !publicEligible) continue;
    if (localEligible !== publicEligible) {
      hidden.add(localEligible ? published : local);
      continue;
    }
    const order = compareCindyVersions(local.manifest.version, published.manifest.version);
    if (order !== null) hidden.add(order > 0 ? published : local);
  }
  return ghosts.filter((ghost) => !hidden.has(ghost));
}

export function classifyGhostVisibility(
  ghostId: string,
  workdir: string | null,
  deps: GhostVisibilityDeps,
  namespace?: string | null,
): GhostVisibilityResult {
  const listed = deps.listGhosts();
  // Agent、用户和深链传来的是逻辑名。除 public/local 日常版本选择外，
  // 多个实例仍报歧义，不能因为旧 root 的实例键恰好同名就选中它。
  // 存储键（_root__helper、_ns__acme__helper）不是合法 ghostId，按实例精确匹配。
  const byName = namespace !== undefined || isValidGhostId(ghostId);
  // A bare name follows daily discovery. Explicit namespace/storage identity
  // remains exact for developer tools, existing pages and in-flight operations.
  const candidates = namespace === undefined && byName
    ? preferLatestLocalOrPublicGhosts(
        listed,
        (ghost) => classifyGhostAvailability(ghost, workdir, deps).ok && (deps.isDiscoverable?.(ghost) ?? true),
      )
    : listed;
  const resolved = byName
    ? resolveInstalledGhost(candidates, ghostId, namespace)
    : (() => {
        const ghost = findInstalledGhostByInstanceId(listed, ghostId);
        return ghost
          ? { status: 'unique' as const, ghost }
          : { status: 'missing' as const };
      })();
  if (resolved.status === 'missing') {
    // The outgoing owner projection can remain installed during account teardown.
    // Match discovery's active-session gate before disclosing recovery identities.
    const sameName = namespace === undefined ? [] : listed.filter((ghost) =>
      ghost.manifest.id === ghostId && deps.isAvailableForActiveSession(installedGhostStoragePart(ghost)),
    );
    if (sameName.length > 0) {
      // A model may quote JSON null as the valid organization slug "null".
      // Preserve exact addressing: explain the mismatch, never redirect a call
      // or change the namespace of a pending legacy installation.
      const targets = sameName.map((ghost) => ({
        ghost_id: ghost.manifest.id,
        ...deliveryNamespaceFields(ghost),
      }));
      return {
        ok: false,
        errorCode: 'GHOST_NAMESPACE_MISMATCH',
        message: `插件已安装，但 namespace=${JSON.stringify(namespace)} 未匹配该插件的安装身份。` +
          'JSON null（不带引号）表示 root；字符串 "null" 表示名为 null 的企业，两者不同。' +
          `已安装身份：${JSON.stringify(targets)}。` +
          '请核对目标后按对应身份原样传参，保留 namespace 的类型；身份未提供 namespace 时省略该字段。' +
          '不要原样重试错误参数，也不要自动改选其他实例。',
      };
    }
    return {
      ok: false,
      errorCode: 'GHOST_NOT_FOUND',
      message: t('newChat.pluginSetup.targetNotFound'),
    };
  }
  if (resolved.status === 'ambiguous') {
    return {
      ok: false,
      errorCode: 'GHOST_AMBIGUOUS',
      message: formatInstalledGhostAmbiguity(ghostId, resolved.candidates),
      candidates: resolved.candidates.map((candidate) => ({
        ghostId: candidate.manifest.id,
        namespace: hasDeliveryNamespace(candidate) ? candidate.namespace ?? null : null,
      })),
    };
  }
  return classifyGhostAvailability(resolved.ghost, workdir, deps);
}

function classifyGhostAvailability(
  ghost: InstalledGhost,
  workdir: string | null,
  deps: GhostVisibilityDeps,
): GhostVisibilityResult {
  const instanceId = installedGhostStoragePart(ghost);
  if (!deps.isAvailableForActiveSession(instanceId)) {
    return {
      ok: false,
      errorCode: 'GHOST_NOT_FOUND',
      // 这是 model-visible 的 tool result，按 #907 口径说「未登录」，不再
      // 使用已废弃的「本地模式」；末句的「本地」只描述能力落在本机。
      message: '该插件需要 Cindy 账号，未登录状态不可用；不要重试，改用本地可用方式。',
    };
  }
  if (ghost.retirement) {
    return { ok: false, errorCode: 'GHOST_RETIRED', message: t('settings.ghosts.retirement.agentNotice') };
  }
  if (deps.isDisabledForWorkdir(instanceId, workdir)) {
    return {
      ok: false,
      errorCode: 'GHOST_DISABLED_IN_WORKDIR',
      message: t('newChat.pluginSetup.targetDisabledInWorkdir'),
    };
  }
  if (!ghost.enabled) {
    return {
      ok: false,
      errorCode: 'GHOST_ASLEEP',
      message: t('newChat.pluginSetup.targetDisabled'),
    };
  }
  return { ok: true, ghost };
}

export function classifyInstalledGhostVisibility(
  target: InstalledGhost,
  workdir: string | null,
  deps: GhostVisibilityDeps,
): GhostVisibilityResult {
  const identity = installedGhostLogicalIdentity(target);
  const key = installedGhostStoragePart(target);
  const ghost = deps.findInstalledInstance
    ? deps.findInstalledInstance(key)
    : findInstalledGhostByInstanceId(deps.listGhosts(), key);
  if (!ghost || ghost.manifest.id !== identity.ghostId ||
      installedGhostLogicalIdentity(ghost).namespace !== identity.namespace ||
      ghost.dir !== target.dir ||
      JSON.stringify(ghost.approval) !== JSON.stringify(target.approval) ||
      JSON.stringify(deliveryNamespaceFields(ghost)) !== JSON.stringify(deliveryNamespaceFields(target)) ||
      installedGhostStoragePart(ghost) !== installedGhostStoragePart(target)) {
    return { ok: false, errorCode: 'GHOST_NOT_FOUND', message: t('newChat.pluginSetup.targetNotFound') };
  }
  return classifyGhostAvailability(ghost, workdir, deps);
}
