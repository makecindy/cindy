import path from 'node:path';
import { AppShortcutStore, APP_SHORTCUTS_FILE_NAME } from '../../app-shortcuts/AppShortcutStore.js';
import { inspectVoiceInputSettings } from '../../voice-input/VoiceInputDataStore.js';
import { inspectVoiceInputModelSelection } from '../../voice-input/VoiceInputModelSelection.js';
import { inspectWorkLouderSettings } from '../../worklouder-codex/settingsStore.js';
import { inspectXboxGamepadSettings } from '../../xbox-gamepad/settingsStore.js';
import { inspectImDefaultSettings } from '../../im/defaultSettingsStore.js';
import { inspectTelegramBehavior, inspectTelegramPersona } from '../../im/telegram/behaviorStore.js';
import { inspectOfficialHookSettings, DEFAULT_SLACK_LIFECYCLE_ANNOUNCEMENT } from '../../hook-control/store.js';
import { SettingsReader } from '../../maker-host/plugins/settings-reader.js';
import { DEFAULT_DISABLED_PLUGIN_IDS } from '../../maker-host/plugins/types.js';
import { inspectBrowserBackendSettings } from '../../browser-backend-settings-store.desktop.js';
import { inspectAndroidAutomationSettings } from '../../android-automation-settings-store.js';
import { APP_SHORTCUT_DEFINITIONS, getEffectiveAppShortcuts, isAppShortcutAvailableOnPlatform } from '../../../shared/appShortcuts.js';
import { IM_DEFAULT_SETTINGS_CHANNELS } from '../../../shared/imDefaultSettings.js';
import { WORKLOUDER_MODELS, WORKLOUDER_CODEX_COMMAND_SLOTS, WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS, WORKLOUDER_CODEX_AGENT_SLOT_COUNT, WORKLOUDER_CODEX_ANALOG_DIRECTIONS, WORKLOUDER_CODEX_ENCODER_ACTIONS, type WorkLouderCodexAction } from '../../../shared/workLouderCodex.js';
import { GAMEPAD_FAMILIES, XBOX_GAMEPAD_BUTTON_IDS, XBOX_GAMEPAD_STICK_IDS, XBOX_GAMEPAD_STICK_DIRECTIONS } from '../../../shared/xboxGamepad.js';
import { SETTINGS_READ_KEY_CODES, SETTINGS_READ_FIELD_IDS } from '../../../shared/settingsReadCatalog.js';
import { settingsHasPath, isSettingsRecord } from '../../maker-host/inspect-settings-json.js';
import { inspectedValue, type ReadonlySettingsInspection, type ReadonlySettingSource } from '../readTypes.js';

export interface InteractionInspectionOptions {
  platform?: NodeJS.Platform;
  userDataPath: string;
  ownerRoot: string;
  ownerId: string;
  mode: 'local' | 'cloud';
  /** Already verified in-memory hook account identity; never read authentication here. */
  officialAccountFingerprint?: string | null;
}

/** Content-bearing bindings are reduced before they enter the settings projection. */
export function inspectHardwareAction(action: WorkLouderCodexAction | null) {
  if (action === null) return null;
  switch (action.type) {
    case 'command': return { type: action.type, commandId: action.commandId };
    case 'keycap': return { type: action.type, keycapId: action.keycapId };
    case 'voice': return { type: action.type };
    default: return { type: action.type, configured: true };
  }
}
const has = (raw: unknown, ...segments: (string | number)[]) => settingsHasPath(raw, segments);
const keyCodes: ReadonlySet<string> = new Set(SETTINGS_READ_KEY_CODES);
/** Explicit reader ownership; the shared auxiliary-chain reader owns voice.refinerChain. */
export const INTERACTION_SETTINGS_FIELD_IDS = SETTINGS_READ_FIELD_IDS.filter(id =>
  id !== 'voice.refinerChain' && ['voice.', 'im.', 'shortcuts.', 'worklouder.', 'gamepad.', 'browser.', 'android.', 'computer.'].some(prefix => id.startsWith(prefix)));

/** Fresh saved preferences only. No devices, provider runtime, secret getters or legacy claims. */
export function inspectInteractionSettings(options: InteractionInspectionOptions): ReadonlySettingsInspection {
  const platform = options.platform ?? process.platform;
  const fields: ReadonlySettingsInspection['fields'] = {};
  const put = (id: string, value: unknown, source: ReadonlySettingSource) => { fields[id] = inspectedValue(value, source); };
  const domain = (prefixes: string[], read: () => void) => {
    try { read(); } catch { for (const id of INTERACTION_SETTINGS_FIELD_IDS) if (prefixes.some(prefix => id.startsWith(prefix))) fields[id] = { status: 'unreadable' }; }
  };
  const fail = (prefixes: string[], status: 'unreadable' | 'unavailable' | 'migrationPending') => {
    for (const id of INTERACTION_SETTINGS_FIELD_IDS) if (prefixes.some(prefix => id.startsWith(prefix))) fields[id] = { status };
  };
  const voiceState: { shortcut: import('../../../shared/voiceInputData.js').VoiceInputShortcut | null } = { shortcut: null };
  domain(['voice.'], () => {
    const state = inspectVoiceInputSettings(options.ownerRoot, platform);
    const keys = ['language', 'muteSystemAudio', 'playInteractionSound', 'fastActivationEnabled', 'composerLongPressEnabled', 'refinementEnabled', 'autoDictionaryEnabled'] as const;
    const ids = [...keys, 'microphoneDeviceIdConfigured', 'refinementInstructionsConfigured', 'dictionarySyncEnabled', 'shortcutConfigured'];
    if (state.status !== 'ready') { for (const key of ids) fields[`voice.${key}`] = state; return; }
    // Existing voice files store full snapshots, not per-field intent.
    const source = (key: string): ReadonlySettingSource => has(state.raw, key) ? 'unknown' : 'default';
    for (const key of keys) put(`voice.${key}`, state.value[key], key === 'playInteractionSound' && has(state.raw, 'playStartSound') ? 'unknown' : source(key));
    const longPressOverride = state.raw.composerLongPressEnabledOverride;
    put('voice.composerLongPressEnabled', state.value.composerLongPressEnabled, typeof longPressOverride === 'boolean' ? 'override' : longPressOverride === null ? 'default' : source('composerLongPressEnabled'));
    put('voice.microphoneDeviceIdConfigured', Boolean(state.value.microphoneDeviceId), source('microphoneDeviceId'));
    put('voice.refinementInstructionsConfigured', typeof state.raw.refinementInstructions === 'string' && Boolean(state.raw.refinementInstructions.trim()), source('refinementInstructions'));
    const override = state.raw.dictionarySyncEnabledOverride;
    put('voice.dictionarySyncEnabled', state.value.dictionarySyncEnabled, typeof override === 'boolean' ? 'override' : override === null ? 'default' : source('dictionarySyncEnabled'));
    voiceState.shortcut = state.value.shortcut;
    put('voice.shortcutConfigured', voiceState.shortcut !== null, source('shortcut'));
  });
  domain(['voice.serviceMode', 'voice.asr', 'voice.customAsr'], () => {
    const state = inspectVoiceInputModelSelection(options.ownerRoot);
    if (state.status !== 'ready') { fail(['voice.serviceMode', 'voice.asr', 'voice.customAsr'], state.status); return; }
    const value = state.value.values;
    const source = (key: string, envKey?: string): ReadonlySettingSource => {
      const raw = state.raw[key];
      if ((typeof raw === 'string' && raw.trim()) || (Array.isArray(raw) && raw.length) || isSettingsRecord(raw)) return 'override';
      return envKey && state.env[envKey]?.trim() ? 'unknown' : 'default';
    };
    put('voice.serviceMode', value.serviceMode, source('serviceMode', 'XDT_VOICE_INPUT_SERVICE_MODE'));
    put('voice.asrProvider', value.asrProvider, source('asrProvider', 'XDT_VOICE_INPUT_ASR_PROVIDER'));
    const chainSource = source('asrProviderChain', 'XDT_VOICE_INPUT_ASR_PROVIDER_CHAIN');
    put('voice.asrProviderChain', value.asrProviderChain, chainSource === 'default' && source('asrProvider', 'XDT_VOICE_INPUT_ASR_PROVIDER') !== 'default' ? 'unknown' : chainSource);
    const customSource = source('customAsr');
    put('voice.customAsrConfigured', Boolean(value.customAsr), customSource);
    put('voice.customAsr.protocol', value.customAsr?.protocol ?? null, customSource);
    put('voice.customAsr.endpointConfigured', Boolean(value.customAsr?.websocketUrl), customSource);
    put('voice.customAsr.modelConfigured', Boolean(value.customAsr?.model), customSource);
    for (const warning of state.value.warnings) {
      const id = warning.field === 'customAsr' ? 'voice.customAsrConfigured' : `voice.${warning.field}`;
      if (id in fields) fields[id] = { status: 'unreadable' };
      if (warning.field === 'customAsr') fail(['voice.customAsr.'], 'unreadable');
    }
  });
  domain(['shortcuts.'], () => {
    const state = new AppShortcutStore({ platform, getFilePath: () => path.join(options.userDataPath, APP_SHORTCUTS_FILE_NAME) }).inspect();
    const shortcut = voiceState.shortcut;
    const yieldTo = shortcut && shortcut.trigger !== 'modifier' && !shortcut.modifiers.fn
      ? [{ code: shortcut.code, meta: shortcut.modifiers.meta, ctrl: shortcut.modifiers.ctrl, alt: shortcut.modifiers.alt, shift: shortcut.modifiers.shift }] : [];
    const combos = state.status === 'ready' ? getEffectiveAppShortcuts(state.value, platform, yieldTo) : null;
    for (const def of APP_SHORTCUT_DEFINITIONS) {
      const id = `shortcuts.${def.id}`;
      if (!isAppShortcutAvailableOnPlatform(def.id, platform)) { fields[id] = { status: 'unsupported' }; continue; }
      if (state.status !== 'ready' || !combos) { fields[id] = { status: 'unreadable' }; continue; }
      const value = combos.get(def.id) ?? [];
      if (value.some(combo => !keyCodes.has(combo.code))) { fields[id] = { status: 'private' }; continue; }
      if (has(state.raw, 'overrides', def.id) && !has(state.value, def.id)) { fields[id] = { status: 'unreadable' }; continue; }
      put(id, value.map(({ code, meta, ctrl, alt, shift }) => ({ code, meta, ctrl, alt, shift })), has(state.value, def.id) ? 'override' : 'default');
    }
  });
  for (const model of WORKLOUDER_MODELS) domain([`worklouder.${model}.`], () => {
    const state = inspectWorkLouderSettings(options.ownerRoot, model);
    const prefix = `worklouder.${model}`;
    if (state.status !== 'ready') { fail([`${prefix}.`], state.status); return; }
    const source = (...keys: (string | number)[]): ReadonlySettingSource => has(state.raw, ...keys) ? keys.length > 1 ? 'unknown' : 'override' : (keys[0] === 'layout' && has(state.raw, 'layout') ? 'unknown' : 'default');
    for (const key of ['deviceEnabled', 'lightingBrightness', 'lightingAutoDim', 'agentSource', 'singleTapAgentKeys'] as const) put(`${prefix}.${key}`, state.value[key], source(key));
    for (let i = 0; i < WORKLOUDER_CODEX_AGENT_SLOT_COUNT; i++) put(`${prefix}.customAgentKeys.${i}`, inspectHardwareAction(state.value.customAgentKeys[i] ?? null), source('customAgentKeys', i));
    const layout = state.value.layout;
    for (const key of ['encoderMode', 'separateMicrophoneKeys', 'taskKeys', 'merges'] as const) put(`${prefix}.layout.${key}`, layout[key] ?? [], source('layout', key));
    for (const slot of new Set([...WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS, ...WORKLOUDER_CODEX_COMMAND_SLOTS])) {
      const assignment = layout.slots[slot];
      for (const leaf of ['keycapId', 'action'] as const) {
        const id = `${prefix}.layout.slots.${slot}.${leaf}`;
        if (!assignment) { fields[id] = { status: 'unsupported' }; continue; }
        put(id, leaf === 'action' ? inspectHardwareAction(assignment.action) : assignment.keycapId, source('layout', 'slots', slot, leaf));
      }
    }
    for (const dir of WORKLOUDER_CODEX_ANALOG_DIRECTIONS) put(`${prefix}.layout.analogStick.${dir}`, inspectHardwareAction(layout.analogStick[dir]), source('layout', 'analogStick', dir));
    for (const action of WORKLOUDER_CODEX_ENCODER_ACTIONS) put(`${prefix}.layout.encoder.${action}`, inspectHardwareAction(layout.encoder[action]), source('layout', 'encoder', action));
  });
  for (const family of GAMEPAD_FAMILIES) domain([`gamepad.${family}.`], () => {
    const state = inspectXboxGamepadSettings(options.ownerRoot, family);
    const prefix = `gamepad.${family}`;
    if (state.status !== 'ready') { fail([`${prefix}.`], state.status); return; }
    // Older gamepad writers saved complete layouts; a present default-valued leaf cannot prove intent.
    const source = (...keys: string[]): ReadonlySettingSource => has(state.raw, ...keys) ? keys.length > 1 ? 'unknown' : 'override' : 'default';
    put(`${prefix}.deviceEnabled`, state.value.deviceEnabled, source('deviceEnabled'));
    for (const button of XBOX_GAMEPAD_BUTTON_IDS) put(`${prefix}.layout.buttons.${button}`, inspectHardwareAction(state.value.layout.buttons[button]), source('layout', 'buttons', button));
    for (const stick of XBOX_GAMEPAD_STICK_IDS) {
      put(`${prefix}.layout.sticks.${stick}.mode`, state.value.layout.sticks[stick].mode, source('layout', 'sticks', stick, 'mode'));
      for (const dir of XBOX_GAMEPAD_STICK_DIRECTIONS) put(`${prefix}.layout.sticks.${stick}.directions.${dir}`, inspectHardwareAction(state.value.layout.sticks[stick].directions[dir]), source('layout', 'sticks', stick, 'directions', dir));
    }
  });
  domain(['im.'], () => {
    const state = inspectImDefaultSettings(options.ownerRoot, options.userDataPath);
    const channels = ['global', ...IM_DEFAULT_SETTINGS_CHANNELS] as const;
    for (const channel of channels) {
      const prefix = `im.${channel}`;
      if (state.status !== 'ready') { fail([`${prefix}.`], state.status); continue; }
      const value = channel === 'global' ? state.value.global : state.value.channels[channel];
      const raw = channel === 'global' ? state.raw.global : isSettingsRecord(state.raw.channels) ? state.raw.channels[channel] : undefined;
      const legacy = state.legacy;
      const source = (...keys: string[]): ReadonlySettingSource => legacy ? 'unknown' : has(raw, ...keys) ? 'override' : 'default';
      for (const key of ['agentKind', 'permissionMode', 'groupPermissionMode'] as const) put(`${prefix}.${key}`, value[key], key === 'groupPermissionMode' && has(raw, 'groupCtrPermissionMode') ? 'override' : source(key));
      for (const agent of ['claude-code', 'codex', 'pi'] as const) for (const key of ['providerId', 'model', 'effort'] as const) put(`${prefix}.agents.${agent}.${key}`, value.agents[agent][key], source('agents', agent, key));
    }
  });
  domain(['im.localTelegram.'], () => {
    const behavior = inspectTelegramBehavior(options.ownerRoot);
    for (const key of ['emojiReactions', 'replyQuoteGroup', 'replyQuoteDm'] as const) {
      if (behavior.status !== 'ready') fields[`im.localTelegram.${key}`] = { status: behavior.status };
      else put(`im.localTelegram.${key}`, behavior.value[key], has(behavior.raw, key) ? 'override' : 'default');
    }
    const persona = inspectTelegramPersona(options.ownerRoot);
    for (const key of ['botName', 'soul'] as const) {
      if (persona.status !== 'ready') fields[`im.localTelegram.${key}Configured`] = { status: persona.status };
      else put(`im.localTelegram.${key}Configured`, Boolean(persona.value[key]), has(persona.raw, key) ? 'override' : 'default');
    }
  });
  domain(['im.official.'], () => {
    const state = inspectOfficialHookSettings(path.join(options.ownerRoot, 'slack-hook.json'), options.officialAccountFingerprint ?? null, path.join(options.ownerRoot, 'hook-connections.json'));
    if (state.status !== 'ready') { fail(['im.official.'], state.status); return; }
    for (const [leaf, key, provider] of [['slackEnabled', 'enabled', 'slack'], ['telegramEnabled', 'telegramEnabled', 'telegram'], ['xEnabled', 'xEnabled', 'x']] as const) put(`im.official.${leaf}`, state.value[key], has(state.raw, 'account', provider, 'enabled') ? 'unknown' : 'default');
    put('im.official.slackLifecycleAnnouncement', state.value.lifecycleAnnouncementOverride ?? DEFAULT_SLACK_LIFECYCLE_ANNOUNCEMENT, state.value.lifecycleAnnouncementOverride === null ? 'default' : 'override');
    for (const provider of ['telegram', 'x'] as const) put(`im.official.${provider}DefaultWorkspaceConfigured`, Boolean(state.value[`${provider}DefaultWorkspace`]), has(state.raw, 'account', provider, 'defaultWorkspace') ? 'unknown' : 'default');
    put('im.official.urlOverrideConfigured', Boolean(state.value.urlOverride), state.value.urlOverride ? 'override' : 'default');
  });
  // This preference shares the encrypted credential plane; inspecting it would decrypt secrets.
  fields['im.wecom.notificationsEnabled'] = { status: 'private' };
  domain(['browser.', 'computer.', 'android.'], () => {
    const state = new SettingsReader({ userDataPath: options.ownerRoot, logger: { warn() {} } }).inspectGlobal(['browser', 'computer', 'android']);
    for (const tool of ['browser', 'computer', 'android']) {
      if (state.status !== 'ready') fields[`${tool}.enabled`] = { status: state.status };
      else put(`${tool}.enabled`, state.value.get(tool) ?? !DEFAULT_DISABLED_PLUGIN_IDS.has(tool), state.value.has(tool) ? 'override' : 'default');
    }
  });
  domain(['browser.backend', 'browser.useRealProfile'], () => {
    const state = inspectBrowserBackendSettings(options.userDataPath);
    for (const [leaf, key] of [['backend', 'kind'], ['useRealProfile', 'useRealProfile']] as const) {
      if (state.status !== 'ready') fields[`browser.${leaf}`] = { status: state.status };
      else put(`browser.${leaf}`, state.value[key], has(state.raw, key) ? 'override' : 'default');
    }
  });
  domain(['android.adbPathOverrideConfigured', 'android.defaultDeviceSerialConfigured'], () => {
    const state = inspectAndroidAutomationSettings(options.userDataPath);
    for (const [leaf, key] of [['adbPathOverrideConfigured', 'adbPathOverride'], ['defaultDeviceSerialConfigured', 'defaultDeviceSerial']] as const) {
      if (state.status !== 'ready') fields[`android.${leaf}`] = { status: state.status };
      else put(`android.${leaf}`, Boolean(state.value[key]), has(state.raw, key) ? 'override' : 'default');
    }
  });
  return { fields };
}
