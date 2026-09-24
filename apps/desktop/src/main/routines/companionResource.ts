import { throwIpcError } from '../utils/ipcValidate.js';
import { createHash } from 'node:crypto';
import type { RemoteActionInvokeRequest, RemoteActionInvokeResponse, RemoteResource, RemoteText } from '@cindy/device-link';
import { parseRoutineInput } from '@cindy/maker-scheduler';
import { routineTools } from './service.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { RemoteResourceRegistryError } from '../device-link/remoteResourceRegistry.js';
import { getBotRemoteResourceSource } from '../localDb/ipc/bots.js';
import { isBotVisibleRemotely } from '../localDb/ipc/botRemoteVisibility.js';

const text = (fallback: string, zh: string, tw: string, ja: string, ko: string): RemoteText => ({ fallback, translations: { 'zh-CN': zh, 'zh-TW': tw, ja, ko } });
const title = text('Routines', '例行任务', '例行任務', 'ルーティン', '루틴');
const ref = (id: string) => ({ collectionId: 'routines', kind: 'routine', id: `bot:${id}` });
function parseId(id: string): { botId: string; routineId?: string } {
  const parts = id.split('/');
  if (parts.length > 2 || parts.some((part) => !/^[a-zA-Z0-9_-]{1,128}$/.test(part)))
    throw new RemoteResourceRegistryError('NOT_FOUND', 'Invalid automation resource');
  return { botId: parts[0]!, ...(parts[1] ? { routineId: parts[1] } : {}) };
}
async function ownerGuard(botId: string): Promise<() => void> {
  const scope = activeOwnerScopeKey();
  const check = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scope)
      throw new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');
  };
  check();
  const bot = await getBotRemoteResourceSource(botId);
  check();
  if (!isBotVisibleRemotely(bot)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Teammate unavailable');
  return check;
}

/** Same owner-scoped routine service as Desktop, not the device-wide scheduler. */
export async function getBotRoutineRemoteResource(id: string): Promise<RemoteResource> {
  const { botId, routineId } = parseId(id);
  const check = await ownerGuard(botId);
  check();
  const routines = await routineTools.list(botId);
  check();
  const base = { ref: ref(id), display: { title }, links: [], revision: createHash('sha256').update(routines.map((r) => `${r.id}:${r.revision}:${r.activity ?? ''}`).join('|')).digest('hex') };
  if (!routineId) {
    const items = routines.slice(0, 100).map(({ id: key, name, enabled, revision, activity, triggers }) => ({
      id: key, name, enabled, revision, activity,
      triggers: triggers.map((trigger) => trigger.kind === 'cron'
        ? { kind: trigger.kind, expression: trigger.expression, timezone: trigger.timezone }
        : trigger.kind === 'interval' ? { kind: trigger.kind, intervalMs: trigger.intervalMs }
          : { kind: trigger.kind, sourceId: trigger.sourceId, eventType: trigger.eventType }),
    }));
    return { ...base, blocks: [{ id: 'routines', primitive: 'routine-list', fallbackMarkdown: items.map((r) => r.name).join('\n') || '—', data: { items } }],
      actions: [{ id: 'routine-create', label: text('New Routine', '新例行任务', '新例行任務', '新しいルーティン', '새 루틴') }] };
  }
  const routine = routines.find((r) => r.id === routineId);
  if (!routine && routineId !== 'new') throw new RemoteResourceRegistryError('NOT_FOUND', 'Automation unavailable');
  const [sources, history] = await Promise.all([routineTools.sources(), routine ? routineTools.history(botId, routineId) : []]);
  check();
  const input = routine ? parseRoutineInput(routine) : null;
  // Never truncate an editable definition and then save the truncated value.
  const editable = input === null || JSON.stringify(input).length <= 45_000;
  const data = {
    supportsPreRunCheck: true,
    id: routine?.id ?? null, revision: routine?.revision ?? 0, editable,
    input: editable ? input : null,
    sources: sources.slice(0, 64).map((s) => ({ id: s.id, name: s.name, status: s.status, events: s.events.slice(0, 32).map((e) => ({ type: e.type, name: e.name, fields: e.fields.slice(0, 64) })) })),
    history: history.slice(0, 20).map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt, finishedAt: r.finishedAt, resultText: r.resultText?.slice(0, 2000), error: r.error?.slice(0, 1000) })),
  };
  return { ...base, display: { title: routine?.name ?? text('New Routine', '新例行任务', '新例行任務', '新しいルーティン', '새 루틴') }, revision: String(routine?.revision ?? 0),
    blocks: [{ id: 'routine', primitive: 'routine-detail', fallbackMarkdown: routine?.name ?? '—', data }],
    actions: [
      ...(editable ? [{ id: routine ? 'routine-save' : 'routine-create', label: text('Save', '保存', '儲存', '保存', '저장') }] : []),
      ...(routine ? [
        { id: 'routine-run', label: text('Run Now', '立即运行', '立即執行', '今すぐ実行', '지금 실행'), confirmation: { title: text('Run this routine now?', '立即运行这项例行任务？', '立即執行這項例行任務？', '今すぐこのルーティンを実行しますか？', '지금 이 루틴을 실행할까요?') } },
        { id: 'routine-delete', label: text('Delete', '删除', '刪除', '削除', '삭제'), tone: 'destructive', confirmation: { title: text('Delete this routine?', '删除这项例行任务？', '刪除這項例行任務？', 'このルーティンを削除しますか？', '이 루틴을 삭제할까요?'), body: text('The routine and its run history will be removed.', '将删除这项例行任务及其运行记录。', '將刪除這項例行任務及其執行記錄。', 'ルーティンと実行履歴が削除されます。', '루틴과 실행 기록이 삭제됩니다。') } },
      ] : []),
    ] };
}

export async function invokeBotRoutineRemoteAction(id: string, request: RemoteActionInvokeRequest): Promise<RemoteActionInvokeResponse> {
  const { botId, routineId } = parseId(id);
  const check = await ownerGuard(botId);
  check();
  const input = request.input ?? {};
  const revision = input.revision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) throwIpcError('PRECONDITION_FAILED', 'Refresh before changing this automation');
  if (request.actionId === 'routine-create') {
    if (routineId && routineId !== 'new') throwIpcError('INVALID_PARAMS', 'Invalid create target');
    const requestId = input.requestId;
    if (revision !== 0 || typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) throwIpcError('INVALID_PARAMS', 'Invalid creation request');
    const creationId = createHash('sha256').update(JSON.stringify([botId, requestId])).digest('hex');
    await routineTools.createOnce(botId, parseRoutineInput(input.definition), creationId);
  } else {
    if (!routineId || routineId === 'new') throwIpcError('INVALID_PARAMS', 'Automation required');
    const routine = (await routineTools.list(botId)).find((r) => r.id === routineId);
    check();
    if (!routine || routine.revision !== revision) throwIpcError('PRECONDITION_FAILED', 'Automation changed; refresh before retrying');
    if (request.actionId === 'routine-save') {
      await routineTools.save(botId, parseRoutineInput(input.definition), routineId, Number(revision));
    } else if (request.actionId === 'routine-delete') {
      await routineTools.remove(botId, routineId, Number(revision));
    } else if (request.actionId === 'routine-run') {
      await routineTools.runNow(botId, routineId, Number(revision));
    } else throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'Unknown automation action');
  }
  check();
  return { effects: [{ kind: 'refresh-resource', ref: ref(botId) }] };
}
