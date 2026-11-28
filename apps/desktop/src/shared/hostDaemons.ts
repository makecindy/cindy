/**
 * host-daemons —— 「本机常驻」页签的跨进程契约。
 *
 * 只覆盖 Cindy 会话有能力产出、且能证明归属的那一类系统常驻物：Windows 计划任务、
 * macOS LaunchAgents、Linux 用户级 systemd 单元与 crontab 条目。与 `processMonitor`
 * 的区别：那边是 OS 级进程与 Agent 进程树，这边是「脱离会话生命周期仍然自己跑」
 * 的东西 —— 删掉任务后仍然存在，所以必须能独立查看与清理。
 *
 * 归属口径（见 main/host-daemons/service.ts）：证据只有一种 —— 本机某个任务执行过的命令里
 * 出现过该条目的名字。有定义文件时刻的条目查那一刻前后 5 分钟；没有定义时刻的条目
 * （crontab）要把工具调用历史从旧到新翻完才算数，没读完不下结论。
 * 其余一律不返回给 renderer（只回一个数量），避免把 v2rayN 这类无关常驻混进清单。
 *
 * 与现有「路径不出 main」规则的受控例外：本清单的用途就是告诉用户脚本在哪、怎么
 * 恢复，所以 `command` 带绝对路径。它只发给本机可信顶层 renderer，不进日志、不进
 * 远程会话、不落库到可共享位置。
 */

/**
 * renderer → main(invoke)：停止一次运行（不动任务定义）。
 */
export const HOST_DAEMONS_STOP_CHANNEL = 'host-daemons:stop';
/** renderer → main(invoke)：立即运行一次（停止之后要靠它把任务重新拉起来）。 */
export const HOST_DAEMONS_RUN_CHANNEL = 'host-daemons:run';
/** renderer → main(invoke)：从这台电脑删除常驻项。 */
export const HOST_DAEMONS_DELETE_CHANNEL = 'host-daemons:delete';
/**
 * renderer → main(invoke)：面板可见，请 main 开始推进归属核对。等第一轮做完才回，回执就是
 * 那一轮的清单；之后每轮结束推 `HOST_DAEMONS_CHANGED_EVENT`。不可见时退订。
 * 推进与写台账只在订阅期间由 main 自己做（工程规范 §8.3）。
 */
export const HOST_DAEMONS_SUBSCRIBE_CHANNEL = 'host-daemons:subscribe';
export const HOST_DAEMONS_UNSUBSCRIBE_CHANNEL = 'host-daemons:unsubscribe';
/**
 * renderer → main(invoke)：请求一轮更新（用户点刷新、操作之后）。在途的一轮不叠加：等它
 * 做完再补一轮，回执是请求之后那次扫描的清单。
 * 只在面板还订阅着时才有意义：没有订阅者说明没人等这份清单，main 不扫描、不读历史
 * （工程规范 §8.2 / §8.3：组件卸载后不再发起新读取）。
 */
export const HOST_DAEMONS_REFRESH_CHANNEL = 'host-daemons:refresh';
/** main → renderer(push)：一轮结束，带上这一轮的清单或失败。只发给仍加载着可信页面的窗口。 */
export const HOST_DAEMONS_CHANGED_EVENT = 'host-daemons:changed';

export type HostDaemonKind =
  | 'scheduled-task'
  | 'launch-agent'
  | 'systemd-unit'
  | 'cron-entry';

export type HostDaemonState = 'running' | 'ready' | 'disabled' | 'unknown';

/** 触发器粗粒度分类（界面只显示一句人话，不还原各平台完整的触发模型）。 */
export type HostDaemonTrigger = 'logon' | 'startup' | 'schedule' | 'other';

export interface HostDaemonEntry {
  /** 唯一标识，各平台自带命名空间：`\airlink-autopm`、`launch-agent:com.x.y`、
   * `systemd-user:backup.timer`、`cron-entry:<命令指纹>`。 */
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
  /** false = 本平台没有可枚举的常驻项来源（见 main/host-daemons/target.ts）。 */
  supported: boolean;
  entries: HostDaemonEntry[];
  /**
   * 扫描到但没有 Cindy 归属证据的常驻项数量。只回数量不回明细：清单的定位是
   * 「我让 Cindy 做过什么」，不是系统计划任务管理器。
   */
  unrelatedCount: number;
  /**
   * 还在核对归属、暂不下结论的条目数：没有定义时刻的条目要把工具调用历史翻完，
   * 冷盘的大库上一次拉不完，进度留在 main。不算「无关」，也还不进清单。
   */
  pendingCount: number;
  /**
   * 这一轮有来源没读全（目录读不了、命令失败）：清单可能缺条目。读失败不等于没有，
   * 上层据此不清理「消失」条目的记录，界面也如实提示。
   */
  incomplete: boolean;
}

export interface HostDaemonActionRequest {
  id: string;
}

/** 一轮更新的结果：这一轮扫描对应的清单，或者这一轮失败的原因。 */
export type HostDaemonsUpdate =
  | { ok: true; snapshot: HostDaemonsSnapshot }
  | { ok: false; reason: 'internal' | 'warming' | 'no-listener'; message: string };

/** 更新一轮的回执：这一轮的清单，以及隔多久再做一轮。 */
export interface HostDaemonsRefreshResult {
  /** 这一轮扫描对应的清单；整轮作废（切号、边界进行中）时不含条目。 */
  snapshot: HostDaemonsSnapshot;
  /** 还要再推进时给出的间隔；没有待核对的条目、来源也都读全时为 null。 */
  retryAfterMs: number | null;
}
