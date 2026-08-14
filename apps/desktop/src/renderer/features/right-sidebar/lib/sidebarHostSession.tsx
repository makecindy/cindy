/**
 * sidebarHostSession — 标记「当前聊天流内嵌在哪个会话的右栏(RSB)里」。
 * ---------------------------------------------------------------------------
 * RSB 的 tab 桶按 session 划分,只有 Shell 当前注册的那个 session 的桶可见。
 * 协同(orca-workers)tab 挂在 lead 会话的桶里,里面内嵌 worker 会话的消息流;
 * worker 流里的入口(如变更卡的「审查」)若把 tab 开进 worker 自己的桶,用户
 * 永远看不到(MainLayout 对 session 不匹配的可见性请求有意只持久化不动 UI)。
 *
 * 该 context 由内嵌宿主(orca-workers tab body)提供 lead sessionId;消费方
 * (TurnChangesCard 等)据此把 tab 开到可见的宿主桶。默认 null = 消息流就是
 * 路由主实例,无需改桶。
 */

import { createContext, useContext, type ReactNode } from 'react';

const SidebarHostSessionContext = createContext<string | null>(null);

export function SidebarHostSessionProvider({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  return (
    <SidebarHostSessionContext.Provider value={sessionId}>
      {children}
    </SidebarHostSessionContext.Provider>
  );
}

/** 内嵌在 RSB tab 里时返回宿主(lead)sessionId;主实例返回 null。 */
export function useSidebarHostSessionId(): string | null {
  return useContext(SidebarHostSessionContext);
}
