import { ghostDeclaresHiddenTasks, type InstalledGhost } from '../../shared/ghost.js';
import type { PluginTaskRequest, PluginTaskResult } from '../../shared/pluginTasks.js';
import { isPluginTaskPermissionMode, isPluginTeamPlanWithinBudget } from '../../shared/pluginTasks.js';
import { hasPluginTaskApproval, hasPluginTargetApproval } from './taskCapability.js';
import {
  PLUGIN_ATTACHMENT_KINDS,
  PLUGIN_ATTACHMENT_MAX_BYTES,
  PLUGIN_ATTACHMENT_MAX_COUNT,
  PLUGIN_ATTACHMENT_MAX_ITEM_BYTES,
  PLUGIN_CONTEXT_ATTACHMENT_MAX_COUNT,
  validPluginMessageAttachmentSet,
} from '../../shared/pluginAttachments.js';
import { validPluginMessageContext } from '../../shared/pluginMessage.js';
import { MESSAGE_SOURCE_RELAY_LIMITS } from '@cindy/maker-shared/message-source';

export const PLUGIN_TASK_OPERATIONS = [
  'capabilities',
  'models',
  'imProjects',
  'followImProject',
  'setModel',
  'requestWriteAccess',
  'startTeam',
  'getTeam',
  'setTeamPlan',
  'releaseWorker',
  'create',
  'list',
  'get',
  'send',
  'getRun',
  'listRuns',
  'cancel',
  'readMessages',
  'setHidden',
  'archive',
] as const;
export type PluginTaskHandler = (pluginId: string, request: PluginTaskRequest) => Promise<unknown>;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const hasControlChar = (v: string) => Array.from(v).some(ch => {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;
});
/** tasks.send relay: exact keys at every level; display context only, never a sender identity. */
function validPluginTaskRelay(v: unknown): boolean {
  const limits = MESSAGE_SOURCE_RELAY_LIMITS;
  if (!object(v) || Object.keys(v).some(k => !['platform', 'chatType', 'chatName', 'sender'].includes(k))) return false;
  const platform = typeof v.platform === 'string' ? v.platform.trim() : '';
  if (!platform || platform.length > limits.platform || hasControlChar(platform)) return false;
  if (v.chatType !== 'group' && v.chatType !== 'direct') return false;
  if (v.chatName !== undefined && (typeof v.chatName !== 'string' || v.chatName.length > limits.chatName)) return false;
  const sender = v.sender;
  if (!object(sender) || Object.keys(sender).some(k => !['id', 'name', 'isOwner'].includes(k))) return false;
  return text(sender.id, limits.senderId) && text(sender.name, limits.senderName) && typeof sender.isOwner === 'boolean';
}
export function validPluginTaskRequest(value: unknown): value is PluginTaskRequest {
  if (!object(value) || value.type !== 'tasks-request') return false;
  const allowed: Record<string, string[]> = {
    capabilities: [],
    models: [],
    imProjects: [],
    followImProject: ['taskId', 'expectedRevision', 'imProject'],
    setModel: ['taskId', 'expectedRevision', 'route'],
    create: ['requestKey', 'title', 'autoTitle', 'route', 'permissionMode', 'isolatedWorkspace', 'callId', 'hidden', 'imProject'],
    list: ['after', 'limit'],
    get: ['taskId'],
    requestWriteAccess: ['taskId', 'mode'],
    startTeam: ['taskId'],
    getTeam: ['taskId'],
    setTeamPlan: ['taskId', 'plan'],
    releaseWorker: ['taskId', 'workerId', 'completedAt'],
    send: ['taskId', 'requestKey', 'expectedRevision', 'text', 'context', 'attachments', 'contextAttachments', 'invocationId', 'relay'],
    getRun: ['runId'],
    listRuns: ['taskId', 'after', 'limit'],
    readMessages: ['taskId', 'after', 'limit'],
    cancel: ['runId', 'requestKey'],
    setHidden: ['taskId', 'hidden'],
    archive: ['taskId'],
  };
  if (typeof value.kind !== 'string' || !Object.hasOwn(allowed, value.kind)) return false;
  const kind = value.kind;
  if (value.mobilePageId !== undefined && (typeof value.mobilePageId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.mobilePageId))) return false;
  if (Object.keys(value).some((key) => !['type', 'kind', 'mobilePageId', ...allowed[kind]].includes(key)))
    return false;
  if (kind === 'requestWriteAccess' && value.mode !== undefined && !['acceptEdits', 'auto'].includes(String(value.mode))) return false;
  const requires = (key: string) => text(value[key], 128);
  if (value.imProject !== undefined && (!text(value.imProject, 4096) || (value.imProject as string).includes('\0'))) return false;
  if (kind === 'create' && value.imProject !== undefined &&
    ['route', 'permissionMode', 'callId', 'isolatedWorkspace'].some(key => value[key] !== undefined)) return false;
  if (kind === 'followImProject' && (!requires('taskId') || !text(value.imProject, 4096) ||
    !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0)) return false;
  if (['create', 'send', 'cancel'].includes(value.kind) && !requires('requestKey')) return false;
  if (['get', 'setModel', 'send', 'listRuns', 'readMessages', 'requestWriteAccess', 'startTeam', 'getTeam', 'setTeamPlan', 'releaseWorker', 'setHidden', 'archive'].includes(value.kind) && !requires('taskId'))
    return false;
  if (kind === 'setHidden' && typeof value.hidden !== 'boolean') return false;
  if (value.hidden !== undefined && typeof value.hidden !== 'boolean') return false;
  if (value.permissionMode !== undefined && !isPluginTaskPermissionMode(value.permissionMode)) return false;
  if (['getRun', 'cancel'].includes(value.kind) && !requires('runId')) return false;
  const pluginDefault = kind === 'setModel' && value.route === 'plugin-default';
  if (kind === 'setModel' && ((!pluginDefault && !object(value.route)) || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0)) return false;
  if (value.callId !== undefined && !text(value.callId, 128)) return false;
  if (value.invocationId !== undefined && !text(value.invocationId, 128)) return false;
  if (value.isolatedWorkspace !== undefined && typeof value.isolatedWorkspace !== 'boolean') return false;
  if (value.kind === 'create' && (
    (value.autoTitle !== undefined && typeof value.autoTitle !== 'boolean') ||
    (value.autoTitle === true ? value.title !== undefined : !text(value.title, 100))
  )) return false;
  // A relayed photo, video or file may arrive without words, like an IM message: empty text
  // is allowed only alongside the message's own attachments.
  const attachmentOnly = value.text === '' && Array.isArray(value.attachments) && value.attachments.length > 0;
  if (
    value.kind === 'send' &&
    ((!text(value.text, 32768) && !attachmentOnly) || !validPluginMessageContext(value.text as string, value.context) ||
      !validPluginMessageAttachmentSet(value.attachments, value.contextAttachments) ||
      !Number.isSafeInteger(value.expectedRevision) ||
      (value.expectedRevision as number) < 0)
  )
    return false;
  if (value.relay !== undefined && !validPluginTaskRelay(value.relay)) return false;
  if (value.after !== undefined && !text(value.after, 1024)) return false;
  if (
    value.limit !== undefined &&
    (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100)
  )
    return false;
  if (kind === 'releaseWorker' && (!requires('workerId') || !Number.isSafeInteger(value.completedAt) || (value.completedAt as number) <= 0)) return false;
  if (kind === 'setTeamPlan') {
    const p = value.plan;
    if (!isPluginTeamPlanWithinBudget(p)) return false;
    if (!object(p) || Object.keys(p).some(k => !['concurrency','items','task'].includes(k)) ||
        (p.concurrency !== null && (!Number.isSafeInteger(p.concurrency) || (p.concurrency as number) < 1)) ||
        !Array.isArray(p.items) || !p.items.length || p.items.length > 1000) return false;
    if (p.task !== undefined && !text(p.task, 8000)) return false;
    const labels = new Set<string>();
    for (const item of p.items) {
      if (!object(item) || Object.keys(item).some(k => !['label','workingDir','route','task'].includes(k)) ||
          !text(item.label,32) || !/^[a-z0-9][a-z0-9_-]*$/.test(String(item.label)) || labels.has(String(item.label)) || !text(item.workingDir,4096) ||
          !validPluginTaskRequest({type:'tasks-request',kind:'create',requestKey:'validate',title:'validate',route:item.route}) || !item.route) return false;
      if (item.task !== undefined && !text(item.task, 8000)) return false;
      labels.add(String(item.label));
    }
  }
  if (value.route !== undefined && !pluginDefault) {
    const r = value.route;
    if (
      !object(r) ||
      Object.keys(r).some(
        (k) => !['agentKind', 'providerId', 'model', 'effort', 'fastMode', 'agentDeviceId'].includes(k),
      )
    )
      return false;
    if (
      (r.agentDeviceId !== undefined && (typeof r.agentDeviceId !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(r.agentDeviceId) || r.agentDeviceId === 'local')) ||
      !['cc', 'codex', 'pi'].includes(String(r.agentKind)) ||
      !text(r.providerId, 128) ||
      !text(r.model, 256) ||
      (typeof r.effort !== 'string' || r.effort.length > 32) ||
      (typeof r.fastMode !== 'boolean' && r.fastMode !== 'ultrafast')
    )
      return false;
  }
  return true;
}

/** Sender binding is performed by the pipe; the payload can never claim a plugin identity. */
export async function handlePluginTaskRequest(
  pluginId: string,
  value: unknown,
  deps: {
    getGhost(id: string): InstalledGhost | null;
    handler: PluginTaskHandler | null;
    isCurrent: () => boolean;
    ensureAuthorized?: () => Promise<boolean>;
    ensureTargetsAuthorized?: () => Promise<boolean>;
  },
): Promise<PluginTaskResult> {
  const permitted = () =>
    deps.isCurrent() &&
    hasPluginTaskApproval(deps.getGhost(pluginId));
  const error = (code: string, message: string, retryable = false): PluginTaskResult => ({
    ok: false,
    error: { code, message, retryable },
  });
  if (!validPluginTaskRequest(value)) return error('INVALID_REQUEST', 'Invalid task request');
  if (!permitted() && deps.ensureAuthorized) {
    try { await deps.ensureAuthorized(); } catch { /* No UI or persistence failure grants nothing. */ }
  }
  if (!permitted()) return error('PERMISSION_DENIED', 'Plugin task capability is unavailable');
  const needsTargets = value.kind === 'imProjects' || value.kind === 'followImProject' ||
    (value.kind === 'create' && value.imProject !== undefined);
  if (needsTargets && !hasPluginTargetApproval(deps.getGhost(pluginId)) &&
    deps.getGhost(pluginId)?.manifest.agent?.targets === true && deps.ensureTargetsAuthorized) {
    try { await deps.ensureTargetsAuthorized(); } catch { /* The existing Host consent flow alone grants access. */ }
  }
  if (needsTargets && (!permitted() || !hasPluginTargetApproval(deps.getGhost(pluginId))))
    return error('PERMISSION_DENIED', 'Shared IM projects require agent.targets approval');
  // Background tasks need their own manifest declaration (agent.hiddenTasks with tasks);
  // hidden:false on create is the default and stays available to every tasks plugin.
  const declaresHiddenTasks = () => ghostDeclaresHiddenTasks(deps.getGhost(pluginId)?.manifest);
  if (((value.kind === 'create' && value.hidden === true) || value.kind === 'setHidden') && !declaresHiddenTasks())
    return error('PERMISSION_DENIED', 'Background tasks require agent.hiddenTasks in ghost.json');
  if (value.kind === 'capabilities')
    return {
      ok: true,
      data: {
        version: 1,
        experimental: true,
        operations: PLUGIN_TASK_OPERATIONS,
        targets: ['own-plugin-local-session'],
        maxPageSize: 100,
        exactRoute: true,
        remoteRoutes: true,
        pluginDefaultModel: true,
        sourceCallContext: true,
        invocationContext: true,
        messageContext: true,
        messageRelay: true,
        autoTitle: true,
        createPermissionMode: true,
        // getRun returns optional preview.text while the run's own execution is streaming.
        runPreview: true,
        imProjects: true,
        messageAttachments: {
          kinds: PLUGIN_ATTACHMENT_KINDS, maxCount: PLUGIN_ATTACHMENT_MAX_COUNT, maxBytes: PLUGIN_ATTACHMENT_MAX_BYTES,
          maxItemBytes: PLUGIN_ATTACHMENT_MAX_ITEM_BYTES, attachmentOnly: true,
          // tasks.send `contextAttachments`: model-only references sharing the maxBytes budget.
          contextMaxCount: PLUGIN_CONTEXT_ATTACHMENT_MAX_COUNT,
        },
        hiddenTasks: declaresHiddenTasks(),
      },
    };
  if (!deps.handler) return error('HOST_NOT_READY', 'Task service is not ready', true);
  try {
    const data = await deps.handler(pluginId, value);
    if (!permitted() || (needsTargets && !hasPluginTargetApproval(deps.getGhost(pluginId))))
      return error('PERMISSION_DENIED', 'Plugin task capability is unavailable');
    return { ok: true, data };
  } catch (err) {
    // Only explicit public errors cross the sandbox boundary, never internal DB/path errors.
    if (
      object(err) &&
      err.name === 'PluginTaskError' &&
      typeof err.code === 'string' &&
      typeof err.message === 'string'
    ) {
      return error(err.code, err.message, err.retryable === true);
    }
    return error(
      'HOST_NOT_READY',
      'Task operation could not be confirmed; reuse the same request key',
      true,
    );
  }
}
