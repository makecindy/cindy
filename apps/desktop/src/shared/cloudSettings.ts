import { z } from 'zod';
import { settingsEditableValueSchema } from './settingsEditableCatalog.js';
import { SETTINGS_WEB_MAX_CHOICES, settingsWebReadResultSchema } from './settingsWeb.js';

/** Native cloud settings reuse the local menu and presentation components.
 * Project only domains with compatible remote state and native controllers;
 * never fill remote fields from this computer's settings or provider catalog.
 * Authorization and lifecycle operations use their existing dedicated commands. */
// UI projection only. Remote commands use settingsWeb/settingsManagement.
export const CLOUD_SETTINGS_GROUPS = {
  // Settings that only change the instance's own window (notifications, the send shortcut,
  // appearance, link opening, prompt suggestions, the message rail) are left to its remote desktop.
  general: [
    'desktopGeneral',
    'collaboration',
    'agentResource',
    'gitSafety',
    'lsp',
  ],
  personalization: [
    'personalization',
    'memory',
    'subagentModel',
    'auxiliaryModel',
    'chatEmbedding',
    'silentEncryptedRetry',
    'terminal',
  ],
  providers: [],
  'im-bot': [
    'imFeishu',
    'imDiscord',
    'imWechat',
    'imTelegram',
    'imDingtalk',
    'imWecom',
    'telegramBehavior',
    'telegramGroups',
    // Notification sections inside the WeCom and Feishu cards.
    'wecomNotifications',
    'desktopNotifications',
  ],
  ghosts: [],
  'builtin-tools': ['builtinTools', 'browserTools'],
  // Android (ADB) automation is not offered: a cloud instance cannot reach the
  // user's USB or local-network Android devices.
  'computer-use': ['browserTools', 'browserBackend', 'computerTools'],
  storage: ['databaseWarning'],
  about: ['privacy', 'desktopNotifications', 'diagnostics'],
} as const;
export type CloudSettingsTab = keyof typeof CLOUD_SETTINGS_GROUPS;
export const CLOUD_SETTINGS_DOMAINS = [...new Set(Object.values(CLOUD_SETTINGS_GROUPS).flat())];
export type CloudSettingsDomain = (typeof CLOUD_SETTINGS_DOMAINS)[number];
export const cloudSettingsDomainSchema = z.enum(
  CLOUD_SETTINGS_DOMAINS as [CloudSettingsDomain, ...CloudSettingsDomain[]],
);
/** Local presentation flags, projected from existing capabilities; never a Host protocol. */
export interface CloudSettingsCapabilities {
  version: 1;
  deviceId: string;
  runtimeId: string;
  ownerGeneration: number;
  providerAuthorization?: 1;
  botAuthorization?: 1;
  mcpAuthorization?: 1;
  cpuCount?: number;
  domains: CloudSettingsDomain[];
}
const values = z.record(z.string(), settingsEditableValueSchema);
// Presentation-only diagnostic: never forwarded as a Host setting or credential.
export const cloudSettingsReadErrorCodeSchema = z.enum([
  'SETTINGS_REQUEST_FAILED',
  'SETTINGS_RESPONSE_TOO_LARGE',
  'MODEL_CATALOG_TOO_LARGE',
  'UNREADABLE',
]);
export const cloudSettingsStateSchema = z
  .strictObject({
    domain: cloudSettingsDomainSchema,
    status: z.enum(['ready', 'unavailable', 'unreadable']),
    readErrorCode: cloudSettingsReadErrorCodeSchema.optional(),
    revision: z.string().min(1).max(128).nullable(),
    operationId: z.string().uuid().optional(),
    value: values.optional(),
    defaults: values.optional(),
    customizedKeys: z.array(z.string()).max(16).optional(),
    isCustomized: z.boolean().optional(),
    choices: z
      .record(
        z.string(),
        z
          .array(
            z
              .strictObject({
                value: settingsEditableValueSchema,
                label: z.string().max(512),
                efforts: z
                  .array(z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']))
                  .max(7)
                  .optional(),
                supportsFast: z.boolean().optional(),
              }),
          )
          .max(SETTINGS_WEB_MAX_CHOICES),
      )
      .optional(),
  })
  .superRefine(({ readErrorCode, ...state }, ctx) => {
    if (readErrorCode && state.status !== 'unreadable')
      ctx.addIssue({ code: 'custom', message: 'read error requires unreadable state' });
    // Reuse the existing business validator for every real cloud state. Only the
    // in-memory preview has a prompt body; it is never accepted by Main.
    if (state.domain !== 'personalization') {
      if (!settingsWebReadResultSchema.safeParse({ ok: true, settings: state }).success)
        ctx.addIssue({ code: 'custom', message: 'invalid cloud settings state' });
      return;
    }
    if (state.status !== 'ready') {
      if (state.revision !== null || state.value || state.defaults || state.operationId)
        ctx.addIssue({ code: 'custom', message: 'invalid unavailable state' });
      return;
    }
    const schema = z.strictObject({ userPrompt: z.string().max(8000) });
    if (
      !state.revision ||
      !state.operationId ||
      !schema.safeParse(state.value).success ||
      !schema.safeParse(state.defaults).success ||
      !state.customizedKeys ||
      state.customizedKeys.some((key) => !Object.hasOwn(schema.shape, key)) ||
      new Set(state.customizedKeys).size !== state.customizedKeys.length ||
      state.isCustomized !== state.customizedKeys.length > 0
    )
      ctx.addIssue({ code: 'custom', message: 'invalid cloud settings state' });
  });
export type CloudSettingsState = z.infer<typeof cloudSettingsStateSchema>;
