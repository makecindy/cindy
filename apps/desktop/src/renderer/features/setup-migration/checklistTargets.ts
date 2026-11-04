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
      return '/skillhub/local';
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

export function openChecklistRoute(item: SetupMigrationChecklistItem): void {
  window.location.hash = checklistRoute(item);
}

/** Display names for presence-only hints; ids come from the other computer. */
export const BUILTIN_KEY_NAMES: Readonly<Record<string, string>> = BUILTIN_SECRET_NAMES;
