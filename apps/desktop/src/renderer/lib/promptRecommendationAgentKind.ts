import type { AgentKind } from '@/hooks/useAgentCapabilities';

/**
 * 输入建议预测用的「已确认会话引擎」。
 *
 * 插件引擎(ACP)任务没有内置 Harness 身份:runtimeAgentKind 为 null,但会话已确认为
 * ACP 时 pluginEngineSession 在。两者都没有 = 会话信息尚未就绪,返回 null 让调用方等待,
 * 不能拿模型选择器的默认值(claude-code)补成内置引擎——否则后端按 DB 的 dbAgentKind
 * 核对时会拒绝这笔请求(#13694)。
 *
 * 启用条件、回调入口与 IPC 参数必须共用这个值,三处口径才不会分叉。
 */
export function promptRecommendationAgentKind(input: {
  /** 会话已确认为插件引擎(ACP)任务(对应 ChatInput 的 pluginEngineSession prop)。 */
  isPluginEngineSession: boolean;
  /** 已由 session/runtime 元数据确认的内置 Harness 身份;null/undefined = 尚未加载。 */
  runtimeAgentKind: AgentKind | null | undefined;
}): AgentKind | 'acp' | null {
  if (input.isPluginEngineSession) return 'acp';
  return input.runtimeAgentKind ?? null;
}
