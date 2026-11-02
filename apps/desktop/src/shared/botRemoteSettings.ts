/**
 * Wire contract of the desktop teammate-settings target (`docs/product-rules/cindy-bots-runtime.md`
 * 「远程设置」).
 *
 * The controller renders the same settings pages as the local Desktop; every read and write is
 * executed by the teammate's computer. It rides the existing `maker:remote-resources:invoke`
 * channel on the `teammates` collection (no new device-link channel, no allowlist change): one
 * collection action, `management:settings`, whose `input.op` selects a fixed operation. The host
 * answers with `{ effects: [], result: BotSettingsResult }`.
 *
 * Hosts declare the action in the collection manifest; the `caps` operation then lists the
 * operations they implement so a controller can fall back (per page) when the host is older.
 * Credentials, filesystem paths and runtime objects never appear in a result.
 */

/** Collection action id declared by hosts that implement this contract. */
export const BOT_SETTINGS_ACTION_ID = 'management:settings';
export const BOT_SETTINGS_PROTOCOL_VERSION = 1;

export const BOT_SETTINGS_OPS = [
  'caps',
  'profile.get',
  'profile.update',
  'profile.chooseAvatar',
  'profile.retryInvitation',
  'lifecycle.run',
  'models.default',
  'memory.list',
  'memory.read',
  'memory.update',
  'memory.delete',
  'capabilities.catalog',
  'skills.core',
  'skills.read',
  'skills.save',
  'skills.setEnabled',
  'skills.delete',
  'autonomy.get',
  'autonomy.set',
  'autonomy.reset',
  'history.search',
  'routines.list',
  'routines.sources',
  'routines.history',
  'routines.save',
  'routines.saveWithModel',
  'routines.saveWithSessionMode',
  'routines.saveWithDelivery',
  'routines.deliveryTargets',
  'routines.runNow',
  'routines.remove',
  'voice.models',
  'voice.voices',
  'voice.preference',
  'voice.setPreference',
  'channels.im.list',
  'channels.im.remove',
  'channels.im.listGroups',
  'channels.im.setGroupActivation',
  'channels.im.listLanes',
  'channels.im.resetLane',
  'channels.im.listAdoptable',
  'channels.im.adopt',
  'channels.wechat.get',
  'channels.wechat.setCompanion',
  'channels.wechat.unbind',
  'channels.wechat.cancelAuthorization',
  'channels.x.get',
  'channels.x.setCompanion',
] as const;
export type BotSettingsOp = (typeof BOT_SETTINGS_OPS)[number];

/** Operations without a teammate (`resourceRef`) in the request. */
export const BOT_SETTINGS_HOST_OPS: readonly BotSettingsOp[] = [
  'caps',
  'models.default',
  'autonomy.get',
  'autonomy.set',
  'autonomy.reset',
  'routines.sources',
  'voice.models',
  'voice.voices',
  'channels.im.listAdoptable',
];

export interface BotSettingsCaps {
  version: number;
  ops: BotSettingsOp[];
}

/**
 * A failed operation is returned as data rather than thrown: the registry adapter collapses every
 * non-registry error into a generic INTERNAL, which would hide revision conflicts (`PRECONDITION_FAILED`)
 * from the page that has to react to them.
 */
export type BotSettingsResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

const OP_SET: ReadonlySet<string> = new Set(BOT_SETTINGS_OPS);
export const isBotSettingsOp = (value: unknown): value is BotSettingsOp =>
  typeof value === 'string' && OP_SET.has(value);

/** Pages of the settings home, in display order. A page is shown for a host only if its ops exist. */
export type BotSettingsPageId =
  | 'profile'
  | 'personality'
  | 'memory'
  | 'model'
  | 'voice'
  | 'capabilities'
  | 'channels'
  | 'routines'
  | 'history'
  | 'advanced';

/** Operations a host must implement for the full page set rendered by the local components. */
export const BOT_SETTINGS_CORE_OPS: readonly BotSettingsOp[] = [
  'profile.get',
  'profile.update',
  'profile.chooseAvatar',
  'profile.retryInvitation',
  'lifecycle.run',
  'models.default',
  'memory.list',
  'memory.read',
  'memory.update',
  'memory.delete',
  'capabilities.catalog',
  'autonomy.get',
  'autonomy.set',
  'autonomy.reset',
  'history.search',
];

/** Profile fields a remote autosave may write; anything else is rejected by the host. */
export const BOT_SETTINGS_PATCH_FIELDS = [
  'name',
  'description',
  'identitySource',
  'userContextSource',
  'avatar',
  'avatarColor',
  'expectedAvatar',
  'skills',
  'capabilityBaseline',
  'capabilities',
] as const;

/**
 * Capability keys writable through the settings pages. `permissions` is deliberately absent:
 * raising the permission level keeps its confirmation in the generic remote form.
 */
export const BOT_SETTINGS_CAPABILITY_FIELDS = [
  'model',
  'modelOverride',
  'providerId',
  'effort',
  'fastMode',
  'harness',
  'modelChain',
  'modelChainOverride',
  'taskModelOverride',
  'skillMode',
  'toolsetMode',
  'toolsets',
  'mcpMode',
  'mcpServers',
  'memory',
  'inputHandoff',
  'allowSchedulerFollow',
  'systemSkillsOff',
] as const;
