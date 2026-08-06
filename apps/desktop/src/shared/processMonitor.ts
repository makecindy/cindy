/**
 * process-monitor —— 「资源用量」面板的 main / preload / renderer 共享契约。
 *
 * 数据面:main 周期采样(app.getAppMetrics + OS 级 agent 子进程扫描)后经
 * PROCESS_MONITOR_SAMPLE_CHANNEL 推送;只在有订阅者(面板打开)时采样。
 * 动作面:terminate 只接受「本产品 spawn 的 agent 根进程」,归属由 main 侧
 * 重新扫描独立校验,renderer 传来的 pid 只是候选,不是授权依据。
 */

/** renderer → main(invoke):开始接收采样推送(以 sender webContents 计数)。 */
export const PROCESS_MONITOR_SUBSCRIBE_CHANNEL = 'process-monitor:subscribe';
/** renderer → main(invoke):停止接收采样推送。 */
export const PROCESS_MONITOR_UNSUBSCRIBE_CHANNEL = 'process-monitor:unsubscribe';
/** main → renderer(push):一次完整采样快照(ProcessMonitorSample)。 */
export const PROCESS_MONITOR_SAMPLE_CHANNEL = 'process-monitor:sample';
/** renderer → main(invoke):终止一个 agent 根进程及其子孙(强校验归属)。 */
export const PROCESS_MONITOR_TERMINATE_CHANNEL = 'process-monitor:terminate-agent';

export type ProcessUsageKind =
  | 'main'
  | 'renderer'
  | 'gpu'
  | 'utility'
  | 'agent-claude'
  | 'agent-codex'
  | 'agent-pi';

/** Codex 本地 app-server 的产品职责；仅传枚举，不暴露 host key / 凭据 / 命令行。 */
export type AgentProcessRole = 'task-host' | 'control-plane-service';

export interface ProcessUsageEntry {
  /** 根进程 pid(agent 条目 = 树根;Chromium 条目 = 进程本身)。 */
  pid: number;
  kind: ProcessUsageKind;
  /**
   * 展示名:renderer = 页面/窗口标题,utility = serviceName。可能为 null
   * (renderer 兜底文案由 UI 侧 i18n 提供)。不携带路径与命令行 —— 内部
   * 绝对路径不出 main(electron-security 规则)。
   */
  label: string | null;
  /** CPU 占用(单核百分比;agent 条目为整棵子进程树求和)。 */
  cpuPercent: number;
  /** 内存 working set(KB;agent 条目为整棵子进程树求和)。 */
  memoryKb: number;
  /**
   * 该条目聚合的可见进程数(agent 树含根，但不含 conhost 等 OS 辅助进程；
   * Chromium 条目恒为 1)。CPU / 内存仍聚合完整进程树。
   */
  processCount: number;
  /** true = 可被「结束进程」终止(仅本产品 spawn 的 agent 根进程)。 */
  terminable: boolean;
  /**
   * OS 提供的进程出生身份。仅可终止的 agent 根进程携带；renderer 原样回传，
   * main 用它拒绝已经退出并被复用的旧 pid。它不包含路径或命令行。
   */
  processInstanceId?: string;
  /** 仅 Codex 条目可有；普通任务共享宿主与账户/模型控制面服务据此消歧。 */
  agentRole?: AgentProcessRole;
}

export interface ProcessMonitorSample {
  capturedAtMs: number;
  entries: ProcessUsageEntry[];
}

/** renderer → main 的终止候选；两个字段都只是候选，main 会同步重新校验归属。 */
export interface TerminateAgentProcessRequest {
  pid: number;
  processInstanceId: string;
}

/** terminate 成功返回(失败一律走 IPC 错误协议 throwIpcError)。 */
export interface TerminateAgentProcessResult {
  pid: number;
  kind: 'claude' | 'codex' | 'pi';
}
