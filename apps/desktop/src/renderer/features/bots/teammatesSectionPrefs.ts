import {
  readSidebarOwnerStorage,
  sidebarOwnerStorageKey,
  writeSidebarOwnerStorage,
} from '@/lib/sidebarOwnerStorage';

/**
 * 侧栏「伙伴」段的收起状态,按账号存在本机。默认展开:只有用户点过收起才写入
 * override(`collapsed`);再次展开时写回 `expanded`,不复制默认值以外的状态。
 */
const KEY = 'sidebar.teammatesSection.v1';

export function readTeammatesSectionCollapsed(ownerId: string | null): boolean {
  return readSidebarOwnerStorage(KEY, ownerId) === 'collapsed';
}

export function writeTeammatesSectionCollapsed(ownerId: string | null, collapsed: boolean): void {
  writeSidebarOwnerStorage(KEY, ownerId, collapsed ? 'collapsed' : 'expanded');
}

export type TeammatesViewMode = 'icons' | 'list';
const VIEW_KEY = 'sidebar.teammatesView.v1';

export function readTeammatesViewMode(ownerId: string | null): TeammatesViewMode {
  return readSidebarOwnerStorage(VIEW_KEY, ownerId) === 'icons' ? 'icons' : 'list';
}

export function writeTeammatesViewMode(ownerId: string | null, mode: TeammatesViewMode): void {
  writeSidebarOwnerStorage(VIEW_KEY, ownerId, mode);
}

const COLLAPSED_AVATARS_KEY = 'sidebar.teammatesCollapsedAvatars.v1';

export function readCollapsedTeammateAvatars(ownerId: string | null): boolean {
  return readSidebarOwnerStorage(COLLAPSED_AVATARS_KEY, ownerId) === 'true';
}

export function writeCollapsedTeammateAvatars(ownerId: string | null, enabled: boolean): void {
  writeSidebarOwnerStorage(COLLAPSED_AVATARS_KEY, ownerId, String(enabled));
}

const HIDDEN_REMOTE_BOTS_KEY = 'sidebar.hiddenRemoteBots.v1';

export function readHiddenRemoteBotKeys(ownerId: string | null): string[] {
  const raw = readSidebarOwnerStorage(HIDDEN_REMOTE_BOTS_KEY, ownerId);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === 'string' && item.length > 0))];
  } catch {
    return [];
  }
}

export function writeHiddenRemoteBotKeys(ownerId: string | null, keys: readonly string[]): void {
  const unique = [...new Set(keys.filter((item) => typeof item === 'string' && item.length > 0))];
  writeSidebarOwnerStorage(HIDDEN_REMOTE_BOTS_KEY, ownerId, JSON.stringify(unique));
}

export function isHiddenRemoteBotsStorageEvent(event: StorageEvent, ownerId: string | null): boolean {
  return Boolean(ownerId) && (event.key === null || event.key === sidebarOwnerStorageKey(HIDDEN_REMOTE_BOTS_KEY, ownerId!));
}
