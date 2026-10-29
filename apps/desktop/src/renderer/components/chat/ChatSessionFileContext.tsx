/**
 * ChatSessionFileContext — 聊天流「会话文件来源」上下文。
 * ---------------------------------------------------------------------------
 * 聊天消息流里大量深层组件(ToolCallCard / AgentActionRow / TextLightbox /
 * useFileChipContextMenu / MarkdownRenderer …)需要知道当前会话的文件字节在哪台
 * 机器上(见 lib/sessionFileOrigin.ts),但它们分布在很深的渲染层级、且多数没有
 * session props。用 Context 在 MessageStream 顶层 provide 一次,深层组件按需消费,
 * 避免把 sessionId / workingDir / origin 三件套一层层钻 props。
 *
 * 设计要点:
 *  - **默认值 = 本地来源**:聊天流之外复用这些组件(workdir-browse、skillhub、
 *    设置页等)时拿到 local 默认值,行为与引入 Context 前逐字节一致。
 *  - **deviceId 订阅在 provider 收敛一处**:origin 注册(sessionId→deviceId)可能
 *    晚于远程会话首次渲染(remoteProjectsStore 显式处理的 origin-injection race),
 *    必须 useSyncExternalStore 订阅而非一次性读取。此前 MarkdownRenderer 等是每个
 *    消息实例各订阅一份,收敛到 provider 后整棵树只订阅一次。
 *  - **value 引用稳定**:按 [sessionId, workingDir, remoteHostId, deviceId] memo;
 *    一个会话生命周期内 value 至多变一次(deviceId 迟到注册),不会造成全体消费者
 *    反复重渲。TextLightbox 等 portal 组件不断 React Context 链,照常可消费。
 */
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';

import { getSessionDeviceId, remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  LOCAL_FILE_ORIGIN,
  resolveSessionFileOrigin,
  type SessionFileOrigin,
} from '@/lib/sessionFileOrigin';

/** Context 值:会话标识 + 工作目录 + 文件来源。 */
export interface ChatSessionFileContextValue {
  /** 当前会话 id;聊天流之外(默认值)为 undefined。 */
  sessionId: string | undefined;
  /**
   * 会话工作目录(远程会话时是**远端机器上的**绝对路径,不能拿来查本机文件系统;
   * 相对路径解析 / workdir 内外判定用)。默认值为空串。
   */
  workingDir: string;
  /** 文件来源判别(local / device / ssh)。 */
  origin: SessionFileOrigin;
}

const DEFAULT_VALUE: ChatSessionFileContextValue = Object.freeze({
  sessionId: undefined,
  workingDir: '',
  origin: LOCAL_FILE_ORIGIN,
});

const ChatSessionFileContext = createContext<ChatSessionFileContextValue>(DEFAULT_VALUE);

/** 消费入口:聊天流内 = 当前会话的文件上下文;聊天流外 = local 默认值。 */
export function useChatSessionFile(): ChatSessionFileContextValue {
  return useContext(ChatSessionFileContext);
}

/** 便捷消费:只取文件来源。 */
export function useSessionFileOrigin(): SessionFileOrigin {
  return useContext(ChatSessionFileContext).origin;
}

/**
 * 值构造 hook(MessageStream 顶层调用一次):deviceId 从 remoteProjectsStore 订阅
 * 取得(device-link 远程会话),remoteHostId 来自 session DB 行(SSH 会话),合成
 * origin(deviceId 优先,见 resolveSessionFileOrigin)。构造出的 value 除了喂给
 * Provider,MessageStream 自身也用它取 galleryDeviceId —— 画廊与渲染改写必须同源,
 * 否则 ImageLightbox 的 src 匹配会失效。
 */
export function useChatSessionFileValue(
  sessionId: string | undefined,
  workingDir: string,
  remoteHostId: string | null | undefined,
  knownDeviceId?: string | null,
): ChatSessionFileContextValue {
  const inferredDeviceId = useSyncExternalStore(remoteProjectsStore.subscribe, () =>
    sessionId ? getSessionDeviceId(sessionId) : undefined,
  );
  const deviceId = knownDeviceId === undefined ? inferredDeviceId : knownDeviceId ?? undefined;
  return useMemo<ChatSessionFileContextValue>(
    () => ({
      sessionId,
      workingDir,
      origin: resolveSessionFileOrigin(deviceId, remoteHostId),
    }),
    [sessionId, workingDir, remoteHostId, deviceId],
  );
}

/** 瘦 Provider:value 由 useChatSessionFileValue 构造(引用已稳定,直接透传)。 */
export function ChatSessionFileProvider({
  value,
  children,
}: {
  value: ChatSessionFileContextValue;
  children: ReactNode;
}) {
  return <ChatSessionFileContext.Provider value={value}>{children}</ChatSessionFileContext.Provider>;
}
