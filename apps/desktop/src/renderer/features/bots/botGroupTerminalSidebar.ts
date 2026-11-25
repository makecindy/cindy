import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';

import {
  getDataOwnerGeneration,
  subscribeDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

const BOT_GROUP_TERMINAL_RSB_SESSION_PREFIX = '__bot_group_terminal__:';

/**
 * 群聊没有真实任务，但右栏按 sessionId 分桶。用「本机账号 + 群」合成一个临时桶：
 * main 查不到对应任务行，会把它当纯内存会话（persistable:false），不建占位任务、
 * 不落库；换账号或换群就是另一个桶，终端标签不会串。
 */
export function makeBotGroupTerminalSessionId(dataOwnerId: string, groupId: string): string {
  return `${BOT_GROUP_TERMINAL_RSB_SESSION_PREFIX}${dataOwnerId}:${groupId}`;
}

export function isBotGroupTerminalSessionId(sessionId: string | null | undefined): boolean {
  return !!sessionId && sessionId.startsWith(BOT_GROUP_TERMINAL_RSB_SESSION_PREFIX);
}

export interface BotGroupTerminalSidebarInput {
  groupId: string | null | undefined;
  dataOwnerId: string | null | undefined;
  homeDir: string | null | undefined;
}

export interface BotGroupTerminalSidebarState {
  available: boolean;
  sessionId: string | null;
  workdir: string | null;
}

/** 账号、群和主目录都已确定才开放；终端只在本机创建，起始目录固定为本机主目录。 */
export function resolveBotGroupTerminalSidebar(
  input: BotGroupTerminalSidebarInput,
): BotGroupTerminalSidebarState {
  const groupId = input.groupId?.trim();
  const dataOwnerId = input.dataOwnerId?.trim();
  const homeDir = input.homeDir?.trim();
  if (!groupId || !dataOwnerId || !homeDir) {
    return { available: false, sessionId: null, workdir: null };
  }
  return {
    available: true,
    sessionId: makeBotGroupTerminalSessionId(dataOwnerId, groupId),
    workdir: homeDir,
  };
}

let homeDirPromise: Promise<string | null> | null = null;

function loadHomeDir(): Promise<string | null> {
  if (!homeDirPromise) {
    const getHomeDir = window.electronAPI?.terminal?.getHomeDir;
    homeDirPromise = getHomeDir
      ? getHomeDir().then((dir) => (typeof dir === 'string' && dir ? dir : null), () => null)
      : Promise.resolve(null);
    void homeDirPromise.then((dir) => {
      if (!dir) homeDirPromise = null;
    });
  }
  return homeDirPromise;
}

interface ShellContext {
  setRightSidebarAvailable?: (available: boolean) => void;
  setRightSidebarSessionId?: (sessionId: string | null) => void;
  setRightSidebarWorkdir?: (
    workdir: string,
    remoteHostId?: string | null,
    deviceLinkDeviceId?: string | null,
  ) => void;
}

/**
 * 群聊页向主布局声明一个本机专属的右栏桶，让右上角按钮和「打开终端」快捷键
 * 走与任务页相同的路径（有终端则聚焦，无则新建，「+」可再开）。
 * 终端的输入输出只在本机 PTY 与本窗口之间流动，不经过群服务。
 */
export function useBotGroupTerminalSidebar(
  groupId: string | null | undefined,
  enabled: boolean,
  shell: ShellContext | null | undefined,
): BotGroupTerminalSidebarState {
  const dataOwnerId = useSyncExternalStore(
    subscribeDataOwnerGeneration,
    () => getDataOwnerGeneration().dataOwnerId,
  );
  const [homeDir, setHomeDir] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || homeDir) return;
    let cancelled = false;
    void loadHomeDir().then((dir) => {
      if (!cancelled && dir) setHomeDir(dir);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, homeDir]);

  const state = enabled
    ? resolveBotGroupTerminalSidebar({ groupId, dataOwnerId, homeDir })
    : { available: false, sessionId: null, workdir: null };

  const setAvailable = shell?.setRightSidebarAvailable;
  const setSessionId = shell?.setRightSidebarSessionId;
  const setWorkdir = shell?.setRightSidebarWorkdir;

  useLayoutEffect(() => {
    if (!state.available) return;
    setAvailable?.(true);
    return () => setAvailable?.(false);
  }, [state.available, setAvailable]);

  useLayoutEffect(() => {
    if (!state.sessionId) return;
    setSessionId?.(state.sessionId);
    return () => setSessionId?.(null);
  }, [state.sessionId, setSessionId]);

  useLayoutEffect(() => {
    if (!state.workdir) return;
    // null / null：已确认是本机，终端在本机以主目录启动。
    setWorkdir?.(state.workdir, null, null);
    return () => setWorkdir?.('', null, undefined);
  }, [state.workdir, setWorkdir]);

  return state;
}
