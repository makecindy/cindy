/**
 * 插件安装／更新的用户确认判据（docs/dev-rules/plugin-security-and-authoring.md §3.1）。
 *
 * 首次安装一律需要确认；更新只在权限变多时需要确认。「权限」与插件详情页的
 * 权限区同口径：`ghostPermissionItems` 中除 Agent 工具以外的全部条目。新增条目、
 * 同 key 条目内容变化（例如多一个域名、换一组授权范围），或内置 OAuth 客户端
 * 身份变化都算变多；只删除条目不算。
 *
 * Main 用它决定是否挂起安装事务等用户确认；Renderer 用同一份实现给插件页的
 * 更新入口打「需确认新权限」标记。两侧必须同口径，因此住在 shared。
 */
import {
  diffInstalledGhostPermissionItems,
  ghostInstallApprovalToken,
  ghostPermissionItems,
  ghostPermissionProjectionKey,
  type GhostManifest,
  type GhostPermissionItem,
  type InstalledGhost,
} from './ghost.js';

/**
 * Agent 发起安装时投给任务的宿主权限确认卡的工具名。桌面卡片据此把首行作为说明、
 * 其余权限清单放进可滚动区域。
 */
export const GHOST_INSTALL_CONSENT_TOOL_NAME = 'cindy.plugin.install';

/** 谁发起了这次安装（只决定确认卡的来源说明，不参与是否需要确认的判断）。 */
export type GhostInstallConsentInitiator = 'user' | 'agent';

/** 安装包从哪里来（只决定确认卡的来源说明）。 */
export type GhostInstallConsentOrigin = 'market' | 'custom-market' | 'local-file' | 'forge';

export type GhostInstallConsentFacts =
  | {
      kind: 'install';
      ghostId: string;
      name: string;
      version: string;
      /** 插件声明的全部权限（不含 Agent 工具）。 */
      permissions: GhostPermissionItem[];
    }
  | {
      kind: 'update';
      ghostId: string;
      name: string;
      version: string;
      previousVersion: string;
      /** 相对当前已装版本新增或变化的权限。 */
      added: GhostPermissionItem[];
      /** 相对当前已装版本移除或变化前的权限。 */
      removed: GhostPermissionItem[];
      /** 未变化的权限条数（确认卡折叠展示）。 */
      unchangedCount: number;
      /** 同一凭证的内置 OAuth 客户端身份变化，可能需要重新授权。 */
      builtinOauthClientChanged: boolean;
    };

/** Main 投给确认界面的一次确认请求。 */
export interface GhostInstallConsentRequest {
  requestId: string;
  initiator: GhostInstallConsentInitiator;
  origin: GhostInstallConsentOrigin;
  /** 自定义市场名称（用户添加来源时起的名字，按原样展示）。 */
  originLabel?: string;
  facts: GhostInstallConsentFacts;
}

/** 与插件详情页「权限」区同口径：Agent 工具不算权限。 */
export function ghostConsentPermissionItems(manifest: GhostManifest): GhostPermissionItem[] {
  return ghostPermissionItems(manifest).filter((item) => item.kind !== 'tool');
}

function withoutTools(items: readonly GhostPermissionItem[]): GhostPermissionItem[] {
  return items.filter((item) => item.kind !== 'tool');
}

/**
 * 计算把 `next` 装到当前受体上需要用户确认的事实；返回 null 表示无需确认。
 *
 * - 没有已装版本：首次安装，始终需要确认。
 * - 已装版本批准态正常：按权限 diff 判断，只有新增／变化或 OAuth 客户端变化才需要。
 * - 已装版本没有有效批准基线：无法证明旧权限面，按全部权限都是新增处理。
 */
export function evaluateGhostInstallConsent(
  installed: InstalledGhost | null | undefined,
  next: GhostManifest,
): GhostInstallConsentFacts | null {
  if (!installed) {
    return {
      kind: 'install',
      ghostId: next.id,
      name: next.name,
      version: next.version,
      permissions: ghostConsentPermissionItems(next),
    };
  }
  const diff = diffInstalledGhostPermissionItems(installed, next);
  const added = withoutTools(diff.added);
  if (added.length === 0 && !diff.builtinOauthClientChanged) return null;
  return {
    kind: 'update',
    ghostId: next.id,
    name: next.name,
    version: next.version,
    previousVersion: installed.manifest.version,
    added,
    removed: withoutTools(diff.removed),
    unchangedCount: withoutTools(diff.unchanged).length,
    builtinOauthClientChanged: diff.builtinOauthClientChanged,
  };
}

/** 更新是否会扩大权限（插件页据此把更新标成「需确认新权限」）。 */
export function ghostUpdateNeedsConsent(installed: InstalledGhost, next: GhostManifest): boolean {
  return evaluateGhostInstallConsent(installed, next) !== null;
}

/** 确认时所对照的已装受体 receipt；首装没有受体，记 null。 */
export function ghostInstallConsentReceiverIdentity(
  installed: InstalledGhost | null | undefined,
): string | null {
  return installed ? ghostInstallApprovalToken(installed.approval) : null;
}

/**
 * 一次确认的规范化指纹。Main 在确认前按它记下用户看到的内容、当时的包摘要，
 * 以及所对照的已装受体 receipt。落位前在安装锁内用真实包、当前受体与现读摘要重算；
 * 候选包字节被换、或受体被另一份同 version／同权限投影的安装换掉，都不能沿用这次确认。
 */
export function ghostInstallConsentKey(
  facts: GhostInstallConsentFacts,
  packageSha256: string,
  receiverApprovalToken: string | null,
): string {
  const items = facts.kind === 'install' ? facts.permissions : facts.added;
  return JSON.stringify([
    facts.kind,
    facts.ghostId,
    facts.version,
    facts.kind === 'update' ? facts.previousVersion : null,
    items.map(ghostPermissionProjectionKey).sort(),
    facts.kind === 'update' ? facts.builtinOauthClientChanged : false,
    packageSha256,
    receiverApprovalToken,
  ]);
}
