/**
 * chatTaskFocusIntent —— 「后台任务面板行点击 → 聊天流定位对应任务卡」的模块级通道。
 *
 * 约束:
 *  - 纯模块级 emitter,不落任何状态;本阶段只提供通道,消费端(聊天流滚动定位)
 *    接线归后续阶段。
 *  - listener 抛错不反噬调用方(与 lib/sidebarCommands 同口径)。
 */

type ChatTaskFocusListener = (sessionId: string, clientId: string) => void;

const listeners = new Set<ChatTaskFocusListener>();

/** 请求聊天流定位到 clientId 对应的任务卡。无订阅者时为 no-op。 */
export function requestChatTaskFocus(sessionId: string, clientId: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(sessionId, clientId);
    } catch {
      // listener 异常吞掉:通道不因单个坏订阅者失效。
    }
  }
}

/** 订阅定位请求;返回退订函数。 */
export function subscribeChatTaskFocus(cb: ChatTaskFocusListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
