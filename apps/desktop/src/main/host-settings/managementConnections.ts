import type { ManagementField, ManagementItem } from '../../shared/settingsManagement.js';
import type {
  ManagementAction,
  ManagementCaller,
  ManagementEntry,
  ManagementExecution,
} from './management.js';
import { callCloudManagement, hasCloudManagementCall } from './managementCalls.js';

export const managementTextField = (
  name: string,
  kind: ManagementField['kind'] = 'text',
  required = true,
  value?: string,
): ManagementField => ({
  name,
  label: `management.fields.${name}`,
  kind,
  required,
  maxLength: kind === 'password' ? 8192 : 512,
  ...(value !== undefined ? { value } : {}),
});
export const managementReadExecution = (caller: ManagementCaller): ManagementExecution => ({
  signal: new AbortController().signal,
  assertCurrent: caller.assertCurrent,
  prompt() {
    throw new Error('MANAGEMENT_READ_ONLY');
  },
  onCancel() {
    throw new Error('MANAGEMENT_READ_ONLY');
  },
});
export function managementRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('MANAGEMENT_INVALID_RESULT');
  return value as Record<string, unknown>;
}
export const managementStatus = (raw: unknown): ManagementItem['status'] => {
  const value =
    typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object'
        ? (raw as { kind?: unknown }).kind
        : undefined;
  if (
    value === 'connected' ||
    value === 'connecting' ||
    value === 'conflict' ||
    value === 'offline' ||
    value === 'error'
  )
    return value;
  if (
    value === 'testing' ||
    value === 'reconnecting' ||
    value === 'authorizing' ||
    value === 'waiting_confirmation'
  )
    return 'connecting';
  return 'disconnected';
};
export async function managementWait(
  check: () => Promise<boolean>,
  execution: ManagementExecution,
): Promise<void> {
  while (true) {
    execution.assertCurrent();
    if (await check()) {
      execution.assertCurrent();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new Error('MANAGEMENT_CANCELLED'));
      };
      const timer = setTimeout(() => {
        execution.signal.removeEventListener('abort', abort);
        resolve();
      }, 1000);
      execution.signal.addEventListener('abort', abort, { once: true });
      if (execution.signal.aborted) abort();
    });
  }
}
type Bot = {
  id: string;
  label: string;
  read: string;
  connect: string;
  disconnect: string;
  reconnect?: string;
  fields: ManagementField[];
};
const personalBots: Bot[] = [
  {
    id: 'wecom',
    label: 'WeCom',
    read: 'wecomBot:get-status',
    connect: 'wecomBot:set-config',
    disconnect: 'wecomBot:disconnect',
    reconnect: 'wecomBot:reconnect',
    fields: [managementTextField('botId'), managementTextField('secret', 'password')],
  },
  {
    id: 'feishu',
    label: 'Feishu / Lark',
    read: 'feishuBot:get-state',
    connect: 'feishuBot:save',
    disconnect: 'feishuBot:clear',
    reconnect: 'feishuBot:reconnect',
    fields: [
      managementTextField('appId'),
      managementTextField('appSecret', 'password'),
      {
        ...managementTextField('service', 'select'),
        options: [
          { value: 'feishu', label: 'Feishu' },
          { value: 'lark', label: 'Lark' },
        ],
        value: 'feishu',
      },
    ],
  },
  {
    id: 'dingtalk',
    label: 'DingTalk',
    read: 'dingtalkBot:get-state',
    connect: 'dingtalkBot:save',
    disconnect: 'dingtalkBot:clear',
    reconnect: 'dingtalkBot:reconnect',
    fields: [managementTextField('appKey'), managementTextField('appSecret', 'password')],
  },
  {
    id: 'discord',
    label: 'Discord',
    read: 'discordBot:get-status',
    connect: 'discordBot:set-config',
    disconnect: 'discordBot:disconnect',
    fields: [managementTextField('token', 'password'), managementTextField('ownerUserId')],
  },
  {
    id: 'telegram',
    label: 'Telegram',
    read: 'telegramBot:get-status',
    connect: 'telegramBot:set-config',
    disconnect: 'telegramBot:disconnect',
    reconnect: 'telegramBot:set-online',
    fields: [managementTextField('token', 'password'), managementTextField('ownerUserId')],
  },
];

/** Client-equivalent personal bot forms; values are write-only and never projected. */
export async function listPersonalBotManagement(
  caller: ManagementCaller,
  visible: (id: string) => boolean,
  allowLark = true,
): Promise<ManagementEntry[]> {
  const readExecution = managementReadExecution(caller);
  const entries: ManagementEntry[] = [];
  for (const bot of personalBots) {
    if (
      !visible(bot.id) ||
      !hasCloudManagementCall(bot.read) ||
      !hasCloudManagementCall(bot.connect)
    )
      continue;
    const read = async (execution: ManagementExecution) =>
      managementRecord(await callCloudManagement(bot.read, [], execution));
    const snapshot = await read(readExecution);
    const status = managementStatus(snapshot.status);
    // Use only stable identity/state in the precondition; never hash or return saved secrets.
    const identity = (state: Record<string, unknown>) =>
      JSON.stringify([
        state.appId,
        state.appKey,
        state.botId,
        state.ownerUserId,
        state.service,
        state.hasSecret,
        state.hasSavedCreds,
        managementStatus(state.status),
      ]);
    const revision = identity(snapshot);
    const action = (
      intent: ManagementAction['intent'],
      channel: string,
      fields: ManagementField[] = [],
    ): ManagementAction => ({
      label: `management.actions.${intent}`,
      intent,
      resource: `bot:${bot.id}`,
      fields,
      ...(intent === 'disconnect' ? { confirmation: 'management.confirm.disconnect' } : {}),
      async run(values, execution) {
        const fresh = await read(execution);
        execution.assertCurrent();
        if (identity(fresh) !== revision) throw new Error('MANAGEMENT_CHANGED');
        const result = managementRecord(
          await callCloudManagement(
            channel,
            channel === 'telegramBot:set-online'
              ? [{ online: true }]
              : fields.length
                ? [values]
                : [],
            execution,
          ),
        );
        if (result.saveErrorStatus || result.verdict === 'error' || result.verdict === 'conflict')
          throw new Error('MANAGEMENT_CONNECTION_FAILED');
        await managementWait(async () => {
          const current = await read(execution),
            next = managementStatus(current.status);
          if (intent === 'disconnect') return next === 'disconnected';
          if (next === 'error' || next === 'conflict' || next === 'offline')
            throw new Error('MANAGEMENT_CONNECTION_FAILED');
          return next === 'connected';
        }, execution);
      },
    });
    const fields =
      bot.id === 'feishu' && !allowLark
        ? bot.fields.map((field) =>
            field.name === 'service'
              ? { ...field, options: field.options!.filter((option) => option.value === 'feishu') }
              : field,
          )
        : bot.fields;
    const actions = [action('connect', bot.connect, fields)];
    if (
      status !== 'disconnected' ||
      snapshot.hasSavedCreds ||
      snapshot.hasSecret ||
      snapshot.appId ||
      snapshot.appKey ||
      snapshot.botId ||
      snapshot.ownerUserId
    ) {
      if (bot.reconnect && hasCloudManagementCall(bot.reconnect))
        actions.push(action('reconnect', bot.reconnect));
      actions.push(action('disconnect', bot.disconnect));
    }
    entries.push({
      id: `bot:${bot.id}`,
      label: bot.label,
      group: 'management.personalBots',
      status,
      actions,
    });
  }
  return entries;
}
