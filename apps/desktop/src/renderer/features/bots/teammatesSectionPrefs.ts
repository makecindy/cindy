import { readSidebarOwnerStorage, writeSidebarOwnerStorage } from '@/lib/sidebarOwnerStorage';

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

const FOLDERS_KEY = 'sidebar.teammatesFolders.v1';

export interface TeammateFolder {
  id: string;
  name: string;
  collapsed: boolean;
  members: string[];
}

export interface TeammateFolders {
  folders: TeammateFolder[];
  unfiled: string[];
}

export function readTeammateFolders(ownerId: string | null): TeammateFolders {
  const empty = { folders: [], unfiled: [] };
  const raw = readSidebarOwnerStorage(FOLDERS_KEY, ownerId);
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw) as Partial<TeammateFolders> | null;
    if (!value || !Array.isArray(value.folders) || !Array.isArray(value.unfiled)) return empty;
    const folderIds = new Set<string>();
    const assigned = new Set<string>();
    const uniqueKeys = (keys: unknown[]) => keys.filter((key): key is string => {
      if (typeof key !== 'string' || assigned.has(key)) return false;
      assigned.add(key);
      return true;
    });
    const folders = value.folders.flatMap(folder => {
      if (!folder || typeof folder.id !== 'string' || folderIds.has(folder.id)
        || typeof folder.name !== 'string' || !folder.name.trim() || !Array.isArray(folder.members)) return [];
      folderIds.add(folder.id);
      return [{ id: folder.id, name: folder.name, collapsed: folder.collapsed === true, members: uniqueKeys(folder.members) }];
    });
    return { folders, unfiled: uniqueKeys(value.unfiled) };
  } catch {
    return empty;
  }
}

export function writeTeammateFolders(ownerId: string | null, value: TeammateFolders): boolean {
  return writeSidebarOwnerStorage(FOLDERS_KEY, ownerId, JSON.stringify(value));
}
