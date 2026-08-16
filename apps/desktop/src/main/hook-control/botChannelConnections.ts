import type { SlackHookView } from '../../shared/hookControlIpc.js';
import {
  botChannelFeatureCapabilitiesFor,
  RELAY_BOT_CHANNEL_FEATURES,
  type BotChannelConnection,
} from '../../shared/botChannelRegistry.js';

/** Convert the authenticated relay snapshot into concrete Bot-mount identities. */
export function hookViewToBotChannelConnections(view: SlackHookView): BotChannelConnection[] {
  const rows: BotChannelConnection[] = [];
  for (const binding of view.bindings) {
    if (binding.displaced || !binding.teamId.trim()) continue;
    rows.push({
      id: `relay:slack:${binding.teamId}`,
      kind: 'slack',
      ownership: 'server-relay',
      status: view.status,
      connected: view.enabled && view.status === 'connected',
      accountKey: binding.teamId,
      accountName: binding.teamName,
      scopeKey: binding.teamId,
      routable: true,
      features: [...(RELAY_BOT_CHANNEL_FEATURES.slack ?? [])],
      featureCapabilities: botChannelFeatureCapabilitiesFor('slack', 'server-relay'),
    });
  }

  const telegramBinding = view.telegram.binding;
  const telegramAccountKey = telegramBinding?.scopeId?.trim() ?? '';
  if (telegramBinding?.state === 'confirmed' && telegramAccountKey) {
    rows.push({
      id: `relay:telegram:${telegramBinding.bindingId ?? telegramAccountKey}`,
      kind: 'telegram',
      ownership: 'server-relay',
      status: view.telegram.status,
      connected:
        view.telegram.enabled && view.telegram.available && view.telegram.status === 'connected',
      accountKey: telegramAccountKey,
      accountName: telegramBinding.scopeName,
      scopeKey: telegramBinding.scopeId,
      routable: true,
      features: [...(RELAY_BOT_CHANNEL_FEATURES.telegram ?? [])],
      featureCapabilities: botChannelFeatureCapabilitiesFor('telegram', 'server-relay'),
    });
  }
  return rows;
}
