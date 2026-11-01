/**
 * Renderer 侧「伙伴自有 IM 机器人连接」的读写入口(伙伴设置「消息平台」页)。
 *
 * 同一份 `botImConnection.list()` 投影 + `botImConnection:changed` 广播: 添加、移除与
 * 传输层状态变化都走广播刷新。线上类型与语义见 shared/botImConnection.ts。
 */
import { useEffect, useRef, useState } from 'react';

import type {
  BotImAdoptablePersonalBotsPayload,
  BotImAdoptPersonalBotInput,
  BotImConnectionAddInput,
  BotImConnectionAddResult,
  BotImConnectionGroupsPayload,
  BotImConnectionLanesPayload,
  BotImConnectionListPayload,
  BotImConnectionRemoveResult,
  BotImGroupActivationMode,
  BotImGuestAccessUpdate,
} from '../../../shared/botImConnection';

export type BotImConnectionApi = Window['electronAPI']['botImConnection'];

export function botImConnectionApi(): BotImConnectionApi | null {
  // 副窗口 / 旧 preload 没有这个命名空间时整块功能静默隐藏, 不抛错。
  const api = (window as { electronAPI?: Partial<Window['electronAPI']> }).electronAPI
    ?.botImConnection;
  return api && typeof api.list === 'function' ? api : null;
}

/**
 * `scope` says which computer's connections these are (the settings target); the API object itself is read
 * when the subscription starts, because a window API is not a render-stable identity.
 */
export function useBotImConnections(api: BotImConnectionApi | null = botImConnectionApi(), scope: unknown = null): {
  payload: BotImConnectionListPayload | null;
  /** 首次读取还在途; 读取失败或没有 IPC 时为 false, payload 保持 null。 */
  loading: boolean;
  apply: (next: BotImConnectionListPayload) => void;
} {
  const [payload, setPayload] = useState<BotImConnectionListPayload | null>(null);
  const [loading, setLoading] = useState(() => api !== null);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    setPayload(null);
    let cancelled = false;
    const unsubscribe = api.onChanged((next) => {
      if (!cancelled) setPayload(next);
    });
    void api
      .list()
      .then((next) => {
        // 列表在途时先到的广播更新, 不被这份旧快照盖掉。
        if (!cancelled) setPayload((current) => current ?? next);
      })
      .catch(() => {
        // 读不到时按「还没有连接」展示; 下一次广播会补上。
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [scope]);

  return { payload, loading, apply: setPayload };
}

export function addBotImConnection(api: BotImConnectionApi | null, input: BotImConnectionAddInput): Promise<BotImConnectionAddResult> {
  if (!api) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.add(input);
}

export function removeBotImConnection(api: BotImConnectionApi | null, id: string): Promise<BotImConnectionRemoveResult> {
  if (!api) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.remove({ id });
}

/** 旧 preload 没有群聊接口时整个「群聊」小节不显示。 */
export function botImConnectionGroupsSupported(api: BotImConnectionApi | null = botImConnectionApi()): boolean {
  return !!api && typeof api.listGroups === 'function' && typeof api.setGroupActivation === 'function';
}

export function listBotImConnectionGroups(api: BotImConnectionApi | null, id: string): Promise<BotImConnectionGroupsPayload> {
  if (!api?.listGroups) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.listGroups({ id });
}

export function setBotImConnectionGroupActivation(
  api: BotImConnectionApi | null,
  id: string,
  chatId: string,
  mode: BotImGroupActivationMode,
): Promise<BotImConnectionGroupsPayload> {
  if (!api?.setGroupActivation) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.setGroupActivation({ id, chatId, mode });
}

/** 旧 preload 没有隐藏任务接口时整个小节不显示。 */
export function botImConnectionLanesSupported(api: BotImConnectionApi | null = botImConnectionApi()): boolean {
  return !!api && typeof api.listLanes === 'function' && typeof api.resetLane === 'function';
}

export function listBotImConnectionLanes(api: BotImConnectionApi | null, id: string): Promise<BotImConnectionLanesPayload> {
  if (!api?.listLanes) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.listLanes({ id });
}

/** 让一条隐藏任务重新开始(下一条消息从干净的上下文开始, 记录保留)。 */
export function resetBotImConnectionLane(api: BotImConnectionApi | null, id: string, sessionId: string): Promise<BotImConnectionLanesPayload> {
  if (!api?.resetLane) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.resetLane({ id, sessionId });
}

/** Old preload keeps viewing/restart available without advertising archive. */
export function botImConnectionLaneArchiveSupported(api: BotImConnectionApi | null = botImConnectionApi()): boolean {
  return typeof api?.archiveLane === 'function';
}

export function archiveBotImConnectionLane(api: BotImConnectionApi | null, id: string, sessionId: string): Promise<BotImConnectionLanesPayload> {
  if (!api?.archiveLane) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.archiveLane({ id, sessionId });
}

/** 设置 → IM 机器人 里可以移给伙伴的个人 bot; 旧 preload 没有这个接口时当作没有。 */
export function listAdoptablePersonalBots(api: BotImConnectionApi | null): Promise<BotImAdoptablePersonalBotsPayload> {
  if (!api?.listAdoptable) return Promise.resolve({ bots: [] });
  return api.listAdoptable();
}

/** 把个人 bot 移给伙伴(个人 bot 随之清空)。 */
export function adoptPersonalBot(api: BotImConnectionApi | null, input: BotImAdoptPersonalBotInput): Promise<BotImConnectionAddResult> {
  if (!api?.adopt) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.adopt(input);
}

/** 飞书 app id 打码(头 4 尾 4), 列表里不展示完整身份。 */
export function maskBotImContextId(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 8)}••••${value.slice(-4)}`;
}

export function botImConnectionGuestAccessSupported(api: BotImConnectionApi | null = botImConnectionApi()): boolean {
  return !!api && typeof api.setGuestAccess === 'function' && typeof api.listLanes === 'function';
}

/** Owner-only: bind / unbind one guest, or choose what unbound guests get (#8359). */
export function setBotImConnectionGuestAccess(
  api: BotImConnectionApi | null,
  update: BotImGuestAccessUpdate,
): Promise<BotImConnectionListPayload> {
  if (!api?.setGuestAccess) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.setGuestAccess(update);
}
