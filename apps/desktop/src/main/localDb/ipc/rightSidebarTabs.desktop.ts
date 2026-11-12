import { ipcMain } from 'electron';
import { getDbClient } from '../client/current.js';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { createLogger } from '../../logger.js';
import { createRightSidebarTabsService } from './rightSidebarTabs.js';
export type { TabRow } from './rightSidebarTabs.js';
const log = createLogger('rightSidebarTabs');
/**
 * 变更广播：同一任务的页签可能同时出现在主窗侧栏与单页签窗口，各 Renderer
 * 有独立缓存。写入后通知其它 Renderer 按数据库刷新；发起方由 sender id 排除。
 * bootstrap 注入实际的窗口广播实现；未注入（单测）时静默。
 */
type RightSidebarTabsChangeBroadcaster = (sessionId: string, senderWebContentsId: number) => void;
let changeBroadcaster: RightSidebarTabsChangeBroadcaster | null = null;
export function setRightSidebarTabsChangeBroadcaster(broadcaster: RightSidebarTabsChangeBroadcaster | null): void {
  changeBroadcaster = broadcaster;
}
export function registerRightSidebarTabsIpc(): void {
  for (const action of ['list', 'ensure-singleton', 'upsert', 'close', 'setActive', 'reorder'] as const) {
    ipcMain.handle(`local-db:right-sidebar-tabs:${action}`, async (event, payload: unknown) => {
      assertTrustedAppRendererEvent(event);
      const service = createRightSidebarTabsService({
        getDb: () => getDbClient().drizzle,
        changed: sessionId => {
          try { changeBroadcaster?.(sessionId, event.sender?.id ?? -1); }
          catch (err) { log.warn('right sidebar tabs change broadcast failed', { sessionId, err }); }
        },
      });
      return service[action](payload);
    });
  }
  log.info('rightSidebarTabs IPC handlers registered');
}
