import type {
  ManagementCommand,
  ManagementItem,
  ManagementResult,
  ManagementField,
} from '../../../shared/settingsManagement';
import {
  BOT_NOTIFICATION_GROUP,
  BOT_NOTIFICATION_ITEMS,
  LIFECYCLE_ANNOUNCEMENT_FIELD,
  WECOM_GROUP_MESSAGE_FIELD,
  WECOM_GROUP_WEBHOOK_FIELD,
} from '../../../shared/cloudBotNotifications';

/** DEV-only in-memory authorization. No external URLs or provider IPC are invoked. */
export function createTrialAuthorization() {
  const definitions = [
    { section: 'providers', id: 'openai', label: 'OpenAI', kind: 'device' as const },
    { section: 'providers', id: 'anthropic', label: 'Claude', kind: 'callback' as const },
    { section: 'providers', id: 'xai', label: 'xAI', kind: 'browser' as const },
    ...['slack', 'telegram', 'x'].map((id) => ({
      section: 'bots',
      id: `official:${id}`,
      label: id === 'x' ? 'X' : id === 'slack' ? 'Slack' : 'Telegram',
      kind: 'browser' as const,
    })),
    { section: 'bots', id: 'wechat', label: 'WeChat', kind: 'browser' as const },
    ...(['wecom', 'feishu', 'dingtalk', 'discord', 'telegram'] as const).map((id) => ({
      section: 'bots',
      id,
      label: id,
      kind: 'browser' as const,
    })),
  ];
  const fields = (id: string): ManagementField[] => {
    const names: Record<string, string[]> = {
      wecom: ['botId', 'secret'],
      feishu: ['appId', 'appSecret'],
      dingtalk: ['appKey', 'appSecret'],
      discord: ['token', 'ownerUserId'],
      telegram: ['token', 'ownerUserId'],
    };
    const result: ManagementField[] = (names[id] ?? []).map((name) => ({
      name,
      label: name,
      kind: ['token', 'secret', 'appSecret'].includes(name) ? 'password' : 'text',
      required: true,
      maxLength: 512,
    }));
    if (id === 'feishu')
      result.push({
        name: 'service',
        label: 'service',
        kind: 'select',
        required: true,
        maxLength: 512,
        value: 'feishu',
        options: [
          { value: 'feishu', label: 'Feishu' },
          { value: 'lark', label: 'Lark' },
        ],
      });
    return result;
  };
  const connected = new Set<string>();
  const tickets = new Map<string, { id: string; disconnect: boolean }>();
  // Notification items: in-memory only; a trial test never sends a WeCom message.
  const notify = { webhook: false, feishu: true, discord: true };
  const notifyTickets = new Map<string, (values: Record<string, string>) => void>();
  const field = (name: string, kind: ManagementField['kind'], value?: string) =>
    ({
      name,
      label: name,
      kind,
      required: true,
      maxLength: kind === 'password' ? 8192 : 512,
      ...(kind === 'select'
        ? {
            value,
            options: [
              { value: 'on', label: 'on' },
              { value: 'off', label: 'off' },
            ],
          }
        : {}),
    }) as ManagementField;
  const notificationItems = (): ManagementItem[] => {
    const action = (
      intent: ManagementItem['actions'][number]['intent'],
      fields: ManagementField[],
      apply: (values: Record<string, string>) => void,
    ) => {
      const id = crypto.randomUUID();
      notifyTickets.set(id, apply);
      return { id, intent, label: 'Trial', fields, expiresAt: Date.now() + 300_000 };
    };
    const lifecycle = (key: 'feishu' | 'discord') =>
      action(
        'edit',
        [field(LIFECYCLE_ANNOUNCEMENT_FIELD, 'select', notify[key] ? 'on' : 'off')],
        (v) => {
          notify[key] = v[LIFECYCLE_ANNOUNCEMENT_FIELD] === 'on';
        },
      );
    return [
      {
        id: BOT_NOTIFICATION_ITEMS.wecomGroup,
        label: 'WeCom group notifications',
        group: BOT_NOTIFICATION_GROUP,
        status: notify.webhook ? 'connected' : 'disconnected',
        ...(notify.webhook ? { detail: '••••demo' } : {}),
        actions: notify.webhook
          ? [
              action('sync', [field(WECOM_GROUP_MESSAGE_FIELD, 'text')], () => undefined),
              action('delete', [], () => {
                notify.webhook = false;
              }),
            ]
          : [
              action(
                'create',
                [
                  field(WECOM_GROUP_WEBHOOK_FIELD, 'password'),
                  field(WECOM_GROUP_MESSAGE_FIELD, 'text'),
                ],
                () => {
                  notify.webhook = true;
                },
              ),
            ],
      },
      ...(connected.has('feishu')
        ? [
            {
              id: BOT_NOTIFICATION_ITEMS.feishu,
              label: 'Feishu notifications',
              group: BOT_NOTIFICATION_GROUP,
              status: 'connected' as const,
              actions: [lifecycle('feishu')],
            },
          ]
        : []),
      {
        id: BOT_NOTIFICATION_ITEMS.discord,
        label: 'Discord notifications',
        group: BOT_NOTIFICATION_GROUP,
        status: 'available',
        actions: [lifecycle('discord')],
      },
    ];
  };
  const operations = new Map<
    string,
    { id: string; view: Extract<ManagementResult, { kind: 'operation' }> }
  >();
  return async (command: ManagementCommand): Promise<ManagementResult> => {
    if (command.operation === 'list') {
      const items: ManagementItem[] = definitions
        .filter((d) => d.section === command.section)
        .map(({ id, label, section }) => {
          const actionId = crypto.randomUUID();
          tickets.set(actionId, { id, disconnect: connected.has(id) });
          return {
            id: `${section === 'bots' ? 'bot' : 'provider'}:${id}`,
            ...(section === 'bots'
              ? {
                  group: id.startsWith('official:')
                    ? 'management.officialBots'
                    : 'management.personalBots',
                }
              : {}),
            label,
            status: connected.has(id) ? 'connected' : 'disconnected',
            actions: [
              {
                id: actionId,
                intent: connected.has(id)
                  ? 'disconnect'
                  : fields(id).length
                    ? 'connect'
                    : 'authorize',
                label: 'Trial',
                fields: connected.has(id) ? [] : fields(id),
                expiresAt: Date.now() + 300_000,
              },
            ],
          };
        });
      if (command.section === 'bots') items.push(...notificationItems());
      return { kind: 'page', section: command.section, offset: 0, items };
    }
    if (command.operation === 'run') {
      const old = operations.get(command.operationId);
      if (old) return structuredClone(old.view);
      const apply = notifyTickets.get(command.actionId);
      if (apply) {
        notifyTickets.delete(command.actionId);
        apply(command.values);
        const view = {
          kind: 'operation' as const,
          operationId: command.operationId,
          phase: 'succeeded' as const,
        };
        operations.set(command.operationId, { id: 'notify', view });
        return structuredClone(view);
      }
      const ticket = tickets.get(command.actionId);
      if (!ticket) throw new Error('EXPIRED');
      tickets.delete(command.actionId);
      const definition = definitions.find((d) => d.id === ticket.id)!;
      if (ticket.disconnect) connected.delete(ticket.id);
      const direct = fields(ticket.id).length > 0;
      if (direct && !ticket.disconnect) connected.add(ticket.id);
      const view: Extract<ManagementResult, { kind: 'operation' }> = {
        kind: 'operation',
        operationId: command.operationId,
        phase: ticket.disconnect || direct ? 'succeeded' : 'waiting',
        ...(!ticket.disconnect && !direct
          ? {
              prompt: {
                kind: definition.kind,
                url: 'https://example.com/cloud-settings-trial',
                expiresAt: Date.now() + 300_000,
                ...(definition.kind === 'device' ? { userCode: 'DEMO-2026' } : {}),
              },
            }
          : {}),
      };
      operations.set(command.operationId, { id: ticket.id, view });
      return structuredClone(view);
    }
    const operation = operations.get(command.operationId);
    if (!operation)
      return { kind: 'operation', operationId: command.operationId, phase: 'unknown' };
    if (operation.view.prompt && operation.view.prompt.expiresAt <= Date.now())
      operation.view = { kind: 'operation', operationId: command.operationId, phase: 'expired' };
    if (command.operation === 'cancel')
      operation.view = { kind: 'operation', operationId: command.operationId, phase: 'unknown' };
    if (command.operation === 'respond') {
      if (operation.view.phase !== 'waiting') throw new Error('NOT_WAITING');
      connected.add(operation.id);
      operation.view = { kind: 'operation', operationId: command.operationId, phase: 'succeeded' };
    }
    return structuredClone(operation.view);
  };
}
