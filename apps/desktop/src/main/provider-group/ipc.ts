/**
 * 供应商组设置的 IPC：只接受本机应用窗口，不经设备互联代理(组是这台电脑上的设置)。
 */
import { ipcMain } from 'electron';

import { activeOwnerScopeKey } from '../appSessionState.js';

import {
  PROVIDER_GROUP_IPC,
  isProviderGroupProviderId,
  normalizeProviderGroupConfig,
  type ProviderGroupCommand,
  type ProviderGroupConfig,
  type ProviderGroupSessionGroup,
  type ProviderGroupView,
} from '../../shared/providerGroup.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { broadcast } from '../device-link/index.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { createLogger } from '../logger.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { pruneProviderGroupBindings } from './bindings.js';
import type { ProviderGroupDirectory } from './directory.js';
import type { ProviderGroupRouter } from './router.js';
import {
  getProviderGroupDirectory,
  getProviderGroupRemoteClient,
  getProviderGroupRouter,
  readProviderGroupOfSession,
} from './runtime.js';
import { listProviderGroups, readProviderGroup, writeProviderGroup } from './store.js';

const log = createLogger('provider-group');

export interface ProviderGroupCommandDeps {
  router: ProviderGroupRouter;
  directory: ProviderGroupDirectory;
  readGroup(providerId: string): ProviderGroupConfig | null;
  writeGroup(providerId: string, config: unknown): Promise<ProviderGroupConfig | null>;
  /** 解除指向已不在组里的电脑的任务绑定；keep 为 null = 整个组已删除。 */
  pruneBindings(providerId: string, keep: ReadonlySet<string> | null): Promise<void>;
  /** 当前账号：等远端目录期间换了账号时不写入(否则会把上一个账号的组写进新账号)。 */
  ownerKey(): string;
  /** 另一台电脑上某个供应商的组与组内电脑状态(设置页只读展示)。 */
  remoteView(deviceId: string, providerId: string): Promise<ProviderGroupView>;
  /** 本机全部组的设置(不读远端，模型列表据此收起本机组里的远程供应商)。 */
  listGroups(): Record<string, ProviderGroupConfig>;
  /** 这个任务此刻归哪个组(只读本机记录)。 */
  sessionGroup(sessionId: string): Promise<ProviderGroupSessionGroup>;
  changed(providerId: string): void;
}

const REMOTE_DEVICE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function parseProviderGroupCommand(raw: unknown): ProviderGroupCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throwIpcError('INVALID_PARAMS', 'command required');
  const value = raw as Record<string, unknown>;
  if (value.action === 'list') return { action: 'list' };
  if (value.action === 'session-group') {
    if (typeof value.sessionId !== 'string' || !SESSION_ID_PATTERN.test(value.sessionId)) {
      throwIpcError('INVALID_PARAMS', 'sessionId required');
    }
    return { action: 'session-group', sessionId: value.sessionId as string };
  }
  if (!isProviderGroupProviderId(value.providerId)) throwIpcError('INVALID_PARAMS', 'providerId required');
  const providerId = value.providerId as string;
  switch (value.action) {
    case 'get':
    case 'candidates':
    case 'delete':
      return { action: value.action, providerId };
    case 'remote-view': {
      if (typeof value.deviceId !== 'string' || !REMOTE_DEVICE_ID_PATTERN.test(value.deviceId)) {
        throwIpcError('INVALID_PARAMS', 'deviceId required');
      }
      return { action: 'remote-view', providerId, deviceId: value.deviceId as string };
    }
    case 'save': {
      if (!value.config || typeof value.config !== 'object') throwIpcError('INVALID_PARAMS', 'config required');
      return { action: 'save', providerId, config: value.config as ProviderGroupConfig };
    }
    default:
      throwIpcError('INVALID_PARAMS', 'unknown provider group action');
  }
}

/** 业务体(依赖注入，单测直接调)。 */
export async function executeProviderGroupCommand(deps: ProviderGroupCommandDeps, command: ProviderGroupCommand) {
  if (command.action === 'list') return deps.listGroups();
  if (command.action === 'session-group') return deps.sessionGroup(command.sessionId);
  const { providerId } = command;
  switch (command.action) {
    case 'get':
      return deps.router.view(providerId);
    case 'remote-view':
      return deps.remoteView(command.deviceId, providerId);
    case 'candidates':
      return deps.directory.listCandidates(providerId, deps.readGroup(providerId));
    case 'delete':
      await deps.writeGroup(providerId, null);
      await deps.pruneBindings(providerId, null);
      deps.changed(providerId);
      return deps.router.view(providerId);
    case 'save': {
      const owner = deps.ownerKey();
      const next = normalizeProviderGroupConfig(command.config, providerId);
      if (next) {
        // 新加入的电脑必须是这台电脑已经能用的同一个供应商(§3)，不能凭渲染端点名加入。
        const previous = new Set(deps.readGroup(providerId)?.members.map((m) => m.key) ?? []);
        const added = next.members.filter((m) => m.kind !== 'local' && !previous.has(m.key));
        if (added.length > 0) {
          const candidates = await deps.directory.listCandidates(providerId, deps.readGroup(providerId));
          const allowed = new Set(candidates.filter((c) => !c.blocked).map((c) => c.key));
          const rejected = added.filter((m) => !allowed.has(m.key));
          if (rejected.length > 0) {
            throwIpcError('PRECONDITION_FAILED', 'Only the same provider that this computer can already use can join the group');
          }
          // 显示名以目录为准，渲染端给的只是快照。
          const labels = new Map(candidates.map((c) => [c.key, c.label]));
          for (const member of next.members) {
            const label = labels.get(member.key);
            if (label) member.label = label;
          }
        }
      }
      if (deps.ownerKey() !== owner) {
        throwIpcError('PRECONDITION_FAILED', 'The account changed while saving the provider group');
      }
      const written = await deps.writeGroup(providerId, next);
      await deps.pruneBindings(providerId, written ? new Set(written.members.map((m) => m.key)) : null);
      deps.changed(providerId);
      return deps.router.view(providerId);
    }
  }
}

export function registerProviderGroupIpc(): void {
  const deps: ProviderGroupCommandDeps = {
    router: getProviderGroupRouter(),
    directory: getProviderGroupDirectory(),
    readGroup: readProviderGroup,
    writeGroup: writeProviderGroup,
    pruneBindings: pruneProviderGroupBindings,
    ownerKey: activeOwnerScopeKey,
    remoteView: (deviceId, providerId) => getProviderGroupRemoteClient().view(deviceId, providerId),
    listGroups: listProviderGroups,
    sessionGroup: readProviderGroupOfSession,
    changed: (providerId) => {
      try {
        broadcast(PROVIDER_GROUP_IPC.CHANGED, { providerId });
        // 同账号其他电脑的模型列表按本机目录里的组摘要收起组内电脑：组变化后让它们重读目录。
        tapWindowBroadcast(MAKER_PUSH.PROVIDER_CHANGED, {});
      } catch (error) {
        log.warn('provider group broadcast failed', { error: String(error) });
      }
    },
  };

  ipcMain.handle(PROVIDER_GROUP_IPC.COMMAND, async (event, raw: unknown) => {
    if (getDeviceLinkInvokeContext()) throwIpcError('PERMISSION_DENIED', 'Provider groups are local only');
    assertTrustedAppRendererEvent(event);
    return executeProviderGroupCommand(deps, parseProviderGroupCommand(raw));
  });
}
