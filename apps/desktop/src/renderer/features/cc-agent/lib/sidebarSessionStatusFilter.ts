import type { Session } from '@/lib/ccAgent.types';
import type { ListStatusFilter } from '@/lib/sessionService';

import type { FilterStatus } from '../hooks/useSidebarFilter';

/**
 * 本地会话跟随 useCCSessions 实际已落地的桶，避免切桶期间先闪空；device-link 远程镜像
 * 同时持有 active / archived 两桶，必须始终按用户当前选择筛选，不能被本地请求状态拖住。
 */
export function matchesSidebarSessionStatus(
  session: Pick<Session, 'status' | 'deviceLinkDeviceId'>,
  selectedStatus: FilterStatus,
  effectiveLocalStatus: ListStatusFilter,
): boolean {
  const desiredStatus =
    session.deviceLinkDeviceId || effectiveLocalStatus === 'all'
      ? selectedStatus
      : effectiveLocalStatus;
  return desiredStatus === 'all' || session.status === desiredStatus;
}
