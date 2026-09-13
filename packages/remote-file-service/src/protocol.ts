/**
 * protocol — remote file-service 的 NDJSON JSON-RPC 线协议定义。
 *
 * 传输:SSH exec channel stdio。client(desktop main)把请求逐行写进 daemon
 * 的 stdin,daemon 把响应/通知逐行写回 stdout;stderr 专走日志。daemon 生命
 * 周期 = channel 生命周期(stdin EOF 即退出),没有常驻状态要迁移,断线后
 * 重新 exec 一个新进程即可。
 *
 * 版本策略:
 *  - `FILE_SERVICE_SCHEMA_VERSION` 是协议兼容性判据。client handshake 时带上
 *    自己的版本,不相等即视为不兼容 → 上层重推 bundle(bundle ~几百 KB,重推
 *    是秒级操作,所以不做向后兼容协商,严格相等最简单)。
 *  - `FILE_SERVICE_BUNDLE_VERSION` 是人读的 bundle 版本,手动 bump,probe /
 *    日志用,不参与兼容性判断。
 *
 * 帧类型三种,全部单行 JSON:
 *  - Request  (client → daemon): { id, method, params }
 *  - Response (daemon → client): { id, ok: true, result } | { id, ok: false, error }
 *  - Event    (daemon → client): { event, data } —— 无 id,搜索流(P3)、
 *    watch 事件(P4)用;P1 不发任何 event,但解码层从第一版就支持,协议不用改。
 *
 * 二进制内容:readFile 走 UTF-8 文本(scanner 层已拦二进制文件);后续媒体
 * 下行(P4)预留 readFileBase64 方法位,届时内容 base64 进 JSON string,单帧
 * 上限由 MAX_FILE_BYTES(2 MiB → base64 ~2.7 MB)兜底,decoder 缓冲远大于此。
 */

import type {
  DirEntry,
  FileReadResult,
  FileStat,
  ListAllFilesResult,
  SearchEvent,
} from '@cindy/file-browser-core';

/** 协议兼容版本:client 与 daemon 严格相等才可用。改动任何请求/响应形状时 +1。 */
export const FILE_SERVICE_SCHEMA_VERSION = 7;

/** 人读 bundle 版本(probe / 日志用),行为变化时手动 bump。 */
export const FILE_SERVICE_BUNDLE_VERSION = '0.2.18';

/* ============================== 帧 ============================== */

export interface FsRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface FsRpcError {
  /** 稳定错误码,client 侧据此分支(见 FS_RPC_ERROR_CODES)。 */
  code: FsRpcErrorCode;
  /** 人读信息,进日志;不要求可 i18n(renderer 层按 code 映射文案)。 */
  message: string;
}

export type FsRpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: FsRpcError };

export interface FsRpcEvent {
  event: string;
  data: unknown;
}

export type FsRpcFrame = FsRpcResponse | FsRpcEvent;

/** daemon → client 帧的运行时判别。 */
export function isFsRpcResponse(v: unknown): v is FsRpcResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { id?: unknown }).id === 'number' &&
    typeof (v as { ok?: unknown }).ok === 'boolean'
  );
}

export function isFsRpcEvent(v: unknown): v is FsRpcEvent {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { event?: unknown }).event === 'string'
  );
}

/** client → daemon 帧的运行时判别(daemon 侧用)。 */
export function isFsRpcRequest(v: unknown): v is FsRpcRequest {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { id?: unknown }).id === 'number' &&
    typeof (v as { method?: unknown }).method === 'string'
  );
}

/* ============================== 错误码 ============================== */

export const FS_RPC_ERROR_CODES = [
  /** scanner 判定为二进制文件(读路径的预期分支,renderer 渲染不可预览卡)。 */
  'BINARY_FILE',
  /** 版本不匹配:daemon schema ≠ client schema,上层应重推 bundle。 */
  'SCHEMA_MISMATCH',
  /** 参数缺失/形状不对。 */
  'BAD_REQUEST',
  /** 远端没有可用 ripgrep(搜索 / 文件名索引的预期降级分支,renderer 按码映射友好文案)。 */
  'RG_UNAVAILABLE',
  /** 未知 method(通常也是版本偏斜的症状)。 */
  'UNKNOWN_METHOD',
  /** 其余一切执行失败(fs 错误、路径越界拒绝等),message 带原始描述。 */
  'OPERATION_FAILED',
] as const;

export type FsRpcErrorCode = (typeof FS_RPC_ERROR_CODES)[number];

/* ============================== 方法表 ============================== */

/**
 * 方法名 → { params, result } 的类型表。client.request 与 daemon 分发共用,
 * 两端不可能对同一方法产生不同理解(编译期对齐)。
 */
export interface FsRpcMethods {
  /** 握手:校验 schema、回报 daemon 自身信息。client 连上后必须首发。 */
  handshake: {
    params: { clientSchemaVersion: number };
    result: {
      schemaVersion: number;
      bundleVersion: string;
      pid: number;
      /** daemon 端 process.platform(远端一律 POSIX;'win32' 视为不支持)。 */
      platform: string;
      /** 远端 ripgrep 是否可用(--rg 启动参数已传且存在);决定搜索/文件名索引能力。 */
      rgAvailable: boolean;
    };
  };
  listDir: {
    params: { workdir: string; relPath?: string; hideMetaFiles?: boolean; docMode?: boolean };
    result: { entries: DirEntry[] };
  };
  readFile: {
    params: { workdir: string; relPath: string };
    result: FileReadResult;
  };
  /**
   * 大文件分片读:按 [offset, offset+length) 返回 base64 字节片(与 readFile 的
   * 2MiB 文本截断语义无关,任意大小文件可完整拉回)。安全校验与 readFile 同源
   * (assertInsideWorkdir + realpath);单片 length 上限 daemon 侧钳制 1MiB,
   * base64 后 ~1.37MB,远低于 NDJSON 解码缓冲。
   */
  readFileChunk: {
    params: { workdir: string; relPath: string; offset: number; length: number };
    result: {
      /** base64 字节片;eof 且 offset 超界时为空串。 */
      dataBase64: string;
      /** offset+片长 ≥ 文件大小,即已是最后一片。 */
      eof: boolean;
      /** 整文件大小(bytes),供 caller 预分配/进度。 */
      size: number;
      mtimeMs: number;
    };
  };
  stat: {
    params: { workdir: string; relPath: string };
    result: FileStat;
  };
  writeFile: {
    params: { workdir: string; relPath: string; content: string };
    result: { size: number; mtimeMs: number };
  };
  createFile: {
    params: { workdir: string; relPath: string };
    result: FileStat;
  };
  /**
   * 排他新建 + 写入一步完成(O_CREAT|O_EXCL,目标已存在或为 symlink 即失败,不跟随
   * 最终链接),供主机把结果文件落到远端任务目录;父目录须已存在。
   */
  writeNewFile: {
    params: { workdir: string; relPath: string; content: string };
    /**
     * 成功后 daemon 保留写入器自己的文件描述符作为调用方登记期间的 inode 级能力(holdId,
     * 超时自动关闭);durable=false 表示 staging 移除未落盘,调用方应经 hold 撤回。
     */
    result: { size: number; mtimeMs: number; dev: string; ino: string; holdId: string; durable: boolean };
  };
  /**
   * 核验 relPath 是本机写下的那份普通文件(非 symlink、父目录仍在 workdir 内、大小与
   * 内容 SHA-256 一致),用于 writeNewFile 响应丢失后的消歧;返回 inode 身份,并把核验
   * 用的描述符保留为 hold。`.staging` 仍在或链接数不为 1(写入进行中)则拒绝。
   */
  verifyNewFile: {
    params: { workdir: string; relPath: string; sha256: string; size: number };
    result: { size: number; mtimeMs: number; dev: string; ino: string; holdId: string };
  };
  /** 登记完成后释放 daemon 侧描述符;不删任何路径名。 */
  releaseNewFile: {
    params: { holdId: string };
    result: { released: boolean };
  };
  /**
   * 仅当 relPath 仍是给定 inode 身份的普通文件时经 fd 清零其内容;不删路径名(路径名删除有 TOCTOU)。
   * 带 holdId 时直接经 daemon 保留的描述符清零(目录已被移出 workdir 也能触达),并释放 hold。
   */
  eraseIfSame: {
    params: { workdir: string; relPath: string; dev: string; ino: string; holdId?: string };
    result: { erased: boolean };
  };
  createFolder: {
    params: { workdir: string; relPath: string };
    result: FileStat;
  };
  renameEntry: {
    params: { workdir: string; fromRel: string; toRel: string };
    result: FileStat;
  };
  deleteEntry: {
    params: { workdir: string; relPath: string };
    result: { ok: true };
  };
  listAllFiles: {
    params: { workdir: string; cap?: number };
    result: ListAllFilesResult;
  };
  searchStart: {
    params: { workdir: string; query: string; caseSensitive: boolean; maxMatches: number };
    result: { searchId: string };
  };
  searchCancel: {
    params: { searchId: string };
    result: { ok: true };
  };
  watchStart: {
    params: { workdir: string; hideMetaFiles?: boolean };
    result: { ok: true };
  };
  watchStop: {
    params: { workdir: string };
    result: { ok: true };
  };
}

export type FsRpcMethodName = keyof FsRpcMethods;

/* ============================== 事件 ============================== */

/**
 * daemon → client 的事件负载表(FsRpcEvent.event → data 形状)。
 */
export interface FsRpcEvents {
  search: SearchEvent;
  fileTree: { workdir: string; type: 'add' | 'change' | 'unlink'; relPath: string };
}

export type FsRpcEventName = keyof FsRpcEvents;
