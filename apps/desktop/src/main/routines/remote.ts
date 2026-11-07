import { SUPPORTED_LOCALES } from '../../shared/locale.js';
import { t } from '../i18n.js';
import { getBotRoutineRemoteResource, invokeBotRoutineRemoteAction } from './companionResource.js';
import type { createBotRemoteSettingsResource } from '../localDb/ipc/botRemoteSettingsResource.js';
import { randomUUID } from 'node:crypto';
import type {
  RemoteResource,
  RemoteLocalizedText,
  RemoteActionDescriptor,
} from '@cindy/device-link';
import type { Routine } from '@cindy/maker-scheduler';
import {
  remoteResourceRegistry,
  RemoteResourceRegistryError,
} from '../device-link/remoteResourceRegistry.js';
import { listBotRemoteResourceSources } from '../localDb/ipc/bots.js';
import { getRoutineEngine, routineTools } from './service.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';

const copy = (key: string): RemoteLocalizedText => ({
  fallback: t(key, 'en'),
  translations: Object.fromEntries(SUPPORTED_LOCALES.map(locale => [locale, t(key, locale)])),
});
const title = copy('routines.title');
const name = copy('routines.name');
const instructions = copy('routines.instructions');
const add = copy('routines.add');
const save = copy('routines.save');
const runNow = copy('routines.runNow');
const remove = copy('routines.delete');
const pause = copy('routines.remote.pause');
const resume = copy('routines.remote.resume');
const addTime = copy('routines.remote.addSchedule');
const addInterval = copy('routines.remote.addInterval');
const minutesField = {
  id: 'minutes',
  label: copy('routines.minutes'),
  kind: 'text',
  required: true,
};
const addEvent = copy('routines.remote.addEvent');
const removeTrigger = copy('routines.removeTrigger');
const timeField = {
  id: 'cron',
  label: copy('routines.expression'),
  kind: 'text',
  required: true,
  placeholder: '0 9 * * 1-5',
};
const zoneField = {
  id: 'timezone',
  label: copy('routines.timezone'),
  kind: 'text',
  required: true,
  placeholder: Intl.DateTimeFormat().resolvedOptions().timeZone,
};
const ref = (id: string) => ({ collectionId: 'routines', kind: 'routine', id });

function item(routine: Routine): RemoteResource {
  return {
    ref: ref(routine.id),
    revision: String(routine.revision),
    display: {
      title: routine.name,
      preview: routine.prompt,
      timestamp: routine.updatedAt,
      status: {
        label: routine.enabled
          ? copy('routines.enabled')
          : copy('routines.paused'),
      },
    },
    links: [],
  };
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A required field is empty');
  return value;
}

/** Portable resource/action primitives keep the mobile client free of a separate Routine data model. */
let registered = false;
export function registerRoutineRemoteResources(management?: ReturnType<typeof createBotRemoteSettingsResource>): void {
  if (registered) return;
  registered = true;
  remoteResourceRegistry.register({
    collection: {
      id: 'routines',
      resourceKind: 'routine',
      title,
      placement: 'home-scope',
      icon: { name: 'clock', fallbackText: '◷' },
    },
    async list(_context, request) {
      const scope = activeOwnerScopeKey();
      const bots = (await listBotRemoteResourceSources()).filter((bot) => bot.status === 'active');
      const engine = await getRoutineEngine();
      if (scope !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
        throw new Error('Account changed');
      const visible = new Set(bots.map((bot) => bot.id));
      const rows = engine.list().filter((routine) => visible.has(routine.botId));
      const items = rows
        .filter(
          (routine) =>
            !request.query ||
            routine.name.toLocaleLowerCase().includes(request.query.toLocaleLowerCase()),
        )
        .map(item);
      if (!request.query)
        for (const bot of bots)
          items.push({
            ref: ref(`bot:${bot.id}`),
            revision: String(bot.currentVersion),
            display: { title: bot.name, subtitle: add },
            links: [],
          });
      const offset = Number(request.cursor ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid cursor');
      const limit = Math.min(request.limit ?? 100, 200);
      return {
        collectionId: 'routines',
        revision: items.map((row) => row.revision).join(':'),
        items: items.slice(offset, offset + limit),
        ...(offset + limit < items.length ? { nextCursor: String(offset + limit) } : {}),
      };
    },
    async get(context, request) {
      if (management && request.ref.id.startsWith('bot:') && request.client.primitives.some(value => value === 'routine-list' || value === 'routine-detail')) {
        const id = request.ref.id.slice(4);
        const resource = await getBotRoutineRemoteResource(id);
        return management.bindResource(context, resource, async () => (await getBotRoutineRemoteResource(id)).revision,
          request => invokeBotRoutineRemoteAction(id, request));
      }
      const scope = activeOwnerScopeKey();
      const id = request.ref.id;
      if (id.startsWith('bot:')) {
        const botId = id.slice(4);
        await routineTools.list(botId);
        return {
          ref: ref(id),
          revision: '1',
          display: { title: add },
          links: [],
          actions: [
            {
              id: 'create',
              label: add,
              fields: [
                { id: 'name', label: name, kind: 'text', required: true },
                { id: 'prompt', label: instructions, kind: 'multiline', required: true },
                timeField,
                zoneField,
              ],
            },
          ],
        };
      }
      const engine = await getRoutineEngine();
      if (scope !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
        throw new Error('Account changed');
      const routine = engine.list().find((row) => row.id === id);
      if (!routine) throw new RemoteResourceRegistryError('NOT_FOUND', 'Routine not found');
      const history = await routineTools.history(routine.botId, id);
      if (scope !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
        throw new Error('Account changed');
      const actions: RemoteActionDescriptor[] = [
        { id: 'run', label: runNow },
        { id: 'toggle', label: routine.enabled ? pause : resume },
        {
          id: 'edit',
          label: save,
          fields: [
            { id: 'name', label: name, kind: 'text', placeholder: routine.name },
            { id: 'prompt', label: instructions, kind: 'multiline', placeholder: routine.prompt },
          ],
        },
        { id: 'add-time', label: addTime, fields: [timeField, zoneField] },
        { id: 'add-interval', label: addInterval, fields: [minutesField] },
      ];
      const events = engine
        .listSources()
        .flatMap((source) =>
          source.events.map((event) => ({
            value: JSON.stringify([source.id, event.type]),
            label: `${source.name} · ${event.name}`,
          })),
        );
      if (events.length)
        actions.push({
          id: 'add-event',
          label: addEvent,
          fields: [
            { id: 'event', label: addEvent, kind: 'select', required: true, options: events },
            {
              id: 'field',
              label: copy('routines.remote.filterField'),
              kind: 'text',
            },
            { id: 'value', label: copy('routines.operators.equals'), kind: 'text' },
          ],
        });
      if (routine.triggers.length > 1)
        actions.push({
          id: 'remove-trigger',
          label: removeTrigger,
          fields: [
            {
              id: 'trigger',
              label: removeTrigger,
              kind: 'select',
              required: true,
              options: routine.triggers.map((trigger) => ({
                value: trigger.id,
                label:
                  trigger.kind === 'cron'
                    ? `${trigger.expression} · ${trigger.timezone}`
                    : trigger.kind === 'interval'
                      ? `${trigger.intervalMs / 60000} min`
                      : trigger.kind === 'once' ? new Date(trigger.at).toISOString() : `${trigger.sourceId} · ${trigger.eventType}`,
              })),
            },
          ],
        });
      actions.push({
        id: 'delete',
        label: remove,
        tone: 'destructive',
        confirmation: { title: remove, confirmLabel: remove },
      });
      return {
        ...item(routine),
        actions,
        blocks: [
          {
            id: 'instructions',
            primitive: 'markdown',
            title: instructions,
            fallbackMarkdown: routine.prompt,
          },
          {
            id: 'triggers',
            primitive: 'markdown',
            title: addTime,
            fallbackMarkdown: routine.triggers
              .map((trigger) =>
                trigger.kind === 'cron'
                  ? `${trigger.expression} · ${trigger.timezone}`
                  : trigger.kind === 'interval'
                    ? `${trigger.intervalMs / 60000} min`
                    : trigger.kind === 'once' ? new Date(trigger.at).toISOString() : `${trigger.sourceId} · ${trigger.eventType}\n${trigger.filters.map((filter) => `${filter.field} ${filter.operator} ${filter.value}`).join('\n')}`,
              )
              .join('\n\n'),
          },
          {
            id: 'history',
            primitive: 'markdown',
            title: copy('routines.history'),
            fallbackMarkdown: history
              .slice(0, 100)
              .map(
                (run) =>
                  `${new Date(run.createdAt).toISOString()} · ${run.status}${run.error ? `\n${run.error}` : ''}`,
              )
              .join('\n\n'),
          },
        ],
      };
    },
    async invoke(context, request) {
      if (management && request.resourceRef?.id.startsWith('bot:')
        && /^[0-9a-f-]{36}$/.test(request.actionId)) return management.invoke(context, request);
      const scope = activeOwnerScopeKey();
      const id = request.resourceRef?.id;
      if (!id) throw new Error('Routine reference is required');
      const input = request.input ?? {};
      if (id.startsWith('bot:') && request.actionId === 'create') {
        const created = await routineTools.save(id.slice(4), {
          name: text(input.name),
          prompt: text(input.prompt),
          enabled: true,
          triggers: [
            {
              id: randomUUID(),
              kind: 'cron',
              expression: text(input.cron),
              timezone: text(input.timezone),
            },
          ],
        });
        return {
          effects: [
            { kind: 'refresh-collection', collectionId: 'routines' },
            { kind: 'navigate', target: { kind: 'resource', ref: ref(created.id) } },
          ],
        };
      }
      const engine = await getRoutineEngine();
      if (scope !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
        throw new Error('Account changed');
      const routine = engine.list().find((row) => row.id === id);
      if (!routine) throw new RemoteResourceRegistryError('NOT_FOUND', 'Routine not found');
      switch (request.actionId) {
        case 'run':
          await routineTools.runNow(routine.botId, id);
          break;
        case 'delete':
          await routineTools.remove(routine.botId, id);
          break;
        case 'toggle':
          await routineTools.save(routine.botId, { ...routine, enabled: !routine.enabled }, id);
          break;
        case 'edit':
          await routineTools.save(
            routine.botId,
            {
              ...routine,
              name: input.name ? text(input.name) : routine.name,
              prompt: input.prompt ? text(input.prompt) : routine.prompt,
            },
            id,
          );
          break;
        case 'add-time':
          await routineTools.save(
            routine.botId,
            {
              ...routine,
              triggers: [
                ...routine.triggers,
                {
                  id: randomUUID(),
                  kind: 'cron',
                  expression: text(input.cron),
                  timezone: text(input.timezone),
                },
              ],
            },
            id,
          );
          break;
        case 'add-interval':
          await routineTools.save(
            routine.botId,
            {
              ...routine,
              triggers: [
                ...routine.triggers,
                {
                  id: randomUUID(),
                  kind: 'interval',
                  intervalMs: Number(text(input.minutes)) * 60000,
                },
              ],
            },
            id,
          );
          break;
        case 'add-event': {
          const [sourceId, eventType] = JSON.parse(text(input.event)) as unknown[];
          if (
            typeof sourceId !== 'string' ||
            typeof eventType !== 'string' ||
            !engine
              .listSources()
              .some(
                (source) =>
                  source.id === sourceId && source.events.some((event) => event.type === eventType),
              )
          )
            throw new Error('Unknown event source');
          await routineTools.save(
            routine.botId,
            {
              ...routine,
              triggers: [
                ...routine.triggers,
                {
                  id: randomUUID(),
                  kind: 'event',
                  sourceId,
                  eventType,
                  filters: input.field
                    ? [{ field: text(input.field), operator: 'equals', value: text(input.value) }]
                    : [],
                },
              ],
            },
            id,
          );
          break;
        }
        case 'remove-trigger':
          await routineTools.save(
            routine.botId,
            {
              ...routine,
              triggers: routine.triggers.filter((trigger) => trigger.id !== text(input.trigger)),
            },
            id,
          );
          break;
        default:
          throw new Error('Unknown routine action');
      }
      return {
        effects: [
          { kind: 'refresh-collection', collectionId: 'routines' },
          ...(request.actionId === 'delete'
            ? []
            : [{ kind: 'refresh-resource' as const, ref: ref(id) }]),
        ],
      };
    },
  });
}
