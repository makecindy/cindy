import { z } from 'zod';

/**
 * IM settings of a managed cloud instance for the same account's cloud settings page: the
 * official Cindy IM cards (workspace mapping, directory preferences, announcements, official
 * Telegram behaviour) and the personal bots' persona, groups, WeChat directory and status.
 *
 * A private DeviceLink channel registered only by the cloud runtime. It forwards one call to
 * the same Main business handler the local settings page uses, from the closed list below.
 * Starting a binding (Slack on, add, rebind, Telegram/X/Feishu link) stays on the cloud authorization
 * tickets, so `set-enabled` accepts only `false` here; directory choice uses the instance's
 * directory browser, never a dialog on the instance. Ordinary desktops and older runtimes
 * answer CHANNEL_NOT_ALLOWED.
 */
export const CLOUD_IM_SETTINGS_CHANNEL = 'cloud:im-settings:v1';

/** The cloud-only WeChat working directory write (the local page uses a native dialog). */
export const CLOUD_WECHAT_WORKING_DIR_SET = 'cloud:wechat:working-dir-set';
/** A provider link (connect / bot page / add to group) for the controller to open itself. */
export const CLOUD_HOOK_PROVIDER_ACTION_URL = 'cloud:hook:provider-action-url';

export const CLOUD_IM_SETTINGS_CALLS = [
  // Official Cindy IM: read, projects and the project settings all official bots share.
  'maker:hook-control:get',
  'maker:hook-control:set-lifecycle-announcement',
  'maker:hook-control:add-project',
  'maker:hook-control:set-provider-default-workspace',
  'maker:hook-control:shared-prefs-get',
  'maker:hook-control:shared-prefs-set',
  'maker:hook-control:workspace-provider-source-get',
  'maker:hook-control:workspace-provider-source-set',
  'maker:hook-control:telegram-behavior-get',
  'maker:hook-control:telegram-behavior-set',
  'maker:hook-control:telegram-groups-list',
  'maker:hook-control:telegram-group-activation-set',
  CLOUD_HOOK_PROVIDER_ACTION_URL,
  // Ending a binding or an attempt, and the provider switches; none opens an authorization page.
  'maker:hook-control:set-enabled',
  'maker:hook-control:set-provider-enabled',
  'maker:hook-control:set-slack-communications',
  'maker:hook-control:revoke-team',
  'maker:hook-control:cancel-pending-bind',
  'maker:hook-control:provider-bind-cancel',
  'maker:hook-control:provider-bind-revoke',
  // Select an already linked Feishu working computer; the native handler checks select_device.
  'maker:hook-control:provider-bind-select',
  // Effective values of directory rows and the legacy default notice.
  'maker:im-default-settings:get',
  // Personal Telegram persona, behaviour and groups.
  'telegramBot:get-persona',
  'telegramBot:set-persona',
  'telegramBot:get-behavior',
  'telegramBot:set-behavior',
  'telegramBot:list-groups',
  'telegramBot:set-group-activation',
  // Personal WeChat working directory.
  'wechatBot:get-channel-settings',
  'wechatBot:reset-working-directory',
  CLOUD_WECHAT_WORKING_DIR_SET,
  // Taking the personal Telegram bot offline keeps its token (going online is a ticket).
  'telegramBot:set-online',
  // Connected account details of the personal bots (the same status the local card reads).
  'telegramBot:get-status',
  'discordBot:get-status',
  'wecomBot:get-status',
  'feishuBot:get-state',
  'dingtalkBot:get-state',
] as const;
export type CloudImSettingsCall = (typeof CLOUD_IM_SETTINGS_CALLS)[number];

/** Calls and replies stay small; a larger reply is refused rather than truncated. */
export const CLOUD_IM_SETTINGS_MAX_BYTES = 512 * 1024;

export const cloudImSettingsRequestSchema = z
  .strictObject({
    call: z.enum(CLOUD_IM_SETTINGS_CALLS),
    args: z.array(z.unknown()).max(4).default([]),
  });

export const cloudImSettingsReplySchema = z
  .strictObject({ ownerGeneration: z.number().int().nonnegative(), result: z.unknown() });
export type CloudImSettingsReply = z.infer<typeof cloudImSettingsReplySchema>;
