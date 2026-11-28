/**
 * host-daemons/target —— 本机常驻项的平台适配器。
 *
 * 编排层（service.ts）只认这个接口：扫描出一批「脱离会话生命周期仍然自己跑」的
 * 条目，以及停止／立即运行／删除三个动作。平台的差异（Windows 计划任务、macOS
 * LaunchAgents、Linux 用户级 systemd 单元与 crontab）全部收在各自的实现里，
 * 归属判定、账号边界、台账这些与平台无关的部分只写一份。
 */

import type {
  HostDaemonKind,
  HostDaemonState,
  HostDaemonTrigger,
} from '../../shared/hostDaemons.js';
import { createLogger } from '../logger.js';

const log = createLogger('host-daemons');

/** 适配器归一化后的常驻项；state / command / trigger 已是界面用语。 */
export interface RawHostDaemon {
  /** 跨扫描稳定的唯一标识（各适配器自带命名空间前缀）。 */
  id: string;
  /**
   * 界面上显示的名字，也是默认的归属追溯词。Windows 用计划任务名，macOS 用
   * Label，Linux 用单元名或命令里的脚本文件名 —— 都是「会话里创建它时必然出现
   * 过的字串」。
   */
  name: string;
  kind: HostDaemonKind;
  state: HostDaemonState;
  /** 启动命令，用于「怎么恢复」。 */
  command: string;
  trigger: HostDaemonTrigger;
  /**
   * 归属追溯用的替换词（默认只用 `name`）。crontab 条目的显示名是脚本文件名，
   * 太泛，必须用整条命令文本才够作证据。
   */
  attributionNeedles?: readonly string[];
  /**
   * 定义写入时刻，是判定「什么时候被创建」的证据：有它就只查那一刻前后的时间窗。
   * null = 本平台/来源读不到（crontab 没有文件级定义）：只能把工具调用历史从旧到新
   * 读完再下结论（见 service.ts 的全历史回看）；「首次扫描到它的时刻」只用来定
   * 「之后才算晚落库」的等待窗口和归属记录的身份。
   */
  definitionMtimeMs: number | null;
  lastRunAtMs: number | null;
  /** 能不能「只结束这一次运行」。crontab 条目没有句柄，只能删除或不管。 */
  stoppable?: boolean;
}

/** 一个平台来源的适配器。同一平台上可能有多个来源（如 macOS 的 launchd + crontab）。 */
export interface HostDaemonAdapter {
  /** 本来源负责的 id 前缀；编排层靠它把动作路由回正确来源。 */
  readonly idPrefix: string;
  scan(): Promise<RawHostDaemon[]>;
  /** 结束当前这一次运行，不动定义（之后仍会按自己的时机再跑起来）。 */
  stop(id: string): Promise<void>;
  /** 立即运行一次。 */
  run(id: string): Promise<void>;
  /** 从这台电脑删除，之后不再自动启动。 */
  remove(id: string): Promise<void>;
}

/**
 * 一次扫描的结果。`entries` 只是「这次确实读到的」；没读到的来源如实列在 `unread`
 * 里 —— 读失败 ≠ 没有：编排层不会把它们的条目当作已删除（见 service.ts）。
 */
export interface HostDaemonScan {
  entries: RawHostDaemon[];
  /** 这一轮没读全的来源（各自的 id 前缀）。 */
  unread: string[];
}

export interface HostDaemonTarget {
  /** 读到多少算多少：单个来源失败不抛出，记进 `unread`。 */
  scan(): Promise<HostDaemonScan>;
  stop(id: string): Promise<void>;
  run(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** 外部命令结果：非 0 退出码不算异常（「没有 crontab」也是正常分支）。 */
export interface ExecResult {
  stdout: string;
  /** stderr 的原文；适配器用它区分几种固定的「业务上为空」输出。 */
  stderr?: string;
  /** 退出码；命令没启动起来或被信号结束时没有。 */
  code?: number;
  /** 命令本身不存在（这台机器没装）：这个来源不存在，既不是成功也不是读到了空结果。 */
  notInstalled?: boolean;
  failed: boolean;
}

/**
 * 把同一平台上的多个来源合成一个目标。null = 本平台没有可枚举的常驻物
 * （e.g. BSD 上的平台组合），调用方据此回 `supported: false`。
 */
export function combineHostDaemonAdapters(
  adapters: readonly HostDaemonAdapter[],
): HostDaemonTarget | null {
  if (adapters.length === 0) return null;

  function route(id: string): HostDaemonAdapter {
    const adapter = adapters.find((candidate) => id.startsWith(candidate.idPrefix));
    if (!adapter) throw new Error('no host daemon source owns this id');
    return adapter;
  }

  return {
    async scan() {
      // 单个来源失败（目录读不了、命令启动不了）不该让整张清单消失；但它没读到的条目
      // 也不能就此算作「已删除」，所以失败要如实带回去。
      const results = await Promise.all(
        adapters.map(async (adapter) => ({
          prefix: adapter.idPrefix,
          entries: await adapter.scan().catch((err: unknown) => {
            // 界面只知道「没读到」；原因只在这里留下，否则无从排查。
            log.warn('host daemon source unreadable', {
              source: adapter.idPrefix,
              error: err instanceof Error ? err.message : String(err),
            });
            return null;
          }),
        })),
      );
      return {
        entries: results.flatMap((result) => result.entries ?? []),
        unread: results.filter((result) => result.entries === null).map((result) => result.prefix),
      };
    },
    async stop(id) {
      await route(id).stop(id);
    },
    async run(id) {
      await route(id).run(id);
    },
    async remove(id) {
      await route(id).remove(id);
    },
  };
}
