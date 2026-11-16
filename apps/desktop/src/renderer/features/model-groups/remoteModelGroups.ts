/**
 * 给同账号的另一台电脑开新任务时，用那台电脑自己的模式(model-groups.md「在另一台电脑上开的新任务」)。
 * 模式列表、选路与提交都经 `model-groups:remote` 问那台；本机的模式与缓存(modelGroupsClient)一概不参与。
 *
 * 读取次数：进入这台电脑的草稿时读一次列表，那台重新上线时再读一次，不轮询；选路只在发送那一刻问一次。
 */
import { useEffect, useState } from 'react';
import { isSharedTaskPeer, MODEL_GROUPS_REMOTE_CHANNEL } from '@cindy/device-link';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { useDeviceLinkReconnectEpoch } from '@/features/device-link/useDeviceLinkReconnectEpoch';
import { createLogger } from '@/lib/logger';
import type { PluginModelRouteNote } from '@/lib/ccAgent.types';
import { extractIpcError } from '@/utils/ipcError';

import type { ModelGroupResolveRequest, ModelGroupResolveResult, ModelGroupSelection, ModelGroupsConfig } from '../../../shared/modelGroups';
import {
  parseModelGroupsRemoteList,
  parseModelGroupsRemoteResolve,
  type ModelGroupRemoteNote,
  type ModelGroupsRemoteRequest,
} from '../../../shared/modelGroupsRemote';

const log = createLogger('model-groups-remote');

/**
 * off = 不是给另一台电脑开的任务；loading = 正在读；ready = 读到了那台的模式；
 * unsupported = 那台版本较旧，不认识这个通道(或不是同账号的电脑)；error = 这次没读到(离线、超时等)，那台重新上线时再读。
 */
export type RemoteModelGroupsState =
  | { status: 'off' | 'loading' | 'unsupported' | 'error' }
  | { status: 'ready'; config: ModelGroupsConfig };

async function invoke(deviceId: string, request: ModelGroupsRemoteRequest): Promise<unknown> {
  return window.electronAPI.deviceLink.invoke(deviceId, MODEL_GROUPS_REMOTE_CHANNEL, [request]);
}

/** 旧版电脑不认识这个通道时，隧道回 CHANNEL_NOT_ALLOWED；同账号电脑以外的调用方也是这样被拒的。 */
export function isRemoteModelGroupsUnsupported(error: unknown): boolean {
  return extractIpcError(error)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED';
}

/** 读一次那台电脑的模式。 */
export async function readRemoteModelGroups(deviceId: string): Promise<ModelGroupsConfig> {
  return parseModelGroupsRemoteList(await invoke(deviceId, { action: 'list' }));
}

/** 那台电脑上当前账号的模式；deviceId 为空、共享任务访客或 enabled 为假时为 off。 */
export function useRemoteModelGroups(deviceId: string | undefined, enabled: boolean): RemoteModelGroupsState {
  const target = enabled && deviceId && !isSharedTaskPeer(deviceId) ? deviceId : undefined;
  const reconnectEpoch = useDeviceLinkReconnectEpoch(target);
  const [state, setState] = useState<{ key: string; value: RemoteModelGroupsState } | null>(null);
  const owner = getDataOwnerGeneration();
  const key = target ? `${owner.dataOwnerId ?? ''}\u0000${owner.generation}\u0000${target}` : null;
  useEffect(() => {
    if (!key || !target) return;
    let cancelled = false;
    const requestOwner = getDataOwnerGeneration();
    setState((previous) => (previous?.key === key && previous.value.status === 'ready' ? previous : { key, value: { status: 'loading' } }));
    readRemoteModelGroups(target)
      .then((config) => {
        if (!cancelled && isDataOwnerGenerationCurrent(requestOwner)) setState({ key, value: { status: 'ready', config } });
      })
      .catch((error: unknown) => {
        if (cancelled || !isDataOwnerGenerationCurrent(requestOwner)) return;
        const unsupported = isRemoteModelGroupsUnsupported(error);
        if (!unsupported) log.warn('remote model groups unavailable', error);
        // 已经读到过的保留：一次重读失败不让选择器里的模式消失。
        setState((previous) => (previous?.key === key && previous.value.status === 'ready' && !unsupported
          ? previous
          : { key, value: { status: unsupported ? 'unsupported' : 'error' } }));
      });
    return () => { cancelled = true; };
  }, [key, target, reconnectEpoch]);
  if (!key) return { status: 'off' };
  return state?.key === key ? state.value : { status: 'loading' };
}

/**
 * 请那台电脑按它自己的模式为这次新建选一个来源。读不到、超时或回包不对时抛错：调用方停下并保留输入，
 * 不改用原来的模型，也不改用本机的模式。
 */
export async function resolveRemoteModelGroup(
  deviceId: string,
  selection: ModelGroupSelection,
  context?: ModelGroupResolveRequest['context'],
): Promise<ModelGroupResolveResult> {
  return parseModelGroupsRemoteResolve(await invoke(deviceId, {
    action: 'resolve',
    selection,
    ...(context?.hasImages ? { context: { hasImages: true } } : {}),
  }));
}

/**
 * 任务在那台建好后提交这次选择，并把第一条消息下方的说明交给那台写进任务记录。
 * 失败只记日志：那台的「轮流」不前进、没有说明，任务本身不受影响。
 */
export function commitRemoteModelGroup(
  deviceId: string,
  result: ModelGroupResolveResult | null,
  sessionId: string,
  note: PluginModelRouteNote | null,
): void {
  if (!result?.decisionId) return;
  const remoteNote = note ? toRemoteNote(note) : null;
  void invoke(deviceId, {
    action: 'commit',
    decisionId: result.decisionId,
    ...(remoteNote ? { note: { sessionId, ...remoteNote } } : {}),
  }).catch((error: unknown) => log.warn('remote model group commit failed', error));
}

/** 本机说明里只有模型组用得到的字段交给那台；来源标记由那台写入时补上。 */
function toRemoteNote(note: PluginModelRouteNote): ModelGroupRemoteNote {
  return {
    pluginName: note.pluginName,
    outcome: note.outcome,
    modelName: note.modelName,
    ...(note.effort ? { effort: note.effort } : {}),
    ...(note.reason ? { reason: note.reason } : {}),
    ...(note.why === 'unavailable-route' ? { why: 'unavailable-route' as const } : {}),
  };
}
