import { ipcMain } from 'electron';
import { getDbClient } from '../client/current.js';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { createLogger } from '../../logger.js';
import { createRightSidebarTabsService } from './rightSidebarTabsService.js';
export type { TabRow } from './rightSidebarTabsService.js';
const log = createLogger('rightSidebarTabs');
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
