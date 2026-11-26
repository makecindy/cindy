import {
  listMcpManagement,
  listMemoryManagement,
} from './managementData.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { peekCommittedAuthIdentity } from '../authManager.js';
import type { SettingsWebEnvelope } from '../../shared/settingsWeb.js';
import { getCloudSettingsSnapshotContext } from './snapshotRuntime.js';
import { createSettingsManagement } from './management.js';
import { listPersonalBotManagement } from './managementConnections.js';
import { listOfficialBotManagement, listWechatManagement } from './managementBots.js';
import { listBotNotificationManagement } from './managementNotifications.js';
import { listProviderManagement } from './managementProviders.js';

const management = createSettingsManagement({
  async list(section, caller) {
    // Smart Contacts live in the cindy-contacts plugin; its section stays empty.
    if (section === 'mcp') return listMcpManagement(caller);
    if (section === 'memory') return listMemoryManagement(caller);
    if (section === 'providers') return listProviderManagement(caller);
    if (section === 'bots') {
      const identity = peekCommittedAuthIdentity();
      const cnPersonal =
        CURRENT_CINDY_REGION !== 'global' && identity?.membershipKind === 'personal';
      const personal = await listPersonalBotManagement(
        caller,
        (id) => !cnPersonal || !['discord', 'telegram'].includes(id),
        CURRENT_CINDY_REGION === 'global' || identity?.membershipKind === 'org',
      );
      return [
        ...listWechatManagement(caller),
        ...personal,
        ...(await listBotNotificationManagement(caller, (id) => !cnPersonal || id !== 'discord')),
        ...(!cnPersonal ? listOfficialBotManagement(caller) : []),
      ];
    }
    return [];
  },
});

/** Entry is reachable only from the authenticated cloud Host web transport. */
export async function executeCloudManagement(
  request: SettingsWebEnvelope,
  assertRequest: () => void,
) {
  assertRequest();
  const context = getCloudSettingsSnapshotContext();
  if (!context || request.command.kind !== 'manage') throw new Error('MANAGEMENT_UNAVAILABLE');
  const key = JSON.stringify([
    context.scopeKey,
    context.baseUrl,
    request.runtimeId,
    request.sessionKey,
  ]);
  const assertCurrent = () => {
    const fresh = getCloudSettingsSnapshotContext();
    if (!fresh || fresh.scopeKey !== context.scopeKey || fresh.baseUrl !== context.baseUrl)
      throw new Error('MANAGEMENT_OWNER_CHANGED');
  };
  return management.execute({ key, assertCurrent }, request.command.command);
}
export function startCloudManagementMaintenance(): () => void {
  const timer = setInterval(() => management.prune(), 2000);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    management.stop();
  };
}
