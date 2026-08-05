/**
 * 日志上报模块的内部类型。刻意与 `shared/logUpload.ts`（跨进程契约）分开：
 * 这里的形状只在 main 内部流转，改动不影响 preload / renderer。
 */

import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

import type { LogUploadReason } from '../../shared/logUpload';

/** 上报目标：日志服务的 project + logstore + 服务区域接入域名。 */
export interface LogUploadTarget {
  project: string;
  logstore: string;
  /** 服务区域接入域名，不含协议、不含 project 前缀。 */
  endpointHost: string;
}

/**
 * 一条上报记录的**最终形状**（第四层字段白名单的产物）。
 *
 * 只有这五个字段会离开本机。解析出的其它字段（NDJSON 的 `tz` / `seq` / `sessionId`，
 * 未来新增的任何字段）一律丢弃——白名单是正向的，不是「排除已知危险字段」。
 */
export interface UploadRecord {
  /** 原始时间戳（本地 ISO + offset）。不能用上报时刻覆盖，否则崩溃时间线失真。 */
  ts: string;
  level: string;
  /** 记录来自哪条本地流。`main` = main-*.log，`proxy` = agent-*.ndjson 的 proxy 源。 */
  src: 'main' | 'proxy';
  scope: string;
  msg: string;
}

/** 一条记录在裁剪前的中间形态：多带一个用于锚点打分的 epoch ms。 */
export interface ParsedRecord extends UploadRecord {
  tsMs: number;
}

/** 采集统计，只进本机日志，用于观察体量分布（需求 §4.6）。 */
export interface CollectStats {
  filesRead: number;
  bytesRead: number;
  linesScanned: number;
  /** 通过全部四层后保留的条数。 */
  kept: number;
  /** 被来源白名单挡掉的条数。 */
  droppedBySource: number;
  /** 因条数上限被锚点裁剪掉的条数。 */
  droppedByCap: number;
  /**
   * 因「不是转义版本写的」被整份跳过的 main 文件数（见 `startsWithFormatSentinel`）。
   * 单独计数是为了让「升级当天采到 0 条」在本机日志里能一眼归因，而不是查半天读窗口。
   */
  filesSkippedLegacyFormat: number;
  /**
   * 解析中途命中「未转义续行」而提前停止的 main 文件数（回滚场景：新版本建文件、旧版本
   * 同日追加未转义内容）。用于观察这类污染的发生频次。
   */
  mainFilesStoppedAtViolation: number;
  /** 实际回溯的天数。 */
  lookbackDays: number;
}

export interface CollectResult {
  records: UploadRecord[];
  stats: CollectStats;
  /**
   * 崩溃锚点里**其读取窗口确已覆盖**的那些（epoch ms 子集）。上报成功后，只有覆盖到的崩溃
   * 标记才该被清除；没覆盖到的（超大文件里同一天靠后的那次崩溃落在窗口外）保留待补传，
   * 避免用一次「非空但没含这次崩溃」的上报把它永久清掉（2026-08-04 review）。
   */
  coveredAnchors: number[];
}

/** 环境元数据。后台按这些维度检索（需求 §4.8）。 */
export interface LogUploadMeta {
  /** 上传编号（已格式化为 `XXXX-XXXX`）。 */
  uploadCode: string;
  /** 未登录为空串。 */
  userId: string;
  deviceId: string;
  appVersion: string;
  region: CindyRegion;
  platform: string;
  arch: string;
  osVersion: string;
  uiLanguage: string;
  reason: LogUploadReason;
  /**
   * 崩溃路径带上标记的代次令牌：崩溃即时上传与下次启动补传是两次独立上报
   * （各有自己的 uploadCode），靠这个令牌在后台归成同一次崩溃。
   */
  crashToken?: string;
  crashAtMs?: number;
}
