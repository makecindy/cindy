import type { PluginConfigurationItem, PluginConfigurationSummary } from '@cindy/device-link';
import type { GhostManifest, GhostSetupAssessment } from '../../shared/ghost.js';
import { evaluateGhostSetupAssessment, type GhostSetupProbes } from './ghostSetupStatus.js';

/** Project every declared item, including optional items omitted from the use gate. No values leave Host. */
export function mobilePluginConfiguration(
  manifest: GhostManifest,
  probes?: GhostSetupProbes,
  assessment?: GhostSetupAssessment,
): PluginConfigurationSummary {
  const items: PluginConfigurationItem[] = [];
  const add = (item: PluginConfigurationItem) => {
    if (!items.some((other) => other.id === item.id)) items.push(item);
  };
  const assessed = new Map(
    assessment?.groups.flatMap((group) => group.items.map((item) => [item.ref, item] as const)),
  );
  const stateFor = (
    kind: 'secret' | 'connection' | 'kv',
    key: string,
    label: string,
  ): PluginConfigurationItem['state'] => {
    if (!probes) {
      const state = assessed.get(`${kind}:${key}`)?.state;
      return state === 'satisfied' ? 'configured' : (state ?? 'unknown');
    }
    try {
      const checked = evaluateGhostSetupAssessment(
        {
          ...manifest,
          setup: { requires: [{ anyOf: [kind === 'kv' ? { kind, key, label } : { kind, key }] }] },
        },
        probes,
        { revision: 0 },
      );
      const state = checked.groups[0].items[0].state;
      return state === 'satisfied' ? 'configured' : state;
    } catch {
      return 'unknown';
    }
  };
  for (const secret of manifest.network?.secrets ?? []) {
    const managed = ['login-email', 'gh-cli', 'oidc-token'].includes(secret.source ?? 'user');
    const item: PluginConfigurationItem = {
      id: `secret:${secret.key}`,
      label: secret.label.slice(0, 160),
      ...(secret.hint ? { hint: secret.hint.slice(0, 512) } : {}),
      kind: managed ? 'managed' : secret.source === 'oauth' ? 'oauth' : 'secret',
      state: managed ? 'managed' : stateFor('secret', secret.key, secret.label),
    };
    if (item.kind === 'oauth' && probes && item.state !== 'unknown') {
      try {
        const accounts = probes.oauthStatus(secret.key);
        item.count = accounts.connected;
        item.expiredCount = accounts.expired;
      } catch {
        item.state = 'unknown';
      }
    }
    add(item);
  }
  for (const secret of manifest.node?.secretBindings ?? []) {
    if (secret.oauthSecret) continue; // Same network OAuth declaration; no duplicate row.
    add({
      id: `secret:${secret.key}`,
      kind: 'secret',
      label: secret.label.slice(0, 160),
      ...(secret.hint ? { hint: secret.hint.slice(0, 512) } : {}),
      state: stateFor('secret', secret.key, secret.label),
    });
  }
  for (const connection of manifest.network?.connections ?? []) {
    const item: PluginConfigurationItem = {
      id: `connection:${connection.key}`,
      kind: 'connection',
      label: connection.label.slice(0, 160),
      state: stateFor('connection', connection.key, connection.label),
    };
    if (probes && item.state !== 'unknown') {
      try {
        item.count = probes.connectionCount(connection.key);
      } catch {
        item.state = 'unknown';
      }
    }
    add(item);
  }
  for (const group of manifest.setup?.requires ?? [])
    for (const req of group.anyOf) {
      if (req.kind === 'kv')
        add({
          id: `kv:${req.key}`,
          kind: 'parameter',
          label: req.label.slice(0, 160),
          state: stateFor('kv', req.key, req.label),
        });
    }
  for (const group of assessment?.groups ?? [])
    for (const requirement of group.items) {
      if (requirement.kind === 'client_config')
        add({
          id: requirement.ref,
          kind: 'client',
          label: requirement.label.slice(0, 160),
          state: requirement.state === 'satisfied' ? 'configured' : requirement.state,
        });
    }
  return {
    items,
    alternatives: (assessment?.groups ?? []).flatMap((group) => {
      const ids = group.items
        .map((item) => item.ref)
        .filter((ref) => items.some((item) => item.id === ref));
      return ids.length > 1 ? [ids] : [];
    }),
  };
}
