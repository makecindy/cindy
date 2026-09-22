/**
 * Ghost 可见性分类的 main 侧唯一真源。
 *
 * ghost_info、ghost_call 及其 setup waiter 都必须调用本函数，判序固定为：
 * 不存在 → 未登录 → 当前工作目录停用 → 未启用。
 *
 * ghost_info 是免审批的只读查询，但会用 GHOST_ASLEEP /
 * GHOST_DISABLED_IN_WORKDIR 明确区分已安装插件的不可见原因；这项存在性
 * 披露是产品有意接受的取舍，不要重新合并成 GHOST_NOT_FOUND。
 */

import type { InstalledGhost } from '../../shared/ghost.js';
import { isValidGhostId } from '../../shared/ghost.js';
import {
  findInstalledGhostByInstanceId,
  formatInstalledGhostAmbiguity,
  installedGhostStoragePart,
  resolveInstalledGhost,
} from '../../shared/pluginIdentity.js';
import { t } from '../i18n.js';

export type GhostVisibilityResult =
  | { ok: true; ghost: InstalledGhost }
  | {
      ok: false;
      errorCode: 'GHOST_NOT_FOUND' | 'GHOST_ASLEEP' | 'GHOST_DISABLED_IN_WORKDIR' | 'GHOST_AMBIGUOUS';
      message: string;
      candidates?: Array<{ ghostId: string; namespace: string | null }>;
    };

export interface GhostVisibilityDeps {
  listGhosts: () => InstalledGhost[];
  isAvailableForActiveSession: (ghostId: string) => boolean;
  isDisabledForWorkdir: (ghostId: string, workdir: string | null) => boolean;
}

export function classifyGhostVisibility(
  ghostId: string,
  workdir: string | null,
  deps: GhostVisibilityDeps,
  namespace?: string | null,
): GhostVisibilityResult {
  const listed = deps.listGhosts();
  // Plain ghostIds can be ambiguous across namespaces. Only encoded instance
  // ids (`_ns__acme__helper`) skip the unique-ghostId compatibility path.
  const byInstance =
    namespace === undefined && !isValidGhostId(ghostId)
      ? findInstalledGhostByInstanceId(listed, ghostId)
      : undefined;
  const resolved = byInstance
    ? { status: 'unique' as const, ghost: byInstance }
    : resolveInstalledGhost(listed, ghostId, namespace);
  if (resolved.status === 'missing') {
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
        namespace: Object.prototype.hasOwnProperty.call(candidate, 'namespace')
          ? candidate.namespace ?? null
          : null,
      })),
    };
  }
  const ghost = resolved.ghost;
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
