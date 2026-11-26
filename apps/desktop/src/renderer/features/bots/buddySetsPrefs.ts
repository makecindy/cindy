import {
  parseBuddySets,
  serializeBuddySets,
  normalizeBuddySets,
  emptyBuddySets,
  type BuddySetsState,
} from '@cindy/maker-shared/buddy-sets';
import {
  readScopedSidebarOwnerStorage,
  sidebarOwnerStorageKey,
  writeSidebarOwnerStorage,
  type SidebarOwnerStorageReadStatus,
} from '@/lib/sidebarOwnerStorage';

/**
 * 「伙伴集」是纯本机展示偏好:按账号存在本机,不进数据库、不进伙伴资料、不跨电脑同步。
 * 只持久化用户 override —— 空状态写空串,不把默认配置复制进用户配置
 * (docs/dev-rules/configuration-and-overrides.md §2)。
 */
const BUDDY_SETS_KEY = 'sidebar.buddySets.v1';

export interface BuddySetsReadResult {
  status: SidebarOwnerStorageReadStatus;
  /** Only a confirmed, readable record owns this state; failures return the derived default. */
  state: BuddySetsState;
}

export function buddySetsStorageKey(ownerId: string): string {
  return sidebarOwnerStorageKey(BUDDY_SETS_KEY, ownerId);
}

export function readBuddySetsResult(ownerId: string | null): BuddySetsReadResult {
  const result = readScopedSidebarOwnerStorage(BUDDY_SETS_KEY, ownerId);
  return {
    status: result.status,
    state: result.status === 'ready' ? parseBuddySets(result.value) : emptyBuddySets(),
  };
}

export function readBuddySets(ownerId: string | null): BuddySetsState {
  return readBuddySetsResult(ownerId).state;
}

/** Returns true only after the owner-scoped record was committed. */
export function writeBuddySets(ownerId: string | null, state: BuddySetsState): boolean {
  // normalizeBuddySets 保证「一个伙伴只进一个集」,序列化前统一收口。
  return writeSidebarOwnerStorage(
    BUDDY_SETS_KEY,
    ownerId,
    serializeBuddySets(normalizeBuddySets(state)),
  );
}
