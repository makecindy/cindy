import { addOrFocusSingletonTab, ensureHydrated } from '../store';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';

/** Preserve the user's existing attached/detached sidebar choice. */
export async function openRoutinesTab(sessionId: string, botId: string): Promise<void> {
  const route = await routeSidebarCommand({ type: 'open-routines-tab', sessionId, botId });
  if (route === 'attached') {
    await ensureHydrated(sessionId);
    await addOrFocusSingletonTab(sessionId, 'routines', { botId });
  }
  if (route === 'attached' || route === 'routed')
    requestRightSidebarVisibility('open', { sessionId });
}
