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

const copy = (
  fallback: string,
  zh: string,
  tw: string,
  ja: string,
  ko: string,
): RemoteLocalizedText => ({ fallback, translations: { 'zh-CN': zh, 'zh-TW': tw, ja, ko } });
const title = copy('Routines', '例行任务', '例行任務', 'ルーティン', '루틴');
const name = copy('Name', '名称', '名稱', '名前', '이름');
const instructions = copy('Instructions', '指令', '指令', '指示', '지침');
const add = copy('Add Routine', '添加例行任务', '新增例行任務', 'ルーティンを追加', '루틴 추가');
const save = copy('Save Routine', '保存例行任务', '儲存例行任務', 'ルーティンを保存', '루틴 저장');
const runNow = copy('Run Now', '立即运行', '立即執行', '今すぐ実行', '지금 실행');
const remove = copy(
  'Delete Routine',
  '删除例行任务',
  '刪除例行任務',
  'ルーティンを削除',
  '루틴 삭제',
);
const pause = copy(
  'Pause Routine',
  '暂停例行任务',
  '暫停例行任務',
  'ルーティンを一時停止',
  '루틴 일시 중지',
);
const resume = copy(
  'Resume Routine',
  '恢复例行任务',
  '恢復例行任務',
  'ルーティンを再開',
  '루틴 재개',
);
const addTime = copy(
  'Add Schedule',
  '添加定时条件',
  '新增定時條件',
  'スケジュールを追加',
  '일정 추가',
);
const addInterval = copy('Add Interval', '添加间隔条件', '新增間隔條件', '間隔を追加', '간격 추가');
const minutesField = {
  id: 'minutes',
  label: copy('Minutes', '分钟', '分鐘', '分', '분'),
  kind: 'text',
  required: true,
};
const addEvent = copy(
  'Add Event Trigger',
  '添加事件触发器',
  '新增事件觸發器',
  'イベントトリガーを追加',
  '이벤트 트리거 추가',
);
const removeTrigger = copy(
  'Remove Trigger',
  '移除触发器',
  '移除觸發器',
  'トリガーを削除',
  '트리거 제거',
);
const timeField = {
  id: 'cron',
  label: copy('Cron Expression', 'Cron 表达式', 'Cron 表達式', 'Cron 式', 'Cron 표현식'),
  kind: 'text',
  required: true,
  placeholder: '0 9 * * 1-5',
};
const zoneField = {
  id: 'timezone',
  label: copy('Time Zone', '时区', '時區', 'タイムゾーン', '시간대'),
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
          ? copy('Enabled', '已启用', '已啟用', '有効', '활성화됨')
          : copy('Paused', '已暂停', '已暫停', '一時停止中', '일시 중지됨'),
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
export function registerRoutineRemoteResources(): void {
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
    async get(_context, request) {
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
              label: copy(
                'Filter Field',
                '筛选字段',
                '篩選欄位',
                '絞り込みフィールド',
                '필터 필드',
              ),
              kind: 'text',
            },
            { id: 'value', label: copy('Equals', '等于', '等於', '一致', '같음'), kind: 'text' },
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
                      : `${trigger.sourceId} · ${trigger.eventType}`,
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
                    : `${trigger.sourceId} · ${trigger.eventType}\n${trigger.filters.map((filter) => `${filter.field} ${filter.operator} ${filter.value}`).join('\n')}`,
              )
              .join('\n\n'),
          },
          {
            id: 'history',
            primitive: 'markdown',
            title: copy('Run History', '运行历史', '執行歷史', '実行履歴', '실행 기록'),
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
    async invoke(_context, request) {
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
