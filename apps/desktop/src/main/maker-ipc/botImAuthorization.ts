/**
 * Host connection `im-<channel>`: the owner connects a messaging platform bot to
 * the teammate from an authorization card, the same as the teammate's
 * "Messaging platforms" settings page.
 *
 * The card reuses the v1 single-field inline form: one step per credential,
 * typed on the trusted Desktop only. Values stay in this adapter's memory until
 * every field is present, are passed once to the existing addBotImConnection,
 * and are then dropped. They never reach the model, the card snapshot, the
 * continuation message, logs or remote devices. The teammate is the one linked
 * to the card's session by the Host; the model never names it.
 */
import { t } from '../i18n.js';
import { addBotImConnection, parseBotImConnectionAddInput } from '../im/shared/botImConnectionRuntime.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import type { BotImChannel, BotImFeishuService } from '../../shared/botImConnection.js';
import type {
  GhostSetupAllowedAction,
  GhostSetupAssessment,
  GhostSetupAssessmentItem,
} from '../../shared/ghost.js';
import type { BotAuthorizationAdapter } from './botAuthorizationService.js';

interface ImField {
  /** Key of parseBotImConnectionAddInput's payload. */
  key: string;
  /** Settings page copy under `bots.channels.add.`, without its Label / Placeholder suffix. */
  copy: string;
  hint?: string;
  maxLength: number;
  /** Mirrors parseBotImConnectionAddInput so a bad value fails on its own step; that parser stays authoritative. */
  valid?: (value: string) => boolean;
}

const OWNER_ID = (value: string) => /^\d{1,20}$/.test(value);
const FIELDS: Record<BotImChannel, ImField[]> = {
  telegram: [
    { key: 'token', copy: 'telegram.token', maxLength: 256, valid: (v) => /^\d{6,20}:[A-Za-z0-9_-]{20,}$/.test(v) },
    { key: 'ownerUserId', copy: 'telegram.owner', hint: 'telegram.ownerHint', maxLength: 20, valid: OWNER_ID },
  ],
  feishu: [
    { key: 'appId', copy: 'feishu.appId', hint: 'feishu.credentialsHint', maxLength: 128 },
    { key: 'appSecret', copy: 'feishu.appSecret', maxLength: 512 },
  ],
  wecom: [
    { key: 'wecomBotId', copy: 'wecom.botId', maxLength: 128 },
    { key: 'secret', copy: 'wecom.secret', hint: 'wecom.ownerHint', maxLength: 512 },
  ],
  dingtalk: [
    { key: 'appKey', copy: 'dingtalk.appKey', maxLength: 256 },
    { key: 'appSecret', copy: 'dingtalk.appSecret', hint: 'dingtalk.ownerHint', maxLength: 512 },
  ],
  discord: [
    { key: 'token', copy: 'discord.token', maxLength: 256, valid: (v) => !/\s/.test(v) },
    { key: 'ownerUserId', copy: 'discord.owner', hint: 'discord.ownerHint', maxLength: 20, valid: OWNER_ID },
  ],
};
const FEISHU_SERVICES: BotImFeishuService[] = ['feishu', 'lark'];

/** Field copy is the settings page's own strings, so both entry points read the same. */
const settingsCopy = (key: string, botName: string) =>
  t(`bots.channels.add.${key}`).replaceAll('{{name}}', botName);

export function createBotImAuthorizationAdapter(options: {
  channel: BotImChannel;
  bot: { id: string; name: string };
  /** Re-validates the owner, the teammate link and its active status. */
  assertSession(): Promise<void>;
  /** The teammate currently linked to the session; must stay the card's teammate. */
  currentBotId(): Promise<string | null>;
}): BotAuthorizationAdapter {
  const { channel, bot } = options;
  const fields = FIELDS[channel];
  const values = new Map<string, string>();
  let service: BotImFeishuService = 'feishu';
  let revision = 0;
  let connected = false;
  const platform = (name: string) => t(`bots.channels.platform.${name}`);
  const actionId = (field: ImField, feishuService?: BotImFeishuService) =>
    `im-${channel}:${field.key}${feishuService ? `:${feishuService}` : ''}`;
  const locate = (id: string) => {
    for (const field of fields) {
      if (actionId(field) === id) return { field };
      for (const candidate of FEISHU_SERVICES)
        if (channel === 'feishu' && field.key === 'appId' && actionId(field, candidate) === id)
          return { field, service: candidate };
    }
    return null;
  };
  const item = (field: ImField, feishuService?: BotImFeishuService): GhostSetupAssessmentItem => {
    const fieldLabel = settingsCopy(`${field.copy}Label`, bot.name);
    const placeholder = settingsCopy(`${field.copy}Placeholder`, bot.name);
    const description = field.hint ? settingsCopy(field.hint, bot.name) : undefined;
    const label = feishuService ? `${platform(feishuService)} ${fieldLabel}` : fieldLabel;
    const action: GhostSetupAllowedAction = {
      id: actionId(field, feishuService),
      kind: 'inline_form',
      form: { fields: [{
        id: 'value', type: 'secret', label, placeholder,
        ...(description ? { description } : {}), required: true, maxLength: field.maxLength,
      }] },
    };
    const satisfied = values.has(field.key) && (!feishuService || service === feishuService);
    return { ref: action.id, kind: 'secret', label, state: satisfied ? 'satisfied' : 'missing', actions: [action] };
  };
  return {
    identity: {
      id: `im-${channel}`,
      name: channel === 'feishu' ? `${platform('feishu')} / ${platform('lark')}` : platform(channel),
    },
    async assess(): Promise<GhostSetupAssessment> {
      await options.assertSession();
      if (connected) return { state: 'ready', revision, groups: [] };
      return {
        state: 'required',
        revision,
        groups: fields.map((field) => ({
          id: `im-${channel}:${field.key}`,
          mode: 'any_of' as const,
          items: channel === 'feishu' && field.key === 'appId'
            ? FEISHU_SERVICES.map((candidate) => item(field, candidate))
            : [item(field)],
        })),
      };
    },
    // Completion is reported by execute(); no external writer to watch.
    subscribe: () => () => {},
    async execute(action, _sender, value, _onAuthorizationUrl, assertCurrent) {
      await options.assertSession();
      assertCurrent?.();
      if (action.kind !== 'inline_form' || value === undefined) return { ok: false, errorCode: 'INLINE_UNAVAILABLE' };
      const target = locate(action.id);
      if (!target) return { ok: false, errorCode: 'ACTION_STALE' };
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > target.field.maxLength || (target.field.valid && !target.field.valid(trimmed)))
        return { ok: false, errorCode: 'INLINE_INVALID' };
      const collected = new Map(values).set(target.field.key, trimmed);
      if (fields.some((field) => !collected.has(field.key))) {
        values.set(target.field.key, trimmed);
        if (target.service) service = target.service;
        revision += 1;
        return { ok: true };
      }
      // The card keeps its current state while connecting, so the failure lands on this step.
      const payload: Record<string, unknown> = {
        ...Object.fromEntries(collected), botId: bot.id, channel, service: target.service ?? service,
      };
      try {
        let input;
        try {
          input = parseBotImConnectionAddInput(payload);
        } catch {
          return { ok: false, errorCode: 'INLINE_INVALID' };
        }
        await options.assertSession();
        if ((await options.currentBotId()) !== bot.id) throw new Error('Authorization teammate changed');
        assertCurrent?.();
        try {
          await addBotImConnection(input);
        } catch (error) {
          // Only a stable code reaches the card; the platform's reason text stays out of it.
          if (!isIpcError(error)) return { ok: false, errorCode: 'SAVE_FAILED' };
          if (error.code === 'INVALID_PARAMS') return { ok: false, errorCode: 'INLINE_INVALID' };
          // Bot already connected elsewhere, or the platform rejected the credentials.
          if (error.code === 'PRECONDITION_FAILED' && !error.message.includes('BOT_INACTIVE'))
            return { ok: false, errorCode: 'AUTH_FAILED' };
          return { ok: false, errorCode: 'ACTION_FAILED' };
        }
        connected = true;
        return { ok: true };
      } finally {
        // Used once. After a failure every field is asked again, so a wrong earlier value can be fixed.
        values.clear();
        revision += 1;
      }
    },
  };
}
