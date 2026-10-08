/**
 * 当前聊天流所属任务的 Agent 是否在另一台电脑运行(MessageStream 顶层 provide)。
 *
 * 消息级「分叉」依赖本机的 Agent 会话记录；这类任务的会话记录在那台电脑上，入口先隐藏
 * (与 SSH 远程任务一致)。默认值 false：聊天流之外以及本机任务的行为不变。
 */
import { createContext, useContext } from 'react';

export const AgentOnOtherDeviceContext = createContext(false);

export function useAgentOnOtherDevice(): boolean {
  return useContext(AgentOnOtherDeviceContext);
}
