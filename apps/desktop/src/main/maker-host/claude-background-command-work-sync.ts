import {
  hasWorkingBackgroundCommand,
  noteClaudeSessionBackgroundCommandWork,
} from './claude-session-background-activity.js';

/** 读得到后台任务快照的会话(maker-core Session 的最小形状)。 */
export interface BackgroundCommandWorkSession {
  readonly id: string;
  readonly remoteHostId?: string | null;
  readonly agentDeviceId?: string | null;
  listBackgroundTasks?: () => ReadonlyArray<{
    taskType?: string;
    backgroundCommandKind?: 'work' | 'service';
  }>;
}

/**
 * 用会话的权威后台任务快照刷新「后台命令仍在工作」。任务表变化、回合收尾、回退提交(关闭旧
 * Query 会不带事件地清空任务表)都要调一次,不靠事件自己配对。
 * 只覆盖 Agent 进程在本机的任务:SSH 远程工作区与在其他电脑上运行 Agent 的任务,终态可能掉在
 * 断连窗口里,本地没有自愈路径,会一直亮着。
 */
export function syncBackgroundCommandWork(session: BackgroundCommandWorkSession): void {
  if (session.remoteHostId || session.agentDeviceId) return;
  if (typeof session.listBackgroundTasks !== 'function') return;
  try {
    noteClaudeSessionBackgroundCommandWork(
      session.id,
      hasWorkingBackgroundCommand(session.listBackgroundTasks()),
    );
  } catch {
    // 快照读不到就保持现状,不为展示信号打断调用方。
  }
}
