import type { ManagementField } from '../../shared/settingsManagement.js';
import {
  BOT_NOTIFICATION_GROUP,
  BOT_NOTIFICATION_ITEMS,
  LIFECYCLE_ANNOUNCEMENT_FIELD,
  WECOM_GROUP_MESSAGE_FIELD,
  WECOM_GROUP_WEBHOOK_FIELD,
} from '../../shared/cloudBotNotifications.js';
import type {
  ManagementAction,
  ManagementCaller,
  ManagementEntry,
  ManagementExecution,
} from './management.js';
import { callCloudManagement, hasCloudManagementCall } from './managementCalls.js';
import {
  managementReadExecution,
  managementRecord,
  managementTextField,
} from './managementConnections.js';

const lifecycleField = (enabled: boolean): ManagementField => ({
  ...managementTextField(LIFECYCLE_ANNOUNCEMENT_FIELD, 'select'),
  options: [
    { value: 'on', label: 'management.options.on' },
    { value: 'off', label: 'management.options.off' },
  ],
  value: enabled ? 'on' : 'off',
});
// The client supplies the localized test text, like the local settings page.
const messageField = managementTextField(WECOM_GROUP_MESSAGE_FIELD);

type Snapshot = Record<string, unknown>;

/** One item whose actions re-read the target and refuse to act on a changed state. */
function entry(
  id: string,
  label: string,
  read: (execution: ManagementExecution) => Promise<Snapshot>,
  snapshot: Snapshot,
  identity: (state: Snapshot) => unknown[],
  item: Pick<ManagementEntry, 'status' | 'detail'>,
  actions: Array<{
    intent: ManagementAction['intent'];
    fields?: ManagementField[];
    run(values: Record<string, string>, execution: ManagementExecution): Promise<unknown>;
  }>,
): ManagementEntry {
  const revision = JSON.stringify(identity(snapshot));
  return {
    id,
    label,
    group: BOT_NOTIFICATION_GROUP,
    ...item,
    actions: actions.map(({ intent, fields = [], run }) => ({
      label: `management.actions.${intent}`,
      intent,
      resource: id,
      fields,
      async run(values, execution) {
        const fresh = await read(execution);
        execution.assertCurrent();
        if (JSON.stringify(identity(fresh)) !== revision) throw new Error('MANAGEMENT_CHANGED');
        const result = await run(values, execution);
        if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false)
          throw new Error('MANAGEMENT_SAVE_FAILED');
      },
    })),
  };
}

/** WeCom group webhook, Feishu and Discord notification controls of the personal bot cards.
 * The webhook is write-only: only `configured` and the same masked key the local page shows
 * are returned to the authenticated owner. Owner IDs are reduced to a bound/unbound status.
 */
export async function listBotNotificationManagement(
  caller: ManagementCaller,
  visible: (channel: 'wecom' | 'feishu' | 'discord') => boolean,
): Promise<ManagementEntry[]> {
  const readExecution = managementReadExecution(caller);
  const entries: ManagementEntry[] = [];
  const reader = (channel: string) => async (execution: ManagementExecution) =>
    managementRecord(await callCloudManagement(channel, [], execution));

  if (
    visible('wecom') &&
    [
      'wecomGroupNotification:get-state',
      'wecomGroupNotification:save-and-test',
      'wecomGroupNotification:test',
      'wecomGroupNotification:clear',
    ].every(hasCloudManagementCall)
  ) {
    const read = reader('wecomGroupNotification:get-state');
    const snapshot = await read(readExecution);
    const configured = snapshot.configured === true;
    const maskedKey = typeof snapshot.maskedKey === 'string' ? snapshot.maskedKey : undefined;
    entries.push(
      entry(
        BOT_NOTIFICATION_ITEMS.wecomGroup,
        'WeCom group notifications',
        read,
        snapshot,
        (state) => [state.configured === true, state.maskedKey ?? null],
        {
          status: configured ? 'connected' : 'disconnected',
          ...(maskedKey ? { detail: maskedKey } : {}),
        },
        configured
          ? [
              {
                intent: 'sync',
                fields: [messageField],
                run: (values, execution) =>
                  callCloudManagement(
                    'wecomGroupNotification:test',
                    [values[WECOM_GROUP_MESSAGE_FIELD]],
                    execution,
                  ),
              },
              {
                intent: 'delete',
                run: (_values, execution) =>
                  callCloudManagement('wecomGroupNotification:clear', [], execution),
              },
            ]
          : [
              {
                intent: 'create',
                fields: [managementTextField(WECOM_GROUP_WEBHOOK_FIELD, 'password'), messageField],
                run: (values, execution) =>
                  callCloudManagement(
                    'wecomGroupNotification:save-and-test',
                    [values[WECOM_GROUP_WEBHOOK_FIELD], values[WECOM_GROUP_MESSAGE_FIELD]],
                    execution,
                  ),
              },
            ],
      ),
    );
  }

  if (
    visible('feishu') &&
    hasCloudManagementCall('feishuBot:get-state') &&
    hasCloudManagementCall('feishuBot:set-lifecycle-announcement')
  ) {
    const read = reader('feishuBot:get-state');
    const snapshot = await read(readExecution);
    // Matches the local card: notification controls appear only once credentials are saved.
    if (snapshot.hasSecret === true) {
      const lifecycle = snapshot.lifecycleAnnouncement !== false;
      entries.push(
        entry(
          BOT_NOTIFICATION_ITEMS.feishu,
          'Feishu notifications',
          read,
          snapshot,
          (state) => [
            state.hasSecret === true,
            Boolean(state.ownerOpenId),
            state.lifecycleAnnouncement !== false,
          ],
          { status: snapshot.ownerOpenId ? 'connected' : 'disconnected' },
          [
            {
              intent: 'edit',
              fields: [lifecycleField(lifecycle)],
              run: (values, execution) =>
                callCloudManagement(
                  'feishuBot:set-lifecycle-announcement',
                  [{ enabled: values[LIFECYCLE_ANNOUNCEMENT_FIELD] === 'on' }],
                  execution,
                ),
            },
          ],
        ),
      );
    }
  }

  if (
    visible('discord') &&
    hasCloudManagementCall('discordBot:get-status') &&
    hasCloudManagementCall('discordBot:set-lifecycle-announcement')
  ) {
    const read = reader('discordBot:get-status');
    const snapshot = await read(readExecution);
    const lifecycle = snapshot.lifecycleAnnouncement !== false;
    entries.push(
      entry(
        BOT_NOTIFICATION_ITEMS.discord,
        'Discord notifications',
        read,
        snapshot,
        (state) => [state.lifecycleAnnouncement !== false],
        // The value lives in the edit field; the status carries no connection meaning here.
        { status: 'available' },
        [
          {
            intent: 'edit',
            fields: [lifecycleField(lifecycle)],
            run: (values, execution) =>
              callCloudManagement(
                'discordBot:set-lifecycle-announcement',
                [{ enabled: values[LIFECYCLE_ANNOUNCEMENT_FIELD] === 'on' }],
                execution,
              ),
          },
        ],
      ),
    );
  }
  return entries;
}
