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
