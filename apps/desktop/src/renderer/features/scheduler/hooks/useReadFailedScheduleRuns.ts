import { useEffect } from 'react';
import { isWindowVisiblyFocused, useWindowVisible } from '@/hooks/useWindowVisible';
import { createLogger } from '@/lib/logger';
import { markScheduleRunsReadAndSync } from '../lib/scheduleRunReadSync';

const log = createLogger('ReadFailedScheduleRuns');

/** 打开任务即确认失败已读，与通用横幅或具体错误的显示无关。 */
export function useReadFailedScheduleRuns(runIds: readonly string[], viewVisible: boolean) {
  const windowVisible = useWindowVisible(viewVisible);
  // 侧栏重查会重建数组；同一批记录的刷新不应循环重试失败的已读请求。
  const runIdsKey = JSON.stringify([...runIds].sort());

  useEffect(() => {
    if (!viewVisible || !windowVisible || !isWindowVisiblyFocused() || runIdsKey === '[]') return;
    const seenRunIds: string[] = JSON.parse(runIdsKey);
    // 只确认当前快照；已读状态不决定错误提示是否显示。
    void markScheduleRunsReadAndSync(seenRunIds)
      .then(({ failed }) => {
        if (failed.length > 0) log.warn('Could not mark seen runs read', { count: failed.length });
      })
      .catch(() => log.warn('Could not sync seen runs'));
  }, [runIdsKey, viewVisible, windowVisible]);
}
