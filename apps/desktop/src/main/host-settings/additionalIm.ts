import { app } from 'electron';
import { additionalSettingsSchema, type ImSettingsDomain, type SettingsEditableValue } from '../../shared/settingsEditableCatalog.js';
import type { HostSettingState } from '../../shared/hostSettings.js';
import { createHostImDefaultsStore, interpretHostImDefaults, inspectImDefaultSettings } from '../im/defaultSettingsStore.js';
import type { ImDefaultSettings, ImDefaultSettingsChannel } from '../../shared/imDefaultSettings.js';
import type { OverrideSettingsCommitOptions } from '../maker-host/override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { HostSettingsError } from './operations.js';

const channels = { imGlobal: null, imFeishu: 'feishu', imSlack: 'slack', imDiscord: 'discord', imWechat: 'wechat', imTelegram: 'telegram', imDingtalk: 'dingtalk', imWecom: 'wecom' } as const;
const agents = { claudeCode: 'claude-code', codex: 'codex', pi: 'pi' } as const;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
type Values = Record<string, SettingsEditableValue>;
type State = HostSettingState<Values>;
function project(domain: ImSettingsDomain, snapshot: ReturnType<ReturnType<typeof createHostImDefaultsStore>['inspect']>): State {
  if (snapshot.status !== 'ready') return snapshot;
  const channel = channels[domain];
  const document = interpretHostImDefaults(snapshot.value), defaults = interpretHostImDefaults({});
  const effective = channel ? document.channels[channel] : document.global;
  // This wire version only describes routes executed on this Host. Do not turn
  // a saved remote-Agent route into a local route by dropping its device binding.
  if (Object.values(effective.agents).some(route => route.agentDeviceId)) {
    return { status: 'unavailable', revision: null };
  }
  const scope = channel ? record(record(snapshot.value.channels)[channel]) : record(snapshot.value.global);
  const pick = (value: ImDefaultSettings, includeOptionalModelGroup: boolean): Values => {
    const out: Values = {};
    for (const key of Object.keys(additionalSettingsSchema(domain).shape)) {
      if (key === 'modelGroup') {
        if (includeOptionalModelGroup && value.modelGroup) out.modelGroup = value.modelGroup;
        continue;
      }
      const agent = agents[key as keyof typeof agents];
      const route = agent ? value.agents[agent] : null;
      out[key] = route
        ? { providerId: route.providerId, modelId: route.model, effort: route.effort }
        : value[key as 'agentKind' | 'permissionMode' | 'groupPermissionMode'];
    }
    return out;
  };
  const customizedKeys = Object.keys(additionalSettingsSchema(domain).shape).filter(key => {
    const agent = agents[key as keyof typeof agents];
    if (key === 'modelGroup') return Object.hasOwn(scope, 'modelGroup') && Boolean(scope.modelGroup);
    return agent ? Object.hasOwn(record(scope.agents), agent) : Object.hasOwn(scope, key) || key === 'groupPermissionMode' && Object.hasOwn(scope, 'groupCtrPermissionMode');
  });
  return {
    ...snapshot,
    value: pick(effective, true),
    defaults: pick(channel ? defaults.channels[channel] : defaults.global, false),
    customizedKeys,
    isCustomized: customizedKeys.length > 0,
  };
}
export function inspectImSettings(domain: ImSettingsDomain): State {
  try {
    const passive = inspectImDefaultSettings(ownerScopedUserDataPath(), app.getPath('userData'));
    if (passive.status !== 'ready' || passive.legacy) return { status: 'unavailable', revision: null };
    return project(domain, createHostImDefaultsStore().inspect());
  } catch { return { status: 'unreadable', revision: null }; }
}
export async function commitImSettings(domain: ImSettingsDomain, change: { set: Values; clear: string[] }, options: OverrideSettingsCommitOptions): Promise<State & { status: 'ready' }> {
  const routeChannel = channels[domain];
  // As on the settings page: before a channel's route default changes, older tasks still on the
  // old default get their follow records; a failed backfill blocks the save.
  if (routeChannel && [...Object.keys(change.set), ...change.clear].some(key => key === 'agentKind' || key === 'modelGroup' || Object.hasOwn(agents, key))) {
    const { prepareImDefaultSettingsChange } = await import('../im/index.js');
    try { await prepareImDefaultSettingsChange(routeChannel); }
    catch { throw new HostSettingsError('SAVE_FAILED'); }
    options.assertCurrent?.();
  }
  const store = createHostImDefaultsStore();
  const result = await store.commitAtomic(state => {
    if (inspectImSettings(domain).status !== 'ready') throw new HostSettingsError('UNREADABLE');
    const channel: ImDefaultSettingsChannel | null = channels[domain];
    const raw = structuredClone(state.value);
    const scopes = record(raw.channels);
    const scope = channel ? record(scopes[channel]) : record(raw.global);
    const routes = record(scope.agents);
    for (const key of change.clear) {
      const agent = agents[key as keyof typeof agents];
      if (agent) delete routes[agent]; else delete scope[key];
      if (key === 'groupPermissionMode') delete scope.groupCtrPermissionMode;
    }
    const touchesConcreteRoute = Object.keys(change.set).some(key => key === 'agentKind' || Object.hasOwn(agents, key));
    if (touchesConcreteRoute && !Object.hasOwn(change.set, 'modelGroup')) {
      delete scope.modelGroup;
    }
    for (const [key, value] of Object.entries(change.set)) {
      if (key === 'modelGroup') {
        if (typeof value === 'string' && value.trim()) scope.modelGroup = value.trim();
        else delete scope.modelGroup;
        continue;
      }
      const agent = agents[key as keyof typeof agents];
      if (agent) { const route = value as Values; routes[agent] = { providerId: route.providerId, model: route.modelId, effort: route.effort }; }
      else scope[key] = value;
    }
    if (Object.keys(routes).length) scope.agents = routes; else delete scope.agents;
    if (channel) {
      if (Object.keys(scope).length) scopes[channel] = scope; else delete scopes[channel];
      if (Object.keys(scopes).length) raw.channels = scopes; else delete raw.channels;
    } else { if (Object.keys(scope).length) raw.global = scope; else delete raw.global; }
    // Existing v2 root mirrors are derived from global, never independent settings.
    delete raw.agentKind; delete raw.agents;
    if (!Object.keys(record(raw.global)).length) delete raw.global;
    if (!Object.keys(record(raw.channels)).length) delete raw.channels;
    const customized = !!raw.global || !!raw.channels;
    if (customized) { raw.schemaVersion = 3; raw.global ??= {}; } else delete raw.schemaVersion;
    const next = interpretHostImDefaults(raw);
    if (customized) { raw.agentKind = next.global.agentKind; raw.agents = next.global.agents; }
    if (channel === 'wechat') {
      const value = next.channels.wechat;
      if (value.agentKind === 'pi' || ['acceptEdits', 'bypassPermissions'].includes(value.permissionMode)) throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
    }
    return { set: raw, clear: Object.keys(state.value).filter(key => !Object.hasOwn(raw, key)) };
  }, options);
  return project(domain, result) as State & { status: 'ready' };
}
