/**
 * Renderer 侧「伙伴自有 IM 机器人连接」的读写入口(伙伴设置「消息平台」页)。
 *
 * 同一份 `botImConnection.list()` 投影 + `botImConnection:changed` 广播: 添加、移除与
 * 传输层状态变化都走广播刷新。线上类型与语义见 shared/botImConnection.ts。
 */
import { useEffect, useState } from 'react';

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
} from '../../../shared/botImConnection';

type BotImConnectionApi = Window['electronAPI']['botImConnection'];

export function botImConnectionApi(): BotImConnectionApi | null {
  // 副窗口 / 旧 preload 没有这个命名空间时整块功能静默隐藏, 不抛错。
  const api = (window as { electronAPI?: Partial<Window['electronAPI']> }).electronAPI
    ?.botImConnection;
  return api && typeof api.list === 'function' ? api : null;
}

export function useBotImConnections(): {
  payload: BotImConnectionListPayload | null;
  /** 首次读取还在途; 读取失败或没有 IPC 时为 false, payload 保持 null。 */
  loading: boolean;
  apply: (next: BotImConnectionListPayload) => void;
} {
  const [payload, setPayload] = useState<BotImConnectionListPayload | null>(null);
  const [loading, setLoading] = useState(() => botImConnectionApi() !== null);

  useEffect(() => {
    const api = botImConnectionApi();
    if (!api) return;
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
  }, []);

  return { payload, loading, apply: setPayload };
}

export function addBotImConnection(input: BotImConnectionAddInput): Promise<BotImConnectionAddResult> {
  const api = botImConnectionApi();
  if (!api) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.add(input);
}

export function removeBotImConnection(id: string): Promise<BotImConnectionRemoveResult> {
  const api = botImConnectionApi();
  if (!api) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.remove({ id });
}

/** 旧 preload 没有群聊接口时整个「群聊」小节不显示。 */
export function botImConnectionGroupsSupported(): boolean {
  const api = botImConnectionApi();
  return !!api && typeof api.listGroups === 'function' && typeof api.setGroupActivation === 'function';
}

export function listBotImConnectionGroups(id: string): Promise<BotImConnectionGroupsPayload> {
  const api = botImConnectionApi();
  if (!api?.listGroups) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.listGroups({ id });
}

export function setBotImConnectionGroupActivation(
  id: string,
  chatId: string,
  mode: BotImGroupActivationMode,
): Promise<BotImConnectionGroupsPayload> {
  const api = botImConnectionApi();
  if (!api?.setGroupActivation) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.setGroupActivation({ id, chatId, mode });
}

/** 旧 preload 没有隐藏任务接口时整个小节不显示。 */
export function botImConnectionLanesSupported(): boolean {
  const api = botImConnectionApi();
  return !!api && typeof api.listLanes === 'function' && typeof api.resetLane === 'function';
}

export function listBotImConnectionLanes(id: string): Promise<BotImConnectionLanesPayload> {
  const api = botImConnectionApi();
  if (!api?.listLanes) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.listLanes({ id });
}

/** 让一条隐藏任务重新开始(下一条消息从干净的上下文开始, 记录保留)。 */
export function resetBotImConnectionLane(id: string, sessionId: string): Promise<BotImConnectionLanesPayload> {
  const api = botImConnectionApi();
  if (!api?.resetLane) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.resetLane({ id, sessionId });
}

/** 设置 → IM 机器人 里可以移给伙伴的个人 bot; 旧 preload 没有这个接口时当作没有。 */
export function listAdoptablePersonalBots(): Promise<BotImAdoptablePersonalBotsPayload> {
  const api = botImConnectionApi();
  if (!api?.listAdoptable) return Promise.resolve({ bots: [] });
  return api.listAdoptable();
}

/** 把个人 bot 移给伙伴(个人 bot 随之清空)。 */
export function adoptPersonalBot(input: BotImAdoptPersonalBotInput): Promise<BotImConnectionAddResult> {
  const api = botImConnectionApi();
  if (!api?.adopt) return Promise.reject(new Error('botImConnection IPC unavailable'));
  return api.adopt(input);
}

/** 飞书 app id 打码(头 4 尾 4), 列表里不展示完整身份。 */
export function maskBotImContextId(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 8)}••••${value.slice(-4)}`;
}
