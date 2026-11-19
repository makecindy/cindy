import {
  parseBuddySets,
  serializeBuddySets,
  normalizeBuddySets,
  type BuddySetsState,
} from '@cindy/maker-shared/buddy-sets';
import { readSidebarOwnerStorage, writeSidebarOwnerStorage } from '@/lib/sidebarOwnerStorage';

/**
 * 「伙伴集」是纯本机展示偏好:按账号存在本机,不进数据库、不进伙伴资料、不跨电脑同步。
 * 只持久化用户 override —— 空状态写空串,不把默认配置复制进用户配置
 * (docs/dev-rules/configuration-and-overrides.md §2)。
 */
const BUDDY_SETS_KEY = 'sidebar.buddySets.v1';

export function readBuddySets(ownerId: string | null): BuddySetsState {
  return parseBuddySets(readSidebarOwnerStorage(BUDDY_SETS_KEY, ownerId));
}

export function writeBuddySets(ownerId: string | null, state: BuddySetsState): void {
  // normalizeBuddySets 保证「一个伙伴只进一个集」,序列化前统一收口。
  writeSidebarOwnerStorage(BUDDY_SETS_KEY, ownerId, serializeBuddySets(normalizeBuddySets(state)));
}
