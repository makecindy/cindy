/**
 * libraryVault.ts — Durable Plugin Library 的文件层基座(2026-08-20 定案)。
 * ---------------------------------------------------------------------------
 * 与 fsSlot 的 root:'data'(插件私有储物柜,256MiB/2000 文件配额、卸载即回收)
 * 不同,Library 是**用户作品级**的持久存储:
 *
 *   - 容量不受 ghost-fs 配额约束,只受磁盘保留水位与软水位(仅告警)约束;
 *   - 卸载插件**不删**(由上层标 orphaned),删除必须走设置页独立确认;
 *   - 所有写入原子化:staging(tmp + fsync)→ rename 就位 → identity(dev/ino)
 *     复验——对齐 dirDeposit.writeNewSaveFile 的 TOCTOU 范式,不沿用 fsSlot
 *     data 档的裸 writeFile(崩溃会留截断文件);
 *   - 大文件走分块流(writeBegin/Chunk/Commit),Commit 时核对宿主实算 sha256
 *     ——这是未来网络同步「素材对象完整性校验」的地基,必须进首期契约;
 *   - 宿主自有元数据放 `<root>/.cindy-library/`:插件相对路径的段首不许点
 *     (isSafeGhostRelativePath),协议层天然写不进宿主命名空间。
 *
 * 「不可用 ≠ 空」是红线:meta 损坏 → state:'unavailable'(reason:'corrupt'),
 * 绝不静默重建空库;上层(槽/设置页)据此引导用户,不触发 GC、不判素材已删。
 *
 * 根目录依赖注入(规则 14):默认根(owners/<k>/libraries/<ghostId>)与自定义根
 * (binding 记录)对 vault 透明;单测拿 tmpdir 直测,零 Electron。
 */

import { randomUUID } from 'node:crypto';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isSafeGhostRelativePath } from '../../shared/ghost.js';

/** Library 操作的结构化错误码(fs 槽只有人话 message 的缺口在这里补上)。 */
export type LibraryErrorCode =
  | 'LIBRARY_UNAVAILABLE' // meta 损坏 / IO 故障 / 用量保险丝触发(fail closed)
  | 'LIBRARY_READONLY' // 迁移等场景显式置只读
  | 'DISK_FULL' // 磁盘剩余低于保留水位,写前拒绝(绝不写一半)
  | 'PATH_INVALID'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'TOO_LARGE'
  | 'STREAM_INVALID'
  | 'INTERNAL';

export type LibraryFailure = { ok: false; errorCode: LibraryErrorCode; message: string };
export type LibrarySuccess<T> = { ok: true } & T;
export type LibraryResult<T> = LibrarySuccess<T> | LibraryFailure;

/** 可整体注入覆盖的限额(生产用默认值;测试收小阈值走边界用例)。 */
export interface LibraryLimits {
  /** 单次 write / 单块 chunk 上限(与管子单消息预算对齐)。 */
  writeMaxBytes: number;
  readMaxBytes: number;
  pathMaxChars: number;
  pathMaxSegments: number;
  /** list 单页条数上限。 */
  listPageSize: number;
  /** 分块流总大小上限。 */
  streamMaxTotalBytes: number;
  /** 分块流闲置超时(超时残流按 Abort 清扫)。 */
  streamIdleTimeoutMs: number;
  /** 磁盘保留水位:剩余低于该值拒写。 */
  diskReserveBytes: number;
  /** 软水位:仅告警不阻断(status.softLimitExceeded)。 */
  softLimitBytes: number;
  /** staging 残渣清理龄。 */
  tmpMaxAgeMs: number;
  /** 用量全量扫描保险丝(条数);触发即 fail closed 拒写。 */
  usageScanFuse: number;
}

export const DEFAULT_LIBRARY_LIMITS: LibraryLimits = {
  writeMaxBytes: 16 * 1024 * 1024,
  readMaxBytes: 16 * 1024 * 1024,
  pathMaxChars: 512,
  pathMaxSegments: 32,
  listPageSize: 500,
  streamMaxTotalBytes: 8 * 1024 * 1024 * 1024,
  streamIdleTimeoutMs: 5 * 60 * 1000,
  diskReserveBytes: 1024 * 1024 * 1024,
  softLimitBytes: 8 * 1024 * 1024 * 1024,
  tmpMaxAgeMs: 24 * 60 * 60 * 1000,
  usageScanFuse: 50_000,
};

export type LibraryState = 'ready' | 'readonly' | 'unavailable';

/** 宿主元数据(.cindy-library/meta.json)。orphaned = 卸载后未删除的标记。 */
export interface LibraryMeta {
  version: 1;
  ghostId: string;
  createdAt: number;
  orphaned?: { at: number; name: string };
}

/** 用量账本(.cindy-library/usage.json);损坏/缺失时 open 触发全量重扫。 */
interface UsageLedger {
  files: number;
  bytes: number;
  updatedAt: number;
  mutations: number;
}

export interface LibraryVaultDeps {
  /** Library 根(生产 = 默认根或 binding 解析结果;每次现取,支持切换)。 */
  rootDir(): string;
  /** 归属插件 id(写进 meta 供设置页/回收站展示;缺省空串)。 */
  ghostId?: string;
  limits?: Partial<LibraryLimits>;
  /**
   * 卷剩余字节;null = 未知(探测失败)。未知时跳过写前硬闸,依赖 ENOSPC
   * 兜底——比假装知道更诚实。
   */
  getDiskFreeBytes?(root: string): Promise<number | null>;
  /** 位置类别(仅透传给 status;binding 层提供,默认系统管理位置)。 */
  locationKind?: 'default' | 'custom';
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  now?(): number;
}

/** Windows 保留设备名(与 fsSlot/dirDeposit 同口径;目录名撞上同样出事)。 */
const WINDOWS_RESERVED_BASENAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

const META_DIR = '.cindy-library';
const META_FILE = 'meta.json';
const USAGE_FILE = 'usage.json';
const TMP_DIR = 'tmp';

/**
 * Library 相对路径校验:isSafeGhostRelativePath 之上再拒 Windows 保留设备名、
 * 尾点段(Windows 落盘静默剥尾点,回执名与真身不一致),外加段数/总长上限。
 * 与 fsSlot.validateFsRelPath 同纪律、不同限额:Library 需要承载
 * canvases/<id>/assets/objects/<shard>/<hash> 深度,段数放到 32、总长放到 512。
 * 返回 null = 合法,否则人话原因。
 */
export function validateLibraryRelPath(p: unknown, limits: LibraryLimits = DEFAULT_LIBRARY_LIMITS): string | null {
  if (typeof p !== 'string' || p.length === 0) return 'path 必填(相对路径,如 "canvases/c1/assets/x.png")';
  if (p.length > limits.pathMaxChars) return `path 超长(上限 ${limits.pathMaxChars} 字符)`;
  if (!isSafeGhostRelativePath(p)) {
    return 'path 必须是安全相对路径:正斜杠分段、无 "."/".."、每段以字母/数字/下划线开头(点开头目录是宿主命名空间,刻意不可写)';
  }
  const segments = p.split('/');
  if (segments.length > limits.pathMaxSegments) {
    return `path 层级过深(上限 ${limits.pathMaxSegments} 段)`;
  }
  for (const seg of segments) {
    if (WINDOWS_RESERVED_BASENAME_RE.test(seg)) {
      return `path 含 Windows 保留设备名段:${seg}`;
    }
    if (seg.endsWith('.')) {
      return `path 段不允许以点结尾(Windows 会静默剥掉尾点):${seg}`;
    }
  }
  return null;
}

/** 大小写折叠(Windows 路径不区分大小写;与 fsSlot 同实现,保持行为一致)。 */
function foldCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** target 是否落在 base 目录内(含 base 自身;两参都应是绝对路径)。 */
function isInsideDir(base: string, target: string): boolean {
  const b = foldCase(path.resolve(base));
  const t = foldCase(path.resolve(target));
  return t === b || t.startsWith(b + path.sep);
}

/**
 * symlink 逃逸校验:找 target 最深的已存在祖先,realpath 后必须仍在 realBase 内
 * (base 内的 symlink 目录指向外面 → 组合路径逃出根,必须拦)。
 */
async function deepestExistingAncestorInside(realBase: string, target: string): Promise<boolean> {
  let probe = target;
  for (;;) {
    const parent = path.dirname(probe);
    try {
      const real = await fs.promises.realpath(parent);
      return isInsideDir(realBase, real);
    } catch {
      if (parent === probe) return false; // 到根还不存在(理论不可达)
      probe = parent;
    }
  }
}

/** 解码写入内容(与 fsSlot.decodeContent 同策略:先按编码长度粗闸再解码)。 */
function decodeContent(
  content: unknown,
  encoding: unknown,
  maxBytes: number,
): { bytes: Buffer } | { errorCode: LibraryErrorCode; message: string } {
  if (typeof content !== 'string') return { errorCode: 'PATH_INVALID', message: '需要 content(字符串)' };
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') {
    return { errorCode: 'PATH_INVALID', message: 'encoding 只支持 "utf8" / "base64"' };
  }
  const overLimit = `内容超限(上限 ${maxBytes} 字节);大文件请走 writeBegin/Chunk/Commit 分块流`;
  let bytes: Buffer;
  if (encoding === 'base64') {
    if (content.length > (maxBytes * 4) / 3 + 8) return { errorCode: 'TOO_LARGE', message: overLimit };
    if (!/^[A-Za-z0-9+/=\r\n]*$/.test(content)) {
      return { errorCode: 'PATH_INVALID', message: 'content 不是合法 base64' };
    }
    bytes = Buffer.from(content, 'base64');
  } else {
    if (content.length > maxBytes) return { errorCode: 'TOO_LARGE', message: overLimit };
    bytes = Buffer.from(content, 'utf8');
  }
  if (bytes.byteLength > maxBytes) return { errorCode: 'TOO_LARGE', message: overLimit };
  return { bytes };
}

/** Node fs 错误 → 结构化失败(ENOENT 收敛为 NOT_FOUND,其余原样带 message)。 */
function fsFailure(err: unknown, fallback: LibraryErrorCode, message: string): LibraryFailure {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
  if (code === 'ENOENT') return { ok: false, errorCode: 'NOT_FOUND', message: '文件或目录不存在' };
  if (code === 'EEXIST' || code === 'ENOTEMPTY') {
    return { ok: false, errorCode: 'ALREADY_EXISTS', message: '目标已存在' };
  }
  return { ok: false, errorCode: fallback, message };
}

const fail = (errorCode: LibraryErrorCode, message: string): LibraryFailure => ({ ok: false, errorCode, message });

/** 在途分块流。tmp 文件独占创建,Commit 前 title 停在 staging 区。 */
interface ActiveStream {
  streamId: string;
  relPath: string;
  tmpAbs: string;
  totalBytes: number;
  sha256Declared: string | null;
  hash: crypto.Hash;
  written: number;
  nextSeq: number;
  ifNotExists: boolean;
  lastAt: number;
}

/**
 * LibraryVault — 单个 (owner × plugin) Library 的文件层实现。
 *
 * 并发模型:全部**变更类**操作(write 系/mkdir/delete/rename/meta/usage)经
 * runSerialized 串行——配额/用量判定与实际落盘之间不允许并发窗口(fsSlot 的
 * 已知缺口);读操作不串行(纯函数于账本快照)。
 */
export class LibraryVault {
  private readonly limits: LibraryLimits;
  private readonly now: () => number;

  private opened = false;
  private invalidated = false;
  private state: LibraryState = 'ready';
  private unavailableReason: string | null = null;
  private readonlyReason: string | null = null;
  /** 用量保险丝触发(扫描条数超限):fail closed 拒写,读照常。 */
  private usageTripped = false;
  private usage: UsageLedger = { files: 0, bytes: 0, updatedAt: 0, mutations: 0 };
  private meta: LibraryMeta | null = null;
  private readonly streams = new Map<string, ActiveStream>();
  /** 变更串行链(runSerialized 维护)。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: LibraryVaultDeps) {
    this.limits = { ...DEFAULT_LIBRARY_LIMITS, ...(deps.limits ?? {}) };
    this.now = deps.now ?? (() => Date.now());
  }

  /** 变更类操作串行化:后到操作排队在前序完成(无论成败)之后。 */
  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private get root(): string {
    return this.deps.rootDir();
  }
  private get metaDir(): string {
    return path.join(this.root, META_DIR);
  }
  private get metaFile(): string {
    return path.join(this.metaDir, META_FILE);
  }
  private get usageFile(): string {
    return path.join(this.metaDir, USAGE_FILE);
  }
  private get tmpDir(): string {
    return path.join(this.metaDir, TMP_DIR);
  }

  private tmpFailure(err: unknown, message: string): LibraryFailure {
    return fsFailure(err, 'INTERNAL', message);
  }

  /* ── 打开与状态 ─────────────────────────────────────────────────── */

  /**
   * 打开(幂等):建目录骨架 → 清理超龄 staging 残渣 → 读/建 meta → 读/扫
   * 用量账本。meta 存在但读不出/不合法 → unavailable(corrupt),**不重建**。
   */
  async open(): Promise<LibraryResult<{ state: LibraryState; reason: string | null; usedBytes: number; fileCount: number }>> {
    return this.runSerialized(async () => {
      if (this.invalidated) {
        return fail('LIBRARY_UNAVAILABLE', 'Library 实例已作废(owner 切换/宿主收口);请重新 open');
      }
      try {
        await fs.promises.mkdir(this.root, { recursive: true });
        await fs.promises.mkdir(this.tmpDir, { recursive: true });
        await fs.promises.mkdir(path.join(this.metaDir, 'backups'), { recursive: true });
      } catch (err) {
        this.state = 'unavailable';
        this.unavailableReason = 'permission';
        this.deps.log?.warn('library open: cannot create root', { error: err instanceof Error ? err.message : String(err) });
        return { ok: true as const, state: this.state, reason: this.unavailableReason, usedBytes: 0, fileCount: 0 };
      }
      await this.sweepStaleTmp();

      // meta:已存在必须可解析(不可用 ≠ 空);不存在则首建。
      try {
        const raw = await fs.promises.readFile(this.metaFile, 'utf8');
        const parsed = JSON.parse(raw) as LibraryMeta;
        if (
          typeof parsed !== 'object' || parsed === null || parsed.version !== 1 ||
          typeof parsed.ghostId !== 'string' || typeof parsed.createdAt !== 'number'
        ) {
          throw new Error('malformed meta');
        }
        this.meta = parsed;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.meta = { version: 1, ghostId: this.deps.ghostId ?? '', createdAt: this.now() };
          const w = await this.writeMetaUnlocked();
          if (w) return w;
        } else {
          this.opened = true;
          this.state = 'unavailable';
          this.unavailableReason = 'corrupt';
          this.deps.log?.warn('library open: meta unreadable; refusing to rebuild', {});
          return { ok: true as const, state: this.state, reason: this.unavailableReason, usedBytes: 0, fileCount: 0 };
        }
      }

      // 用量:账本读不出就全量重扫(账本是缓存,真身是文件树)。
      let ledger: UsageLedger | null = null;
      try {
        const raw = JSON.parse(await fs.promises.readFile(this.usageFile, 'utf8')) as UsageLedger;
        if (typeof raw === 'object' && raw !== null && typeof raw.files === 'number' && typeof raw.bytes === 'number') {
          ledger = { files: raw.files, bytes: raw.bytes, updatedAt: raw.updatedAt ?? 0, mutations: raw.mutations ?? 0 };
        }
      } catch {
        /* 损坏/缺失 → 重扫 */
      }
      if (!ledger) {
        const scanned = await this.scanUsageUnlocked();
        if (scanned.tripped) {
          this.usageTripped = true;
          this.usage = { files: scanned.files, bytes: scanned.bytes, updatedAt: this.now(), mutations: 0 };
        } else {
          this.usage = { files: scanned.files, bytes: scanned.bytes, updatedAt: this.now(), mutations: 0 };
          await this.persistUsageUnlocked();
        }
      } else {
        this.usage = ledger;
      }
      this.opened = true;
      if (this.state === 'unavailable') {
        // 上次 open 判过 corrupt 的进程内状态不跨实例;这里防御性复位,
        // 以本次实测为准。
        this.state = 'ready';
        this.unavailableReason = null;
      }
      return { ok: true as const, state: this.effectiveState(), reason: this.unavailableReason ?? this.readonlyReason, usedBytes: this.usage.bytes, fileCount: this.usage.files };
    });
  }

  private effectiveState(): LibraryState {
    if (this.state === 'unavailable') return 'unavailable';
    if (this.readonlyReason !== null) return 'readonly';
    return 'ready';
  }

  /** status:状态 + 占用 + 磁盘余量 + 软水位(软水位仅告警,不阻断写)。 */
  async status(): Promise<LibraryResult<{
    state: LibraryState;
    reason: string | null;
    usedBytes: number;
    fileCount: number;
    diskFreeBytes: number | null;
    softLimitBytes: number;
    softLimitExceeded: boolean;
    location: 'default' | 'custom';
  }>> {
    if (!this.opened) {
      const o = await this.open();
      if (!o.ok) return o;
    }
    let diskFree: number | null = null;
    if (this.deps.getDiskFreeBytes) {
      try {
        diskFree = await this.deps.getDiskFreeBytes(this.root);
      } catch {
        diskFree = null;
      }
    }
    return {
      ok: true as const,
      state: this.effectiveState(),
      reason: this.unavailableReason ?? this.readonlyReason,
      usedBytes: this.usage.bytes,
      fileCount: this.usage.files,
      diskFreeBytes: diskFree,
      softLimitBytes: this.limits.softLimitBytes,
      softLimitExceeded: this.usage.bytes > this.limits.softLimitBytes,
      location: this.deps.locationKind ?? 'default',
    };
  }

  /* ── 写前公共闸 ─────────────────────────────────────────────────── */

  private requireWritable(): LibraryFailure | null {
    if (this.state === 'unavailable') {
      return fail('LIBRARY_UNAVAILABLE', `Library 不可用(${this.unavailableReason ?? 'io'});不会当作空库处理`);
    }
    if (this.readonlyReason !== null) {
      return fail('LIBRARY_READONLY', `Library 只读(${this.readonlyReason})`);
    }
    if (this.usageTripped) {
      return fail('LIBRARY_UNAVAILABLE', 'Library 结构过大,无法核算占用;请清理后重试');
    }
    return null;
  }

  /** 磁盘保留水位检查(余量未知时跳过,依赖 ENOSPC 兜底)。 */
  private async checkDiskReserve(extraBytes: number): Promise<LibraryFailure | null> {
    if (!this.deps.getDiskFreeBytes) return null;
    let free: number | null = null;
    try {
      free = await this.deps.getDiskFreeBytes(this.root);
    } catch {
      return null;
    }
    if (free !== null && free - extraBytes < this.limits.diskReserveBytes) {
      return fail('DISK_FULL', `磁盘剩余空间低于保留水位(${this.limits.diskReserveBytes} 字节);请清理磁盘或迁移 Library`);
    }
    return null;
  }

  /** 解析并校验相对路径 → 绝对目标;含越界与祖先 symlink 收敛检查。 */
  private async resolveTarget(relPath: string): Promise<{ target: string; realBase: string } | LibraryFailure> {
    const base = this.root;
    let realBase: string;
    try {
      realBase = await fs.promises.realpath(base);
    } catch {
      return fail('LIBRARY_UNAVAILABLE', 'Library 根目录不可访问');
    }
    const target = path.join(base, ...relPath.split('/'));
    if (!isInsideDir(base, target)) return fail('PATH_INVALID', 'path 越界');
    if (!(await deepestExistingAncestorInside(realBase, target))) {
      return fail('PATH_INVALID', 'path 越界(中间目录含指向根外的符号链接)');
    }
    return { target, realBase };
  }

  /** 目标本身不得是 symlink(不穿透);返回 stat 或 null(不存在)。 */
  private async lstatTarget(target: string): Promise<fs.Stats | null> {
    try {
      return await fs.promises.lstat(target);
    } catch {
      return null;
    }
  }

  /* ── 原子写核心 ─────────────────────────────────────────────────── */

  /**
   * 原子落盘:tmp 独占创建(wx)→ 写 → fsync → rename/link 就位 → identity
   * (dev/ino)复验。ifNotExists 用 link+EEXIST(原子排他);覆盖用 rename
   * (libuv 在 Windows 走 MoveFileEx REPLACE_EXISTING,同为原子替换)。
   * 目录 fsync 在 Windows 不可用(无法 open 目录 fd),跨平台只保证文件体
   * fsync——崩溃最坏留 tmp 残渣(sweepStaleTmp 清理),不留半成品于终位。
   */
  private async atomicWrite(
    target: string,
    bytes: Buffer,
    opts: { ifNotExists?: boolean } = {},
  ): Promise<LibraryResult<{ dev: number; ino: number }>> {
    const tmp = path.join(this.tmpDir, `${randomUUID()}.tmp`);
    let openedStat: fs.Stats | null = null;
    let fh: fs.promises.FileHandle | null = null;
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      fh = await fs.promises.open(tmp, 'wx', 0o600);
      await fh.writeFile(bytes);
      await fh.sync();
      openedStat = await fh.stat();
      await fh.close();
      fh = null;
      if (opts.ifNotExists) {
        try {
          await fs.promises.link(tmp, target);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            return fail('ALREADY_EXISTS', '目标已存在(ifNotExists)');
          }
          throw err;
        }
        await fs.promises.unlink(tmp).catch(() => {});
      } else {
        await fs.promises.rename(tmp, target);
      }
      const after = await this.lstatTarget(target);
      if (!after || !after.isFile() || after.dev !== openedStat.dev || after.ino !== openedStat.ino) {
        // 就位后被换(或落到了非预期对象):如实报内部错误,不静默。
        return fail('INTERNAL', '写入就位校验失败(目标 identity 不一致)');
      }
      return { ok: true as const, dev: after.dev, ino: after.ino };
    } catch (err) {
      return this.tmpFailure(err, '写入失败(主机 IO 错误)');
    } finally {
      if (fh) await fh.close().catch(() => {});
      await fs.promises.unlink(tmp).catch(() => {});
    }
  }

  /** 元数据/账本小文件写(meta 目录内,自身也走原子写)。 */
  private async writeJsonAtomic(absFile: string, value: unknown): Promise<LibraryResult<{ dev: number; ino: number }>> {
    return this.atomicWrite(absFile, Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
  }

  private async writeMetaUnlocked(): Promise<LibraryFailure | null> {
    if (!this.meta) return fail('INTERNAL', 'meta 未初始化');
    const w = await this.writeJsonAtomic(this.metaFile, this.meta);
    return w.ok ? null : w;
  }

  private async persistUsageUnlocked(): Promise<void> {
    if (!this.meta) return;
    this.usage.updatedAt = this.now();
    await this.writeJsonAtomic(this.usageFile, this.usage).catch((err) => {
      this.deps.log?.warn('library usage persist failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  /** 清理超龄 staging 残渣(崩溃遗留;龄 > tmpMaxAgeMs)。 */
  private async sweepStaleTmp(): Promise<void> {
    const cutoff = this.now() - this.limits.tmpMaxAgeMs;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.tmpDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue; // 非普通条目不动(对齐受管根纪律)
      const full = path.join(this.tmpDir, entry.name);
      try {
        const st = await fs.promises.stat(full);
        if (st.mtimeMs < cutoff) await fs.promises.unlink(full);
      } catch {
        /* 竞态,跳过 */
      }
    }
  }

  /** 用量全量扫描(条数保险丝;触发 fail closed,见 requireWritable)。
   *  宿主命名空间 .cindy-library/ 不计入——那是 meta/账本/staging,不是插件作品。 */
  private async scanUsageUnlocked(): Promise<{ files: number; bytes: number; tripped: boolean }> {
    let files = 0;
    let bytes = 0;
    let visited = 0;
    const stack: string[] = [this.root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (dir === this.root && entry.name === META_DIR) continue; // 宿主命名空间不入账
        if (++visited > this.limits.usageScanFuse) return { files, bytes, tripped: true };
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) {
          files += 1;
          try {
            bytes += (await fs.promises.stat(full)).size;
          } catch {
            /* 竞态删除,跳过 */
          }
        }
      }
    }
    return { files, bytes, tripped: false };
  }

  /* ── 文件操作 ───────────────────────────────────────────────────── */

  async read(req: { path: unknown; encoding?: unknown; offset?: unknown; length?: unknown }): Promise<LibraryResult<{ path: string; content: string; encoding: 'utf8' | 'base64'; bytes: number; sha256: string }>> {
    if (!this.opened) return fail('LIBRARY_UNAVAILABLE', 'Library 未打开(先调用 open)');
    const reason = validateLibraryRelPath(req.path, this.limits);
    if (reason) return fail('PATH_INVALID', reason);
    const relPath = req.path as string;
    if (req.encoding !== undefined && req.encoding !== 'utf8' && req.encoding !== 'base64') {
      return fail('PATH_INVALID', 'encoding 只支持 "utf8" / "base64"');
    }
    const resolved = await this.resolveTarget(relPath);
    if (!('target' in resolved)) return resolved;
    const st = await this.lstatTarget(resolved.target);
    if (!st) return fail('NOT_FOUND', `文件不存在:${relPath}`);
    if (!st.isFile()) return fail('PATH_INVALID', `不是文件:${relPath}`);
    const offset = typeof req.offset === 'number' && Number.isInteger(req.offset) && req.offset >= 0 ? req.offset : 0;
    if (offset > st.size) return fail('PATH_INVALID', `offset 超出文件大小(${st.size})`);
    let length = st.size - offset;
    if (typeof req.length === 'number' && Number.isInteger(req.length) && req.length >= 0) {
      length = Math.min(length, req.length);
    }
    if (length > this.limits.readMaxBytes) {
      return fail('TOO_LARGE', `读取长度超上限(${length} > ${this.limits.readMaxBytes});请用 offset/length 分段读`);
    }
    try {
      const fh = await fs.promises.open(resolved.target, 'r');
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = length === 0 ? { bytesRead: 0 } : await fh.read(buf, 0, length, offset);
        const out = buf.subarray(0, bytesRead);
        const encoding = req.encoding === 'base64' ? ('base64' as const) : ('utf8' as const);
        return {
          ok: true as const,
          path: relPath,
          content: out.toString(encoding),
          encoding,
          bytes: bytesRead,
          sha256: crypto.createHash('sha256').update(out).digest('hex'),
        };
      } finally {
        await fh.close();
      }
    } catch (err) {
      return this.tmpFailure(err, '读取失败(主机 IO 错误)');
    }
  }

  async write(req: { path: unknown; content: unknown; encoding?: unknown; ifNotExists?: unknown }): Promise<LibraryResult<{ path: string; bytes: number; sha256: string }>> {
    if (!this.opened) return fail('LIBRARY_UNAVAILABLE', 'Library 未打开(先调用 open)');
    return this.runSerialized(async () => {
      const gate = this.requireWritable();
      if (gate) return gate;
      const reason = validateLibraryRelPath(req.path, this.limits);
      if (reason) return fail('PATH_INVALID', reason);
      const relPath = req.path as string;
      const decoded = decodeContent(req.content, req.encoding, this.limits.writeMaxBytes);
      if (!('bytes' in decoded)) return fail(decoded.errorCode, decoded.message);
      const resolved = await this.resolveTarget(relPath);
      if (!('target' in resolved)) return resolved;
      const st = await this.lstatTarget(resolved.target);
      if (st) {
        if (st.isSymbolicLink()) return fail('PATH_INVALID', '目标是符号链接,拒绝穿透写入');
        if (st.isDirectory()) return fail('PATH_INVALID', `目标是目录:${relPath}`);
      }
      const disk = await this.checkDiskReserve(decoded.bytes.byteLength);
      if (disk) return disk;
      const existedBytes = st && st.isFile() ? st.size : 0;
      const w = await this.atomicWrite(resolved.target, decoded.bytes, {
        ifNotExists: req.ifNotExists === true,
      });
      if (!w.ok) return w;
      // 用量增量记账(files/bytes);覆盖写扣除旧体积。
      this.usage.bytes += decoded.bytes.byteLength - existedBytes;
      if (!st) this.usage.files += 1;
      this.usage.mutations += 1;
      await this.persistUsageUnlocked();
      return {
        ok: true as const,
        path: relPath,
        bytes: decoded.bytes.byteLength,
        sha256: crypto.createHash('sha256').update(decoded.bytes).digest('hex'),
      };
    });
  }

  async writeBegin(req: { path: unknown; totalBytes: unknown; sha256?: unknown }): Promise<LibraryResult<{ streamId: string }>> {
    if (!this.opened) return fail('LIBRARY_UNAVAILABLE', 'Library 未打开(先调用 open)');
    return this.runSerialized(async () => {
      const gate = this.requireWritable();
      if (gate) return gate;
      const reason = validateLibraryRelPath(req.path, this.limits);
      if (reason) return fail('PATH_INVALID', reason);
      const relPath = req.path as string;
      if (typeof req.totalBytes !== 'number' || !Number.isInteger(req.totalBytes) || req.totalBytes < 0) {
        return fail('PATH_INVALID', 'totalBytes 必须是非负整数');
      }
      if (req.totalBytes > this.limits.streamMaxTotalBytes) {
        return fail('TOO_LARGE', `分块流总大小超上限(${this.limits.streamMaxTotalBytes} 字节)`);
      }
      if (req.sha256 !== undefined && (typeof req.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(req.sha256))) {
        return fail('PATH_INVALID', 'sha256 必须是 64 位小写十六进制');
      }
      const resolved = await this.resolveTarget(relPath);
      if (!('target' in resolved)) return resolved;
      const st = await this.lstatTarget(resolved.target);
      if (st) {
        if (st.isSymbolicLink()) return fail('PATH_INVALID', '目标是符号链接,拒绝穿透写入');
        if (st.isDirectory()) return fail('PATH_INVALID', `目标是目录:${relPath}`);
      }
      const disk = await this.checkDiskReserve(req.totalBytes);
      if (disk) return disk;
      await this.sweepIdleStreamsUnlocked();
      const streamId = randomUUID();
      const tmpAbs = path.join(this.tmpDir, `${streamId}.stream`);
      try {
        const fh = await fs.promises.open(tmpAbs, 'wx', 0o600);
        await fh.close();
      } catch (err) {
        return this.tmpFailure(err, '分块流创建失败(主机 IO 错误)');
      }
      this.streams.set(streamId, {
        streamId,
        relPath,
        tmpAbs,
        totalBytes: req.totalBytes,
        sha256Declared: (req.sha256 as string | undefined) ?? null,
        hash: crypto.createHash('sha256'),
        written: 0,
        nextSeq: 1,
        ifNotExists: false,
        lastAt: this.now(),
      });
      return { ok: true as const, streamId };
    });
  }

  async writeChunk(req: { streamId: unknown; seq: unknown; content: unknown; encoding?: unknown }): Promise<LibraryResult<{ accepted: number }>> {
    if (!this.opened) return fail('LIBRARY_UNAVAILABLE', 'Library 未打开(先调用 open)');
    // 分块也走串行链:seq 判定与追加落盘之间不允许并发窗口(并发同 seq 会双写)。
    return this.runSerialized(async () => {
      const gate = this.requireWritable();
      if (gate) return gate;
      const stream = typeof req.streamId === 'string' ? this.streams.get(req.streamId) : undefined;
      if (!stream) return fail('STREAM_INVALID', 'streamId 无效或已结束');
      if (typeof req.seq !== 'number' || !Number.isInteger(req.seq) || req.seq !== stream.nextSeq) {
        return fail('STREAM_INVALID', `seq 必须从 1 起连续(期望 ${stream.nextSeq})`);
      }
      const decoded = decodeContent(req.content, req.encoding, this.limits.writeMaxBytes);
      if (!('bytes' in decoded)) return fail(decoded.errorCode, decoded.message);
      if (stream.written + decoded.bytes.byteLength > stream.totalBytes) {
        return fail('STREAM_INVALID', `累计字节数将超出声明的 totalBytes(${stream.totalBytes})`);
      }
      try {
        const fh = await fs.promises.open(stream.tmpAbs, 'a');
        try {
          await fh.writeFile(decoded.bytes);
        } finally {
          await fh.close();
        }
      } catch (err) {
        await this.abortStreamUnlocked(stream.streamId).catch(() => {});
        return this.tmpFailure(err, '分块写入失败(主机 IO 错误)');
      }
      stream.hash.update(decoded.bytes);
      stream.written += decoded.bytes.byteLength;
      stream.nextSeq += 1;
      stream.lastAt = this.now();
      return { ok: true as const, accepted: decoded.bytes.byteLength };
    });
  }

  async writeCommit(req: { streamId: unknown }): Promise<LibraryResult<{ path: string; bytes: number; sha256: string }>> {
    if (!this.opened) return fail('LIBRARY_UNAVAILABLE', 'Library 未打开(先调用 open)');
    return this.runSerialized(async () => {
      const gate = this.requireWritable();
      if (gate) return gate;
      const stream = typeof req.streamId === 'string' ? this.streams.get(req.streamId) : undefined;
      if (!stream) return fail('STREAM_INVALID', 'streamId 无效或已结束');
      if (stream.written !== stream.totalBytes) {
        await this.abortStreamUnlocked(stream.streamId).catch(() => {});
        return fail('STREAM_INVALID', `字节数不完整(已收 ${stream.written} / 声明 ${stream.totalBytes})`);
      }
      const sha256 = stream.hash.digest('hex');
      if (stream.sha256Declared !== null && sha256 !== stream.sha256Declared) {
        await this.abortStreamUnlocked(stream.streamId).catch(() => {});
        return fail('STREAM_INVALID', 'sha256 校验失败(声明值与实际字节不一致)');
      }
      // fsync staging 后走与 write 相同的就位+复验路径。
      try {
        const fh = await fs.promises.open(stream.tmpAbs, 'r+');
        try {
          await fh.sync();
        } finally {
          await fh.close();
        }
      } catch (err) {
        await this.abortStreamUnlocked(stream.streamId).catch(() => {});
        return this.tmpFailure(err, '分块提交失败(主机 IO 错误)');
      }
      const resolved = await this.resolveTarget(stream.relPath);
      if (!('target' in resolved)) {
        await this.abortStreamUnlocked(stream.streamId).catch(() => {});
        return resolved;
      }
      const prior = await this.lstatTarget(resolved.target);
      const existedBytes = prior && prior.isFile() ? prior.size : 0;
      try {
        await fs.promises.mkdir(path.dirname(resolved.target), { recursive: true });
        await fs.promises.rename(stream.tmpAbs, resolved.target);
      } catch (err) {
        await this.abortStreamUnlocked(stream.streamId).catch(() => {});
        return this.tmpFailure(err, '分块提交失败(主机 IO 错误)');
      }
      const after = await this.lstatTarget(resolved.target);
      if (!after || !after.isFile()) {
        return fail('INTERNAL', '分块提交就位校验失败');
      }
      this.streams.delete(stream.streamId);
      this.usage.bytes += stream.totalBytes - existedBytes;
      if (!prior) this.usage.files += 1;
      this.usage.mutations += 1;
      await this.persistUsageUnlocked();
      return { ok: true as const, path: stream.relPath, bytes: stream.totalBytes, sha256 };
    });
  }

  async writeAbort(req: { streamId: unknown }): Promise<LibraryResult<{ aborted: boolean }>> {
    const stream = typeof req.streamId === 'string' ? this.streams.get(req.streamId) : undefined;
    if (!stream) return { ok: true as const, aborted: false }; // 幂等
    return this.runSerialized(async () => {
      await this.abortStreamUnlocked(stream.streamId).catch(() => {});
      return { ok: true as const, aborted: true };
    });
  }

  private async abortStreamUnlocked(streamId: string): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this.streams.delete(streamId);
    await fs.promises.unlink(stream.tmpAbs).catch(() => {});
  }

  /** 闲置超时残流清扫(挂在 writeBegin 的串行链上)。 */
  private async sweepIdleStreamsUnlocked(): Promise<void> {
    const cutoff = this.now() - this.limits.streamIdleTimeoutMs;
    for (const stream of Array.from(this.streams.values())) {
      if (stream.lastAt < cutoff) await this.abortStreamUnlocked(stream.streamId).catch(() => {});
    }
  }

  async stat(req: { path: unknown }): Promise<LibraryResult<{ path: string; kind: 'file' | 'dir'; bytes: number; mtime: number }>> {
    if (!this.opened) return fail('LIBRARY_UNAVAILABLE', 'Library 未打开(先调用 open)');
    const reason = validateLibraryRelPath(req.path, this.limits);
    if (reason) return fail('PATH_INVALID', reason);
    const relPath = req.path as string;
    const resolved = await this.resolveTarget(relPath);
    if (!('target' in resolved)) return resolved;
    const st = await this.lstatTarget(resolved.target);
    if (!st) return fail('NOT_FOUND', `不存在:${relPath}`);
    if (st.isFile()) {
      return { ok: true as const, path: relPath, kind: 'file', bytes: st.size, mtime: Math.round(st.mtimeMs) };
    }
    if (st.isDirectory()) {
      return { ok: true as const, path: relPath, kind: 'dir', bytes: 0, mtime: Math.round(st.mtimeMs) };
    }
    return fail('PATH_INVALID', `不是普通文件或目录:${relPath}`);
  }

  async mkdir(req: { path: unknown }): Promise<LibraryResult<{ path: string; existed: boolean }>> {
    if (!this.opened) return fail('LIBRARY_UNAVAILABLE', 'Library 未打开(先调用 open)');
    return this.runSerialized(async () => {
      const gate = this.requireWritable();
      if (gate) return gate;
      const reason = validateLibraryRelPath(req.path, this.limits);
      if (reason) return fail('PATH_INVALID', reason);
      const relPath = req.path as string;
      const resolved = await this.resolveTarget(relPath);
      if (!('target' in resolved)) return resolved;
      const prior = await this.lstatTarget(resolved.target);
      if (prior) {
        if (!prior.isDirectory()) return fail('ALREADY_EXISTS', `目标已存在且不是目录:${relPath}`);
        return { ok: true as const, path: relPath, existed: true };
      }
      try {
        await fs.promises.mkdir(resolved.target, { recursive: true });
      } catch (err) {
        return this.tmpFailure(err, '创建目录失败(主机 IO 错误)');
      }
      return { ok: true as const, path: relPath, existed: false };
    });
  }

  async list(req: { path?: unknown; recursive?: unknown; cursor?: unknown; limit?: unknown }): Promise<LibraryResult<{ entries: Array<{ path: string; kind: 'file' | 'dir'; bytes: number; mtime: number }>; hasMore: boolean; nextCursor: string | null }>> {
    if (!this.opened) return fail('LIBRARY_UNAVAILABLE', 'Library 未打开(先调用 open)');
    const sub = req.path === undefined || req.path === '' ? '' : String(req.path);
    if (sub !== '') {
      const reason = validateLibraryRelPath(sub, this.limits);
      if (reason) return fail('PATH_INVALID', reason);
    }
    const base = this.root;
    const listRoot = sub === '' ? base : path.join(base, ...sub.split('/'));
    if (!isInsideDir(base, listRoot)) return fail('PATH_INVALID', 'path 越界');
    const recursive = req.recursive === true;
    const limit = Math.min(
      typeof req.limit === 'number' && Number.isInteger(req.limit) && req.limit > 0 ? req.limit : this.limits.listPageSize,
      this.limits.listPageSize,
    );
    let afterPath: string | null = null;
    if (req.cursor !== undefined && req.cursor !== null) {
      if (typeof req.cursor !== 'string' || req.cursor.length === 0 || !/^[A-Za-z0-9+/=_-]+$/.test(req.cursor)) {
        return fail('PATH_INVALID', 'cursor 非法');
      }
      try {
        const decoded = Buffer.from(req.cursor, 'base64').toString('utf8');
        if (!isSafeGhostRelativePath(decoded)) return fail('PATH_INVALID', 'cursor 非法');
        afterPath = decoded;
      } catch {
        return fail('PATH_INVALID', 'cursor 非法');
      }
    }
    const entries: Array<{ path: string; kind: 'file' | 'dir'; bytes: number; mtime: number }> = [];
    let hasMore = false;
    const push = (rel: string, kind: 'file' | 'dir', bytes: number, mtime: number): boolean => {
      if (afterPath !== null && rel <= afterPath) return true; // 游标之前:跳过但继续走
      if (entries.length >= limit) {
        hasMore = true;
        return false;
      }
      entries.push({ path: rel, kind, bytes, mtime });
      return true;
    };
    try {
      if (!recursive) {
        const dirents = await fs.promises.readdir(listRoot, { withFileTypes: true });
        const names = dirents.map((d) => d.name).filter((n) => !(listRoot === base && n === META_DIR)).sort();
        for (const name of names) {
          const full = path.join(listRoot, name);
          let st: fs.Stats;
          try {
            st = await fs.promises.lstat(full);
          } catch {
            continue;
          }
          const rel = path.relative(base, full).split(path.sep).join('/');
          if (st.isFile()) {
            if (!push(rel, 'file', st.size, Math.round(st.mtimeMs))) break;
          } else if (st.isDirectory()) {
            if (!push(rel, 'dir', 0, Math.round(st.mtimeMs))) break;
          }
        }
      } else {
        // 递归:先收集全部相对路径(不 stat),全局排序后按游标切片,只为当页
        // 条目取 stat——游标续页要求全局字典序,DFS 逐层排序拼不出全局序。
        const all: Array<{ rel: string; abs: string; isDir: boolean }> = [];
        const stack: string[] = [listRoot];
        while (stack.length > 0) {
          const dir = stack.pop()!;
          let dirents: fs.Dirent[];
          try {
            dirents = await fs.promises.readdir(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const entry of dirents) {
            if (dir === base && entry.name === META_DIR) continue; // 宿主命名空间不可见
            const full = path.join(dir, entry.name);
            const rel = path.relative(base, full).split(path.sep).join('/');
            if (entry.isDirectory()) {
              all.push({ rel, abs: full, isDir: true });
              stack.push(full);
            } else if (entry.isFile()) {
              all.push({ rel, abs: full, isDir: false });
            }
          }
        }
        all.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
        for (const item of all) {
          if (afterPath !== null && item.rel <= afterPath) continue;
          if (entries.length >= limit) {
            hasMore = true;
            break;
          }
          let st: fs.Stats;
          try {
            st = await fs.promises.lstat(item.abs);
          } catch {
            continue;
          }
          if (item.isDir) entries.push({ path: item.rel, kind: 'dir', bytes: 0, mtime: Math.round(st.mtimeMs) });
          else entries.push({ path: item.rel, kind: 'file', bytes: st.size, mtime: Math.round(st.mtimeMs) });
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: true as const, entries: [], hasMore: false, nextCursor: null };
      }
      return this.tmpFailure(err, '列目录失败(主机 IO 错误)');
    }
    const nextCursor = hasMore && entries.length > 0
      ? Buffer.from(entries[entries.length - 1].path, 'utf8').toString('base64')
      : null;
    return { ok: true as const, entries, hasMore, nextCursor };
  }

  async delete(req: { path: unknown; recursive?: unknown }): Promise<LibraryResult<{ path: string; existed: boolean }>> {
    if (!this.opened) return fail('LIBRARY_UNAVAILABLE', 'Library 未打开(先调用 open)');
    return this.runSerialized(async () => {
      const gate = this.requireWritable();
      if (gate) return gate;
      const reason = validateLibraryRelPath(req.path, this.limits);
      if (reason) return fail('PATH_INVALID', reason);
      const relPath = req.path as string;
      const resolved = await this.resolveTarget(relPath);
      if (!('target' in resolved)) return resolved;
      const st = await this.lstatTarget(resolved.target);
      if (!st) return { ok: true as const, path: relPath, existed: false }; // 幂等
      let removedBytes = 0;
      let removedFiles = 0;
      if (st.isDirectory()) {
        if (req.recursive === true) {
          const usage = await this.scanDirUsage(resolved.target);
          try {
            await fs.promises.rm(resolved.target, { recursive: true, force: false });
          } catch (err) {
            return this.tmpFailure(err, '删除目录失败(主机 IO 错误)');
          }
          removedBytes = usage.bytes;
          removedFiles = usage.files;
        } else {
          try {
            await fs.promises.rmdir(resolved.target);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
              return fail('ALREADY_EXISTS', '目录非空;需要 recursive:true 才能递归删除');
            }
            return this.tmpFailure(err, '删除目录失败(主机 IO 错误)');
          }
        }
      } else if (st.isFile() || st.isSymbolicLink()) {
        // 库内 symlink(插件造不出来,但磁盘可能有):unlink 链接本身,不穿透。
        try {
          await fs.promises.unlink(resolved.target);
        } catch (err) {
          return this.tmpFailure(err, '删除文件失败(主机 IO 错误)');
        }
        removedBytes = st.isFile() ? st.size : 0;
        removedFiles = 1;
        // 空目录剪枝(向上 rmdir 到根为止,遇非空即停):不剪则目录残骸永久
        // 计入用量扫描(与 fsSlot 同教训)。
        let dir = path.dirname(resolved.target);
        while (isInsideDir(this.root, dir) && foldCase(dir) !== foldCase(path.resolve(this.root))) {
          try {
            await fs.promises.rmdir(dir);
          } catch {
            break;
          }
          dir = path.dirname(dir);
        }
      } else {
        return fail('PATH_INVALID', `不是可删除对象:${relPath}`);
      }
      this.usage.bytes = Math.max(0, this.usage.bytes - removedBytes);
      this.usage.files = Math.max(0, this.usage.files - removedFiles);
      this.usage.mutations += 1;
      await this.persistUsageUnlocked();
      return { ok: true as const, path: relPath, existed: true };
    });
  }

  private async scanDirUsage(dir: string): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    const stack = [dir];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(cur, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) {
          files += 1;
          try {
            bytes += (await fs.promises.stat(full)).size;
          } catch {
            /* 竞态,跳过 */
          }
        }
      }
    }
    return { files, bytes };
  }

  async rename(req: { from: unknown; to: unknown; overwrite?: unknown }): Promise<LibraryResult<{ from: string; to: string }>> {
    if (!this.opened) return fail('LIBRARY_UNAVAILABLE', 'Library 未打开(先调用 open)');
    return this.runSerialized(async () => {
      const gate = this.requireWritable();
      if (gate) return gate;
      for (const p of [req.from, req.to]) {
        const reason = validateLibraryRelPath(p, this.limits);
        if (reason) return fail('PATH_INVALID', reason);
      }
      const from = req.from as string;
      const to = req.to as string;
      if (from === to) return { ok: true as const, from, to };
      const src = await this.resolveTarget(from);
      if (!('target' in src)) return src;
      const dst = await this.resolveTarget(to);
      if (!('target' in dst)) return dst;
      const st = await this.lstatTarget(src.target);
      if (!st) return fail('NOT_FOUND', `源不存在:${from}`);
      if (!st.isFile()) return fail('PATH_INVALID', `只能重命名文件(目录请逐文件处理):${from}`);
      const prior = await this.lstatTarget(dst.target);
      if (prior) {
        if (prior.isSymbolicLink()) return fail('PATH_INVALID', '目标是符号链接,拒绝覆盖');
        if (prior.isDirectory()) return fail('PATH_INVALID', `目标是目录:${to}`);
        if (req.overwrite !== true) return fail('ALREADY_EXISTS', `目标已存在:${to}(需 overwrite:true 才覆盖)`);
      }
      const disk = await this.checkDiskReserve(0);
      if (disk) return disk;
      const identity = { dev: st.dev, ino: st.ino };
      try {
        await fs.promises.mkdir(path.dirname(dst.target), { recursive: true });
        if (req.overwrite === true) {
          await fs.promises.rename(src.target, dst.target);
        } else {
          // 原子排他:link 失败 EEXIST = 目标刚被并发创建;成功后 unlink 源。
          // link+unlink 两步之间崩溃会留下两份同容文件(内容不变,无损坏),
          // 下次覆盖写/rename 自愈——比「先查再 rename」的 TOCTOU 窗口安全。
          await fs.promises.link(src.target, dst.target);
          await fs.promises.unlink(src.target);
        }
      } catch (err) {
        return this.tmpFailure(err, '重命名失败(主机 IO 错误)');
      }
      const after = await this.lstatTarget(dst.target);
      if (!after || after.dev !== identity.dev || after.ino !== identity.ino) {
        return fail('INTERNAL', '重命名就位校验失败(identity 不一致)');
      }
      // 账本:文件数不变;覆盖替换时扣掉被替换文件的体积与计数。
      if (prior && prior.isFile()) {
        this.usage.bytes = Math.max(0, this.usage.bytes - prior.size);
        this.usage.files = Math.max(0, this.usage.files - 1);
      }
      this.usage.mutations += 1;
      await this.persistUsageUnlocked();
      // 源空目录剪枝(rename 腾出的父目录不残留)。
      let dir = path.dirname(src.target);
      while (isInsideDir(this.root, dir) && foldCase(dir) !== foldCase(path.resolve(this.root))) {
        try {
          await fs.promises.rmdir(dir);
        } catch {
          break;
        }
        dir = path.dirname(dir);
      }
      return { ok: true as const, from, to };
    });
  }

  /* ── 生命周期与显式状态控制 ─────────────────────────────────────── */

  /** 卸载标记(上层 uninstall 流程调用;数据本体不动)。 */
  async markOrphaned(displayName: string): Promise<LibraryFailure | null> {
    return this.runSerialized(async () => {
      if (!this.meta) return fail('INTERNAL', 'meta 未初始化');
      this.meta = { ...this.meta, orphaned: { at: this.now(), name: displayName } };
      return this.writeMetaUnlocked();
    });
  }

  /** 重装清除卸载标记。 */
  async clearOrphaned(): Promise<LibraryFailure | null> {
    return this.runSerialized(async () => {
      if (!this.meta) return fail('INTERNAL', 'meta 未初始化');
      if (!('orphaned' in this.meta)) return null;
      this.meta = { version: this.meta.version, ghostId: this.meta.ghostId, createdAt: this.meta.createdAt };
      return this.writeMetaUnlocked();
    });
  }

  getMeta(): Readonly<LibraryMeta> | null {
    return this.meta;
  }

  /** 库根绝对路径(宿主侧代码用:面板路由/备份目标等;不经插件)。 */
  getRootDir(): string {
    return this.root;
  }

  /**
   * 面板投影路由(cindy-ghost://<id>/library/<relPath>)的宿主侧解析:
   * 相对路径 → 已存在普通文件的绝对路径。路径纪律与 read 同源;任何校验
   * 不过(越界/symlink/不存在/是目录)返回 null,调用方统一折叠 404。
   */
  async resolveExistingFile(relPath: string): Promise<string | null> {
    const reason = validateLibraryRelPath(relPath, this.limits);
    if (reason) return null;
    const resolved = await this.resolveTarget(relPath);
    if (!('target' in resolved)) return null;
    const st = await this.lstatTarget(resolved.target);
    if (!st || !st.isFile()) return null;
    return resolved.target;
  }

  /**
   * dbPath(库内 .sqlite 相对路径)→ 绝对路径,走与 read 同源的收敛校验
   * (库内预置的目录 symlink 指向根外时,合法相对 dbPath 也拒——SQLite 打开
   * 的文件必须落在库根内,review:dbPath 绕过 symlink 收敛)。文件本体可以
   * 不存在(新建库),校验只针对路径与祖先。
   */
  async resolveDbTarget(relPath: string): Promise<string | null> {
    const reason = validateLibraryRelPath(relPath, this.limits);
    if (reason) return null;
    const resolved = await this.resolveTarget(relPath);
    if (!('target' in resolved)) return null;
    const st = await this.lstatTarget(resolved.target);
    if (st && !st.isFile() && !st.isSymbolicLink()) return null; // 目录/非常规对象不可当库
    return resolved.target;
  }

  /** 迁移等场景显式置只读(读写闸见 requireWritable)。 */
  setReadonly(reason: string): void {
    this.readonlyReason = reason;
  }

  clearReadonly(): void {
    this.readonlyReason = null;
  }

  /**
   * 用量对账(全量重扫 + 重写账本 + 保险丝复核)。open 时自动做一次;
   * 设置页/清理流程可显式调用(例如用户手工清理大目录之后)。
   */
  async reconcileUsage(): Promise<LibraryResult<{ files: number; bytes: number; tripped: boolean }>> {
    return this.runSerialized(async () => {
      const scanned = await this.scanUsageUnlocked();
      this.usageTripped = scanned.tripped;
      this.usage = { files: scanned.files, bytes: scanned.bytes, updatedAt: this.now(), mutations: 0 };
      await this.persistUsageUnlocked();
      return { ok: true as const, files: scanned.files, bytes: scanned.bytes, tripped: scanned.tripped };
    });
  }

  /** owner 切换/宿主收口:作废在途流并拒绝后续操作(实例弃用,不可重开)。 */
  async invalidate(): Promise<void> {
    await this.runSerialized(async () => {
      for (const stream of Array.from(this.streams.values())) {
        await this.abortStreamUnlocked(stream.streamId).catch(() => {});
      }
    });
    this.invalidated = true;
    this.state = 'unavailable';
    this.unavailableReason = 'io';
  }
}

/**
 * 默认卷余量探测:优先 fs.statfs(Node ≥ 18.15 / Electron 新版),不可用
 * 返回 null(上层跳过写前硬闸,依赖 ENOSPC 兜底)。独立导出便于测试注入。
 */
export async function statfsFreeBytes(root: string): Promise<number | null> {
  const statfs = (fs.promises as unknown as { statfs?: (p: string) => Promise<{ bsize: number; bavail: number }> }).statfs;
  if (typeof statfs !== 'function') return null;
  try {
    const st = await statfs(root);
    return st.bsize * st.bavail;
  } catch {
    return null;
  }
}
