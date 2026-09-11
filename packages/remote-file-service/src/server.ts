/**
 * server — file-service RPC 分发核心。
 *
 * 与传输解耦:`runFileService(input, output)` 只吃 Readable/Writable,
 * 生产入口(bin/file-service.ts)接 process.stdin/stdout,测试用 PassThrough
 * 内存流直连,无需 spawn 进程。
 *
 * 并发模型:每条请求独立 async 处理,响应完成即写回(乱序,靠 id 配对)。
 * 文件 IO 都是短操作,不做并发上限;搜索(P3)是流式子进程,经 event 帧推送。
 *
 * 安全:路径校验完全复用 @cindy/file-browser-core 的 scanner 层
 * (assertInsideWorkdir + realpath symlink 检查)——daemon 以 SSH 登录用户的
 * 权限跑,workdir 语义与本地版逐字节一致。
 *
 * 日志:统一走 stderr(stdout 被 NDJSON 帧独占)。
 */

import type { Readable, Writable } from 'node:stream';
import {
  createFile,
  createFolder,
  deleteEntry,
  listAllFiles,
  listAllFilesWalk,
  listDir,
  loadIgnoreMatcher,
  readFileChunk,
  readFile,
  renameEntry,
  RipgrepSearcher,
  setFileBrowserCoreLoggerFactory,
  statEntry,
  writeFile,
  type CoreLogger,
  type SearchEvent,
} from '@cindy/file-browser-core';

import { NdjsonLineDecoder, encodeNdjsonFrame } from './codec.js';
import { WorkdirWatchManager } from './watch.js';
import {
  FILE_SERVICE_BUNDLE_VERSION,
  FILE_SERVICE_SCHEMA_VERSION,
  isFsRpcRequest,
  type FsRpcError,
  type FsRpcMethods,
  type FsRpcRequest,
} from './protocol.js';

export interface FileServiceOptions {
  /**
   * ripgrep 二进制的远端绝对路径;未安装/未知时不传,listAllFiles / search
   * 返回 OPERATION_FAILED,client 走降级(P3 之前 desktop 不会调它们)。
   */
  rgPath?: string;
  /** 测试注入;生产默认 stderr 文本行。 */
  logger?: CoreLogger;
}

function stderrLogger(scope: string): CoreLogger {
  const line = (level: string, args: unknown[]): void => {
    const text = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    process.stderr.write(`[${new Date().toISOString()}] ${level} ${scope} ${text}\n`);
  };
  return {
    debug: (...a) => line('DEBUG', a),
    info: (...a) => line('INFO', a),
    warn: (...a) => line('WARN', a),
    error: (...a) => line('ERROR', a),
  };
}

type Params<M extends keyof FsRpcMethods> = FsRpcMethods[M]['params'];
type Result<M extends keyof FsRpcMethods> = FsRpcMethods[M]['result'];

function bad(message: string): never {
  const err = new Error(message);
  (err as Error & { fsRpcCode?: string }).fsRpcCode = 'BAD_REQUEST';
  throw err;
}

/** 无 rg 的预期降级分支:专属码让 renderer 能映射友好文案(不与 BAD_REQUEST 混桶)。 */
function rgUnavailable(): never {
  const err = new Error('ripgrep is not available on this remote (rgPath unset)');
  (err as Error & { fsRpcCode?: string }).fsRpcCode = 'RG_UNAVAILABLE';
  throw err;
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) bad(`param "${name}" must be a non-empty string`);
  return v;
}

/**
 * 启动 file-service:消费 input 上的请求帧,把响应/事件帧写到 output。
 * 返回的 promise 在 input 结束(EOF)且在飞请求全部落地后 resolve。
 */
export function runFileService(
  input: Readable,
  output: Writable,
  opts: FileServiceOptions = {},
): Promise<void> {
  const logger = opts.logger ?? stderrLogger('file-service');
  setFileBrowserCoreLoggerFactory((scope) => opts.logger ?? stderrLogger(scope));

  const send = (frame: unknown): void => {
    output.write(encodeNdjsonFrame(frame));
  };

  /** P4 watch:per-workdir fs.watch,事件转发为 fileTree event 帧。 */
  const watchManager = new WorkdirWatchManager((event) => send({ event: 'fileTree', data: event }));

  /** P3 搜索:单 daemon 单 searcher,事件直接转发为 event 帧。 */
  let searcher: RipgrepSearcher | null = null;
  const getSearcher = (): RipgrepSearcher => {
    if (!opts.rgPath) rgUnavailable();
    if (!searcher) {
      searcher = new RipgrepSearcher({ rgPath: opts.rgPath, logger });
      searcher.on('event', (evt: SearchEvent) => send({ event: 'search', data: evt }));
    }
    return searcher;
  };

  const handlers: {
    [M in keyof FsRpcMethods]: (params: Params<M>) => Promise<Result<M>> | Result<M>;
  } = {
    handshake: (p) => {
      if (typeof p?.clientSchemaVersion !== 'number') bad('clientSchemaVersion required');
      return {
        schemaVersion: FILE_SERVICE_SCHEMA_VERSION,
        bundleVersion: FILE_SERVICE_BUNDLE_VERSION,
        pid: process.pid,
        platform: process.platform,
        rgAvailable: Boolean(opts.rgPath),
      };
    },
    listDir: async (p) => {
      const workdir = requireString(p?.workdir, 'workdir');
      const matcher = await loadIgnoreMatcher(workdir, {
        hideMetaFiles: p?.hideMetaFiles ?? true,
        honorVcsIgnore: false,
        showIgnoredDirs: p?.showIgnoredDirs === true,
      });
      const entries = await listDir(workdir, p?.relPath ?? '', matcher, {
        docMode: p?.docMode,
      });
      return { entries };
    },
    readFile: (p) =>
      readFile(requireString(p?.workdir, 'workdir'), requireString(p?.relPath, 'relPath')),
    readFileChunk: async (p) => {
      if (typeof p?.offset !== 'number' || typeof p?.length !== 'number') {
        bad('offset/length must be numbers');
      }
      const r = await readFileChunk(
        requireString(p?.workdir, 'workdir'),
        requireString(p?.relPath, 'relPath'),
        p.offset,
        p.length,
      );
      return { dataBase64: r.data.toString('base64'), eof: r.eof, size: r.size, mtimeMs: r.mtimeMs };
    },
    stat: (p) =>
      statEntry(requireString(p?.workdir, 'workdir'), requireString(p?.relPath, 'relPath')),
    writeFile: (p) =>
      writeFile(
        requireString(p?.workdir, 'workdir'),
        requireString(p?.relPath, 'relPath'),
        typeof p?.content === 'string' ? p.content : bad('content must be a string'),
      ),
    createFile: (p) =>
      createFile(requireString(p?.workdir, 'workdir'), requireString(p?.relPath, 'relPath')),
    createFolder: (p) =>
      createFolder(requireString(p?.workdir, 'workdir'), requireString(p?.relPath, 'relPath')),
    renameEntry: (p) =>
      renameEntry(
        requireString(p?.workdir, 'workdir'),
        requireString(p?.fromRel, 'fromRel'),
        requireString(p?.toRel, 'toRel'),
      ),
    deleteEntry: async (p) => {
      await deleteEntry(requireString(p?.workdir, 'workdir'), requireString(p?.relPath, 'relPath'));
      return { ok: true as const };
    },
    listAllFiles: (p) => {
      const workdir = requireString(p?.workdir, 'workdir');
      // 无 rg 走纯 JS 遍历 fallback(与文件树同一个 ignore matcher,慢但语义
      // 确定,cap 兜底)——文件名筛选不依赖远端装没装 ripgrep。内容搜索仍
      // rg-only(纯 JS 全文搜索慢一个量级,降级为 RG_UNAVAILABLE 明确报错)。
      if (!opts.rgPath) return listAllFilesWalk({ workdir, cap: p?.cap });
      return listAllFiles({ workdir, rgPath: opts.rgPath, cap: p?.cap });
    },
    searchStart: (p) => {
      const searchId = getSearcher().start({
        workdir: requireString(p?.workdir, 'workdir'),
        query: requireString(p?.query, 'query'),
        caseSensitive: p?.caseSensitive === true,
        maxMatches: typeof p?.maxMatches === 'number' ? p.maxMatches : 500,
      });
      return { searchId };
    },
    searchCancel: (p) => {
      searcher?.cancel(requireString(p?.searchId, 'searchId'));
      return { ok: true as const };
    },
    watchStart: async (p) => {
      await watchManager.start(
        requireString(p?.workdir, 'workdir'),
        {
          hideMetaFiles: p?.hideMetaFiles ?? true,
          showIgnoredDirs: p?.showIgnoredDirs === true,
        },
        typeof p?.consumerId === 'string' ? p.consumerId : undefined,
      );
      return { ok: true as const };
    },
    watchStop: (p) => {
      watchManager.stop(
        requireString(p?.workdir, 'workdir'),
        typeof p?.consumerId === 'string' ? p.consumerId : undefined,
      );
      return { ok: true as const };
    },
  };

  const toRpcError = (err: unknown): FsRpcError => {
    const e = err as Error & { code?: string; fsRpcCode?: string };
    if (e?.code === 'BINARY_FILE') return { code: 'BINARY_FILE', message: e.message };
    if (e?.fsRpcCode === 'BAD_REQUEST') return { code: 'BAD_REQUEST', message: e.message };
    if (e?.fsRpcCode === 'RG_UNAVAILABLE') return { code: 'RG_UNAVAILABLE', message: e.message };
    return { code: 'OPERATION_FAILED', message: e?.message ? String(e.message) : String(err) };
  };

  const inflight = new Set<Promise<void>>();

  const dispatch = (req: FsRpcRequest): void => {
    const handler = handlers[req.method as keyof FsRpcMethods] as
      | ((params: unknown) => unknown)
      | undefined;
    if (!handler) {
      send({
        id: req.id,
        ok: false,
        error: { code: 'UNKNOWN_METHOD', message: `unknown method: ${req.method}` },
      });
      return;
    }
    const job = (async () => {
      try {
        const result = await handler(req.params);
        send({ id: req.id, ok: true, result });
      } catch (err) {
        send({ id: req.id, ok: false, error: toRpcError(err) });
      }
    })();
    inflight.add(job);
    void job.finally(() => inflight.delete(job));
  };

  const decoder = new NdjsonLineDecoder({
    onCorruptLine: (line, err) => logger.warn('corrupt request line', err.message, line.slice(0, 120)),
  });

  return new Promise<void>((resolve) => {
    input.on('data', (chunk: Buffer | string) => {
      for (const frame of decoder.push(chunk)) {
        if (isFsRpcRequest(frame)) {
          dispatch(frame);
        } else {
          logger.warn('dropping non-request frame', JSON.stringify(frame).slice(0, 120));
        }
      }
    });
    input.on('end', () => {
      // stdin EOF = client 走了。等在飞请求写完再退,别截断响应流。
      void Promise.allSettled([...inflight]).then(() => {
        searcher?.cancelAll();
        watchManager.stopAll();
        resolve();
      });
    });
    input.on('error', (err) => {
      logger.error('input stream error', String(err));
      searcher?.cancelAll();
      watchManager.stopAll();
      resolve();
    });
  });
}
