/**
 * 会话「待生效的跨引擎切换意图」只读入口。
 *
 * makerChatStore 加载时注册读取器，路由辅助函数(新建任务沿用当前模型)同步读取，而不必把整张
 * store 依赖图(i18n、IPC 监听等)拉进侧栏与快捷键路径。store 未加载 = 当前窗口没有登记过意图。
 */
export interface AgentSwitchIntentSnapshot {
  target: 'claude-code' | 'codex' | 'pi';
  model: string;
  providerId: string | null;
  effort?: string;
  fastMode?: boolean | 'ultrafast';
  /** null = 任务所在电脑;缺省 = 位置不变。 */
  agentDeviceId?: string | null;
}

type AgentSwitchIntentReader = (sessionId: string) => AgentSwitchIntentSnapshot | null;

let reader: AgentSwitchIntentReader | null = null;

export function registerAgentSwitchIntentReader(next: AgentSwitchIntentReader | null): void {
  reader = next;
}

export function readAgentSwitchIntent(sessionId: string): AgentSwitchIntentSnapshot | null {
  return reader?.(sessionId) ?? null;
}
