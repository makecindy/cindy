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
import { t } from '../i18n.js';

export type GhostVisibilityResult =
  | { ok: true; ghost: InstalledGhost }
  | {
      ok: false;
      errorCode: 'GHOST_NOT_FOUND' | 'GHOST_ASLEEP' | 'GHOST_DISABLED_IN_WORKDIR';
      message: string;
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
): GhostVisibilityResult {
  const ghost = deps.listGhosts().find((candidate) => candidate.manifest.id === ghostId);
  if (!ghost) {
    return {
      ok: false,
      errorCode: 'GHOST_NOT_FOUND',
      message: t('newChat.pluginSetup.targetNotFound'),
    };
  }
  if (!deps.isAvailableForActiveSession(ghostId)) {
    return {
      ok: false,
      errorCode: 'GHOST_NOT_FOUND',
      // 这是 model-visible 的 tool result，按 #907 口径说「未登录」，不再
      // 使用已废弃的「本地模式」；末句的「本地」只描述能力落在本机。
      message: '该插件需要 Cindy 账号，未登录状态不可用；不要重试，改用本地可用方式。',
    };
  }
  if (deps.isDisabledForWorkdir(ghostId, workdir)) {
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
