import { semverCompare } from '../versionUtils';

/**
 * deriveDetailState — 从 entry + server info 派生三个独立维度的 UI 状态。
 *
 * 三维度模型:
 *   D1 origin     — 本地来源（installed/published/learned/imported），决定是否显示卸载
 *   D2 isMine     — 管理权（server 权威），决定发布相关操作
 *   D3 version    — 远程版本状态，决定已安装/更新按钮
 *
 * Server 是归属的唯一权威，本地不做 authorId 猜测。
 */

export interface DetailState {
  /** null = 无 registryEntry（纯本地手写 skill）。'learned' = /learn 蒸馏产物,
   *  'imported' = 本地 zip/SKILL.md 导入。按钮语义见 deriveDetailActionState。 */
  origin: 'installed' | 'published' | 'learned' | 'imported' | null;
  /** server 确认的管理权。null = server 不可用（404/error/loading） */
  isMine: boolean | null;
  /** registryEntry 里记录的本地版本。null = 无 registryEntry */
  localVersion: string | null;
  /** server 上最新版本。null = server 不可用或市场上不存在 */
  latestVersion: string | null;
  /** server 显式返回 404（skill 已从市场删除） */
  marketDeleted: boolean;
  /** 作者显示名（foreign skills 用） */
  authorName: string;
}

export type DetailActionStatus =
  | { kind: 'none' }
  | { kind: 'published-tag'; version: string }
  | { kind: 'installed-tag'; version: string }
  | { kind: 'publish-new-version' }
  | { kind: 'publish-to-market' }
  | { kind: 'update'; latestVersion: string };

export interface DetailActionState {
  showUninstall: boolean;
  status: DetailActionStatus;
  isOutdated: boolean;
  isMineDirty: boolean;
  showForeignDirtyBanner: boolean;
}

/**
 * 入口函数。null entry / 非 skill → 返回 null（不渲染按钮区）。
 */
export function deriveDetailState(
  entry: SkillhubSkill | null,
  infoResult: SkillhubInfoResult | null,
  marketDeleted: boolean,
): DetailState | null {
  if (!entry || entry.kind !== 'skill') return null;

  const reg = entry.registryEntry;

  // 无 registryEntry：纯本地手写 skill
  if (!reg) {
    return {
      origin: null,
      isMine: infoResult?.isMine ?? null,
      localVersion: null,
      latestVersion: infoResult?.latestVersion ?? null,
      marketDeleted,
      authorName: infoResult?.authorName ?? '',
    };
  }

  // 有 registryEntry
  // origin 推断：显式字段 > server isMine=false 推断为 installed > null（未知不展示卸载）
  const explicitOrigin = reg.origin ?? null;

  if (!infoResult) {
    return {
      origin: explicitOrigin,
      isMine: null,
      localVersion: reg.version,
      latestVersion: null,
      marketDeleted,
      authorName: '',
    };
  }

  const origin = explicitOrigin ?? (infoResult.isMine === false ? 'installed' : null);

  return {
    origin,
    isMine: infoResult.isMine,
    localVersion: reg.version,
    latestVersion: infoResult.latestVersion ?? null,
    marketDeleted: false,
    authorName: infoResult.authorName ?? '',
  };
}

function hasLocalChanges(registryEntry: StoredInstall | null | undefined, localFolderHash: string | null): boolean {
  return !!(
    registryEntry != null &&
    typeof registryEntry.folderHash === 'string' &&
    localFolderHash !== null &&
    localFolderHash !== registryEntry.folderHash
  );
}

/**
 * 从 DetailState 派生互斥的按钮/标签状态。
 *
 * Priority: server authority > local registry > fallback defaults.
 * - server authority: latestVersion/isMine/marketDeleted 决定市场是否存在、归属、更新。
 * - local registry: 只在 server 未确认存在时兜底显示本地安装状态/卸载入口。
 * - fallback defaults: server 不可用且本地也无法证明时,不主动展示发布/更新动作。
 *
 * publish-to-market 只能在 latestVersion === null 的分支返回,因此 server 已确认
 * skill 存在时不会出现"已发布/已安装/更新"和"发布到市场"并存。
 */
export function deriveDetailActionState(
  detailState: DetailState | null,
  registryEntry: StoredInstall | null | undefined,
  localFolderHash: string | null,
  publishedStatus?: string | null,
): DetailActionState | null {
  if (!detailState) return null;

  const isOutdated = !!(
    detailState.localVersion !== null &&
    detailState.latestVersion !== null &&
    semverCompare(detailState.latestVersion, detailState.localVersion) > 0
  );
  const isLocalAhead = !!(
    detailState.localVersion !== null &&
    detailState.latestVersion !== null &&
    semverCompare(detailState.localVersion, detailState.latestVersion) > 0
  );
  const localChanged = hasLocalChanges(registryEntry, localFolderHash);
  const isMineDirty = !!(detailState.isMine === true && localChanged);
  const showForeignDirtyBanner = !!(
    detailState.origin === 'installed' &&
    detailState.localVersion !== null &&
    !detailState.marketDeleted &&
    detailState.isMine !== true &&
    localChanged
  );
  let status: DetailActionStatus = { kind: 'none' };

  if (detailState.isMine === true && publishedStatus === 'rejected') {
    status = { kind: 'publish-new-version' };
  } else if (isLocalAhead && detailState.isMine === true) {
    status = { kind: 'publish-new-version' };
  } else if (
    isOutdated &&
    detailState.latestVersion !== null &&
    detailState.isMine === true &&
    localChanged
  ) {
    status = { kind: 'publish-new-version' };
  } else if (isOutdated && detailState.latestVersion !== null && detailState.origin !== 'learned' && detailState.origin !== 'imported') {
    // learned / imported 不进市场更新路径:用市场包覆盖会丢掉本地创作 / 导入内容。
    status = { kind: 'update', latestVersion: detailState.latestVersion };
  } else if (detailState.latestVersion !== null) {
    // Server confirms the skill exists; never offer first-publish in this branch.
    if (
      (detailState.origin === 'learned' || detailState.origin === 'imported') &&
      detailState.isMine === true
    ) {
      // learned / imported 的 registry hash 对应本地内容,不是 server 已发布版本。
      // 即使 localChanged=false 也不能显示 published-tag;若用户确实拥有同名
      // 市场 skill,应走发布新版本路径。
      status = { kind: 'publish-new-version' };
    } else if (detailState.isMine === true) {
      status = isMineDirty
        ? { kind: 'publish-new-version' }
        : { kind: 'published-tag', version: detailState.latestVersion };
    } else if (detailState.origin === 'installed' && detailState.localVersion !== null) {
      status = { kind: 'installed-tag', version: detailState.localVersion };
    }
  } else if (detailState.marketDeleted || detailState.isMine === false) {
    // Server explicitly says "not found", or returns no record for this user.
    status = { kind: 'publish-to-market' };
  } else if (detailState.origin === 'installed' && detailState.localVersion !== null) {
    // Server unavailable: preserve the local installed signal, but do not invent market actions.
    status = { kind: 'installed-tag', version: detailState.localVersion };
  }

  return {
    showUninstall: detailState.origin === 'installed' || detailState.origin === 'imported',
    status,
    isOutdated,
    isMineDirty,
    showForeignDirtyBanner,
  };
}
