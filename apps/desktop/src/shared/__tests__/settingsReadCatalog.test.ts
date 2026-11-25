import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TAB_IDS } from '../../renderer/lib/tabLabels.js';
import { APP_SHORTCUT_DEFINITIONS } from '../appShortcuts.js';
import { IM_DEFAULT_SETTINGS_CHANNELS, IM_DEFAULT_SETTINGS } from '../imDefaultSettings.js';
import { SUBAGENT_MODEL_CARD_KEYS } from '../subagentModelSettings.js';
import { WORKLOUDER_MODELS, WORKLOUDER_CODEX_DEFAULT_SETTINGS, WORKLOUDER_CODEX_COMMAND_SLOTS, WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS,
  WORKLOUDER_CODEX_KEYCAP_IDS, WORKLOUDER_CODEX_ENCODER_MODES, WORKLOUDER_CODEX_ANALOG_DIRECTIONS, WORKLOUDER_CODEX_ENCODER_ACTIONS } from '../workLouderCodex.js';
import { GAMEPAD_FAMILIES, XBOX_GAMEPAD_BUTTON_IDS, XBOX_GAMEPAD_STICK_DIRECTIONS, XBOX_GAMEPAD_STICK_IDS } from '../xboxGamepad.js';
import { INPUT_DEVICE_COMMAND_IDS } from '../inputDevices.js';
import { SETTINGS_READ_CATALOG, SETTINGS_READ_FIELD_IDS, SETTINGS_READ_TABS, SETTINGS_READ_EXTERNAL_CATALOG, SETTINGS_READ_COLLECTION_CATALOG,
  SETTINGS_READ_COMMAND_IDS, SETTINGS_READ_WORKLOUDER_KEYCAPS, SETTINGS_READ_IM_CHANNELS, SETTINGS_READ_SHORTCUT_IDS,
  SETTINGS_READ_WORKLOUDER_MODELS, SETTINGS_READ_GAMEPAD_FAMILIES, SETTINGS_READ_ISLAND_EVENTS,
  SETTINGS_READ_BUILTIN_TOOL_IDS, SETTINGS_READ_CAPABILITIES, SETTINGS_READ_ASR_PROVIDERS } from '../settingsReadCatalog.js';

const ids = new Set<string>(SETTINGS_READ_FIELD_IDS);
const src = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const text = (path: string) => readFileSync(src(path), 'utf8');
function expectIds(expected: string[]) { for (const id of expected) expect(ids.has(id), id).toBe(true); }

describe('settings read catalog independent coverage anchors', () => {
  it('classifies the actual 20 tabs and every SettingsView child instead of comparing the catalog to itself', () => {
    expect(SETTINGS_READ_TABS).toEqual(TAB_IDS);
    expect(TAB_IDS).toHaveLength(20);
    const represented = new Set([...Object.values(SETTINGS_READ_CATALOG).map(field => field.tab), ...SETTINGS_READ_EXTERNAL_CATALOG.map(item => item.tab)]);
    expect([...represented].sort()).toEqual([...TAB_IDS].sort());
    const actualSections = [...text('renderer/components/settings/SettingsView.tsx').matchAll(/<([A-Z][A-Za-z]*(?:Section|Cell|Card|Panel))\b/g)].map(match => match[1]);
    // Pages wrap their content in the shared settings-rows layout primitives; they hold no setting.
    const layoutPrimitives = ['SettingsSection', 'SettingsCard'];
    for (const primitive of layoutPrimitives) expect(text('renderer/components/ui/settings-rows.tsx'), primitive).toMatch(new RegExp(`export function ${primitive}\\b`));
    const classified = new Set([...Object.values(SETTINGS_READ_CATALOG).flatMap(field => [field.control, ...field.controlAncestors]), ...Object.values(SETTINGS_READ_COLLECTION_CATALOG).map(item => item.control),
      ...SETTINGS_READ_EXTERNAL_CATALOG.map(item => item.control), 'HelpAssistantPanel', ...layoutPrimitives]);
    expect([...new Set(actualSections)].filter(control => !classified.has(control))).toEqual([]);
  });
  it('has every IM global and native-channel 12-leaf default, and every subagent card key', () => {
    expect(SETTINGS_READ_IM_CHANNELS).toEqual(['global', ...IM_DEFAULT_SETTINGS_CHANNELS]);
    for (const channel of ['global', ...IM_DEFAULT_SETTINGS_CHANNELS]) {
      const leaves = ['agentKind', 'permissionMode', 'groupPermissionMode', ...Object.keys(IM_DEFAULT_SETTINGS.agents).flatMap(agent => ['providerId', 'model', 'effort'].map(key => `agents.${agent}.${key}`))];
      expect(leaves).toHaveLength(12);
      expectIds(leaves.map(leaf => `im.${channel}.${leaf}`));
    }
    expectIds(SUBAGENT_MODEL_CARD_KEYS.map(key => `subagentModel.${key}`));
  });
  it('classifies all 30 shortcuts including hidden and platform-only definitions', () => {
    expect([...SETTINGS_READ_SHORTCUT_IDS].sort()).toEqual(APP_SHORTCUT_DEFINITIONS.map(def => def.id).sort());
    expect(APP_SHORTCUT_DEFINITIONS).toHaveLength(30);
    for (const shortcut of APP_SHORTCUT_DEFINITIONS) {
      const field = SETTINGS_READ_CATALOG[`shortcuts.${shortcut.id}`];
      expect(field.platforms).toEqual(shortcut.platforms ?? ['darwin', 'win32', 'linux']);
      expect(field.sourcePath).toBe(`shared/appShortcuts.ts#${shortcut.id}`);
    }
  });
  it('has 2x7 hardware setting groups and all their independently registered layout leaves', () => {
    expect(SETTINGS_READ_WORKLOUDER_MODELS).toEqual(WORKLOUDER_MODELS);
    expect(Object.keys(WORKLOUDER_CODEX_DEFAULT_SETTINGS)).toHaveLength(7);
    expect(SETTINGS_READ_COMMAND_IDS).toEqual(INPUT_DEVICE_COMMAND_IDS);
    expect(SETTINGS_READ_WORKLOUDER_KEYCAPS).toEqual(WORKLOUDER_CODEX_KEYCAP_IDS);
    for (const model of WORKLOUDER_MODELS) {
      const prefix = `worklouder.${model}`;
      for (const key of Object.keys(WORKLOUDER_CODEX_DEFAULT_SETTINGS)) expect(SETTINGS_READ_FIELD_IDS.some(id => id === `${prefix}.${key}` || id.startsWith(`${prefix}.${key}.`)), `${prefix}.${key}`).toBe(true);
      for (const slot of new Set([...WORKLOUDER_CODEX_COMMAND_SLOTS, ...WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS])) expectIds(['keycapId', 'action'].map(leaf => `${prefix}.layout.slots.${slot}.${leaf}`));
      expectIds(WORKLOUDER_CODEX_ANALOG_DIRECTIONS.map(key => `${prefix}.layout.analogStick.${key}`));
      expectIds(WORKLOUDER_CODEX_ENCODER_ACTIONS.map(key => `${prefix}.layout.encoder.${key}`));
      const encoder = SETTINGS_READ_CATALOG[`worklouder.${model}.layout.encoderMode`].valueSchema;
      for (const mode of WORKLOUDER_CODEX_ENCODER_MODES) expect(encoder.safeParse(mode).success).toBe(true);
    }
  });
  it('has every gamepad family and all button/stick anchors', () => {
    expect(SETTINGS_READ_GAMEPAD_FAMILIES).toEqual(GAMEPAD_FAMILIES);
    for (const family of GAMEPAD_FAMILIES) {
      expectIds([`gamepad.${family}.deviceEnabled`, ...XBOX_GAMEPAD_BUTTON_IDS.map(id => `gamepad.${family}.layout.buttons.${id}`)]);
      for (const stick of XBOX_GAMEPAD_STICK_IDS) expectIds([`gamepad.${family}.layout.sticks.${stick}.mode`, ...XBOX_GAMEPAD_STICK_DIRECTIONS.map(dir => `gamepad.${family}.layout.sticks.${stick}.directions.${dir}`)]);
    }
  });
  it('tracks the migration 20 groups as 25 separately addressable desktop leaves', () => {
    const groups = ['theme', 'themeFamilyIdConfigured', 'locale', 'sidebarPinnedMode', 'sidebarMainMode', 'ghostPanelRestoreMode', 'notificationsEnabled',
      'swallowActivationClick', 'composerSendShortcut', 'webLinkOpenPreference', 'localLinkOpenPreference', 'streamFadePreference', 'promptRecommendationEnabled',
      'messageNavRailEnabled', 'feishuNotificationsEnabled', 'agentIslandEnabled', 'agentIslandSoundSettings', 'agentIslandMascotSkin', 'agentIslandDisplayTargetConfigured', 'networkDebugEnabled'];
    expect(groups).toHaveLength(20);
    expectIds(groups.filter(group => group !== 'agentIslandSoundSettings').map(group => `desktop.${group}`));
    expectIds(['desktop.agentIslandSoundSettings.enabled', ...SETTINGS_READ_ISLAND_EVENTS.map(event => `desktop.agentIslandSoundSettings.sounds.${event}`)]);
    expect(SETTINGS_READ_FIELD_IDS.filter(id => id.startsWith('desktop.'))).toHaveLength(25);
  });
  // The cloud snapshot publishes a frozen subset of these interfaces: every published field must
  // still exist here, while a new local option can ship without a cloud field.
  it('keeps every published field of the core native interfaces backed by the interface', () => {
    const interfaces = [
      ['collaboration', 'main/maker-host/collaboration-settings-store.ts', 'CollaborationSettings'],
      ['agentResource', 'main/maker-host/agent-resource-settings-store.ts', 'AgentResourceSettings'],
      ['gitSafety', 'main/maker-host/git-safety-settings-store.ts', 'GitSafetySettings'],
      ['memory', 'main/maker-host/memory-settings-store.ts', 'MemorySettings'],
      ['subagentModel', 'shared/subagentModelSettings.ts', 'SubagentModelSettings'],
      ['auxiliaryModel', 'shared/auxiliaryModelSettings.ts', 'AuxiliaryModelSettings'],
    ] as const;
    for (const [prefix, path, name] of interfaces) {
      const declaration = text(path).match(new RegExp(`(?:export )?interface ${name} \\{([\\s\\S]*?)\\n\\}`))![1]!;
      const keys = [...declaration.matchAll(/^ {2}([A-Za-z]+)(?:\?)?:/gm)].map(match => match[1]!);
      expect(keys.length, name).toBeGreaterThan(0);
      const published = SETTINGS_READ_FIELD_IDS.filter(id => id.startsWith(`${prefix}.`));
      expect(published.length, name).toBeGreaterThan(0);
      for (const id of published) expect(keys, id).toContain(id.slice(prefix.length + 1));
    }
    // Retired Smart Contacts keeps only its frozen snapshot fields.
    expectIds(['contacts.enabled', 'contacts.deviceSyncEnabled']);
    const voice = text('shared/voiceInputData.ts').match(/export interface VoiceInputSettings \{([\s\S]*?)\n\}/)![1]!;
    const voiceKeys = [...voice.matchAll(/^ {2}([A-Za-z]+)(?:\?)?:/gm)].map(match => match[1]!);
    const resources = ['dictionaryEntries', 'dictionaryCandidates', 'suppressedAutomaticDictionaryTexts'];
    for (const key of voiceKeys) {
      if (resources.includes(key)) expect(SETTINGS_READ_EXTERNAL_CATALOG.some(item => item.id === 'voice.dictionary')).toBe(true);
      else if (['speakerFilterEnabled', 'speakerFilterStrictness', 'speakerFilterStrictnessOverride'].includes(key)) {
        expect(SETTINGS_READ_EXTERNAL_CATALOG.some(item => item.id === 'voice.speakerFilter')).toBe(true);
        expect(SETTINGS_READ_FIELD_IDS).not.toContain(`voice.${key}`);
      }
      else if (['conversationSelection', 'conversationSelections', 'conversationSentencePlayback'].includes(key)) {
        expect(SETTINGS_READ_EXTERNAL_CATALOG.some(item => item.id === 'voice.conversation')).toBe(true);
        expect(SETTINGS_READ_FIELD_IDS).not.toContain(`voice.${key}`);
      }
      // Any other voice setting needs no cloud field, as for the core interfaces: the frozen
      // snapshot publishes a subset, and the coverage test checks each published field is produced.
    }
  });
  it('anchors ASR sources, builtin tools and plugin capabilities in their actual registries', () => {
    const asr = text('shared/voiceInputAsrProfiles.ts').split('export const VOICE_INPUT_ASR_PROFILES = {')[1]!.split('} as const satisfies')[0]!;
    expect(SETTINGS_READ_ASR_PROVIDERS).toEqual([...asr.matchAll(/^ {2}'([^']+)': \{/gm)].map(match => match[1]));
    const tools = text('main/maker-host/plugins/builtin-plugins.ts');
    expect(SETTINGS_READ_BUILTIN_TOOL_IDS).toEqual([...tools.matchAll(/\{ id: '([^']+)',\s+name:/g)].map(match => match[1]));
    // Old snapshot enum values stay wire-compatible; active overrides only migrate oneshot.
    expect(SETTINGS_READ_CAPABILITIES).toEqual(['image.generate', 'image.edit', 'video.generate', 'video.edit', 'text.oneshot', 'embed.text']);
    expect(text('main/cindy-brain/pluginTaskPrefsStore.ts')).toContain('migrateLegacyOneshotPins');
  });
  it('uses real source paths, stable identifiers, read-only source metadata and explicit privacy projections', () => {
    expect(SETTINGS_READ_FIELD_IDS.length).toBe(new Set(SETTINGS_READ_FIELD_IDS).size);
    for (const [id, field] of Object.entries(SETTINGS_READ_CATALOG)) {
      expect(id).toMatch(/^[a-zA-Z][a-zA-Z0-9._-]*$/);
      expect(field.labelKey).toBeTruthy();
      expect(field.control).toBeTruthy();
      expect(field.reader).toBeTruthy();
      expect(existsSync(src(field.sourcePath.split('#')[0]!)), `${id}: ${field.sourcePath}`).toBe(true);
      if (/Configured$|Customized$|\.customized$/.test(id)) expect(field.projection, id).toBe('configuredOnly');
    }
    const mutation = text('shared/hostSettings.ts');
    expect(mutation).toContain("['newTaskDefaults', 'personalization', 'databaseWarning', 'appearance'] as const");
    expect(mutation).not.toContain('settingsSnapshotV2');
    expect(mutation).not.toContain('settingsReadCatalog');
  });
});
