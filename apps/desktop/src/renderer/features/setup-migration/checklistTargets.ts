/**
 * Where each one-time setup item is done on this computer. Routes reuse the existing
 * Settings tabs; nothing here performs the setup itself.
 */
import { BUILTIN_SECRET_NAMES, type SetupMigrationChecklistItem } from '../../../shared/setupMigration';

const BUILTIN_KEY_TABS: Record<string, string> = {
  brave: 'builtin-tools',
  tavily: 'builtin-tools',
  'voice-asr': 'voice-input',
};

export function checklistRoute(item: SetupMigrationChecklistItem): string {
  switch (item.kind) {
    case 'plugin-setup':
      return item.ref ? `/settings?tab=ghosts&ghost=${encodeURIComponent(item.ref)}` : '/settings?tab=ghosts';
    case 'plugin-manual':
    case 'market-source':
      return '/settings?tab=ghosts';
    case 'skill-manual':
      return '/skillhub/local?tab=local';
    case 'provider-key':
    case 'provider-connection':
    case 'provider-sign-in':
    case 'local-model':
      return '/settings?tab=providers';
    case 'mcp-token':
      return '/settings?tab=builtin-tools';
    case 'builtin-key':
      return `/settings?tab=${BUILTIN_KEY_TABS[item.ref ?? ''] ?? 'providers'}`;
    case 'im-channel':
      return '/settings?tab=im-bot&imGroup=personal';
    case 'computer-use':
      return '/settings?tab=computer-use';
    case 'remote-desktop':
    case 'ssh':
    case 'ssh-host':
      return '/settings?tab=remote-control';
    default:
      return '/settings';
  }
}

export async function openChecklistRoute(item: SetupMigrationChecklistItem): Promise<void> {
  // The global migration host lives outside RouterProvider. Read the app router on
  // demand to avoid an eager cycle through its Settings route and this checklist.
  const { router } = await import('@/router');
  const target = checklistRoute(item);
  const { pathname, search, hash } = router.state.location;
  // Reopen even at the same URL: saved tab/search state must not override the
  // explicit destination, and repeated steps should not add browser-Back stops.
  await router.navigate(target, { replace: target === `${pathname}${search}${hash}`, state: null });
}

/** Display names for presence-only hints; ids come from the other computer. */
export const BUILTIN_KEY_NAMES: Readonly<Record<string, string>> = BUILTIN_SECRET_NAMES;
