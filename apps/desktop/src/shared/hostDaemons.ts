/**
 * host-daemons —— 「本机常驻」页签的跨进程契约。
 *
 * 只覆盖 Cindy 会话有能力产出、且能证明归属的那一类系统常驻物：Windows 计划任务。
 * 与 `processMonitor` 的区别：那边是 OS 级进程与 Agent 进程树，这边是「脱离会话
 * 生命周期仍然自己跑」的东西 —— 删掉任务后仍然存在，所以必须能独立查看与清理。
 *
 * 归属口径（见 main/host-daemons/service.ts）：只有台账已登记，或能在任务创建时刻
 * 前后 5 分钟内找到「本机工具调用里出现过该任务名」的来源会话，才算 Cindy 产生的。
 * 其余一律不返回给 renderer（只回一个数量），避免把 v2rayN 这类无关常驻混进清单。
 *
 * 与现有「路径不出 main」规则的受控例外：本清单的用途就是告诉用户脚本在哪、怎么
 * 恢复，所以 `command` 带绝对路径。它只发给本机可信顶层 renderer，不进日志、不进
 * 远程会话、不落库到可共享位置。
 */

/** renderer → main(invoke)：扫描并返回本机常驻快照。 */
export const HOST_DAEMONS_LIST_CHANNEL = 'host-daemons:list';
/** renderer → main(invoke)：停止一次计划任务运行（不动任务定义）。 */
export const HOST_DAEMONS_STOP_CHANNEL = 'host-daemons:stop';
/** renderer → main(invoke)：从这台电脑删除计划任务。 */
export const HOST_DAEMONS_DELETE_CHANNEL = 'host-daemons:delete';

export type HostDaemonKind = 'scheduled-task';

export type HostDaemonState = 'running' | 'ready' | 'disabled' | 'unknown';

/** 触发器粗粒度分类（界面只显示一句人话，不还原 Windows 的完整触发器模型）。 */
export type HostDaemonTrigger = 'logon' | 'startup' | 'schedule' | 'other';

export interface HostDaemonEntry {
  /** 计划任务唯一标识，形如 `\airlink-autopm` 或 `\folder\name`。 */
  id: string;
  name: string;
  kind: HostDaemonKind;
  state: HostDaemonState;
  /** 启动命令（可执行文件 + 参数），用于「怎么恢复」。 */
  command: string;
  trigger: HostDaemonTrigger;
  /** 归属任务标题；来自登记时或追溯时的会话快照，会话删除后仍保留。 */
  ownerTitle: string | null;
  ownerSessionId: string | null;
  lastRunAtMs: number | null;
}

export interface HostDaemonsSnapshot {
  capturedAtMs: number;
  /** false = 本平台暂不支持（当前仅 Windows 计划任务）。 */
  supported: boolean;
  entries: HostDaemonEntry[];
  /**
   * 扫描到但没有 Cindy 归属证据的常驻项数量。只回数量不回明细：清单的定位是
   * 「我让 Cindy 做过什么」，不是系统计划任务管理器。
   */
  unrelatedCount: number;
}

export interface HostDaemonActionRequest {
  id: string;
}
