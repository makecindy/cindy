/**
 * Workdir File Browser — single-layer directory scanner + file reader.
 *
 * Why single-layer (not recursive):
 *   Real Unity workdir benchmark: full recursive scan with builtin ignore
 *   = 4 seconds / 698k entries (unacceptable IPC payload + render cost).
 *   Per-folder readdir = 0.1-12 ms (the worst folder under test was
 *   `EntityScriptDatas/` with 17k entries → still 12 ms). So lazy expansion
 *   is the only viable strategy at this scale.
 *
 * All paths in the public API are workdir-relative POSIX strings; absolute
 * paths never leave this module. Path traversal is blocked via
 * `assertInsideWorkdir` — renderer cannot ask for `../../etc/passwd`.
 */

import { promises as fs, constants as fsConstants, type Stats, type Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { scopedLogger } from './logging.js';
import { loadIgnoreMatcher, type Matcher } from './ignore.js';

const log = scopedLogger('file-browser/scanner');

/** Hard cap on file size we'll send to the renderer. Anything larger gets
 *  truncated; renderer shows a "file truncated, open in OS to see more"
 *  banner. 2 MiB is enough for any realistic markdown/code file. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** PDF 文件头。规范允许其前面有少量垃圾字节,pdf.js 也只在前 1 KiB 内找它,这里同口径。 */
const PDF_SIGNATURE = Buffer.from('%PDF-', 'latin1');
const PDF_SIGNATURE_WINDOW = 1024;

/**
 * 文本读取 / 覆写前的二进制判定,readFile 与 writeFile 共用:
 *   - 前 4 KiB 含 NUL → PNG/FBX/DLL 等常见二进制;
 *   - `.pdf` 文件前 1 KiB 内出现 `%PDF-` → PDF。合法 PDF 不一定含 NUL(对象流未压缩、
 *     纯 ASCII 时整份文件都可能没有 NUL),只靠 NUL 探测会把它当 UTF-8 文本交给渲染层,
 *     显示成 `%PDF-1.4 ... obj ... stream` 原始语法(issue #4158)。判成二进制后渲染层按
 *     扩展名走既有 PdfPreview 分支。
 *     文件头判定只对 `.pdf` 扩展名生效:渲染层的 PDF 预览本来就以扩展名为准,其他扩展名
 *     判成二进制只会得到不可渲染占位、还会让编辑器拒绝保存;而 markdown / 日志 / 源码
 *     在开头引用 `%PDF-` 很常见,不能误伤。
 */
function isBinaryProbe(probe: Buffer, relPath: string): boolean {
  if (probe.includes(0)) return true;
  if (!hasPdfExtension(relPath)) return false;
  return probe.subarray(0, PDF_SIGNATURE_WINDOW).includes(PDF_SIGNATURE);
}

function hasPdfExtension(relPath: string): boolean {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && name.slice(dot).toLowerCase() === '.pdf';
}

/**
 * 原子写中间产物的后缀。writeFile 把内容先落到 `${target}.xdt-tmp`,fsync 后
 * rename 成正式名。这个临时文件理论上只活一两毫秒,但在边栏 listDir 路径上仍
 * 可能被瞥见 → 一闪而过的 ghost row,视觉上像"刷一下"。
 *
 * 因此 listDir 输出和 watcher 事件都要把它过滤掉,让它对前端完全不可见。
 * 见 watcher.ts 里同步定义。
 */
export const XDT_TMP_SUFFIX = '.xdt-tmp';

export interface DirEntry {
  /** filename only, no path */
  name: string;
  /** workdir-relative POSIX path */
  relPath: string;
  type: 'file' | 'directory';
  /** file size in bytes (only for files; directories report 0) */
  size: number;
  /** ms since epoch */
  mtimeMs: number;
}

export interface FileReadResult {
  relPath: string;
  /** UTF-8 contents (truncated to MAX_FILE_BYTES) */
  content: string;
  /** Total file size in bytes (may be larger than content.length for truncated reads) */
  size: number;
  mtimeMs: number;
  truncated: boolean;
}

export interface FileStat {
  relPath: string;
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
}

/**
 * Workdir-relative POSIX path normalization. Accepts either '' / '.' / 'a/b'
 * for a path inside the workdir; throws on absolute or traversal attempts.
 */
function assertInsideWorkdir(workdir: string, relPath: string): string {
  // Normalize and reject anything that escapes the workdir. We resolve to
  // absolute and verify the resolved path starts with workdir + sep.
  // Reject anything absolute on ANY host OS, checked on the raw input so the
  // guard is host-independent (this browser runs on macOS/Windows/Linux):
  //  - path.posix.isAbsolute → POSIX absolute "/etc/passwd";
  //  - path.win32.isAbsolute → "\x", UNC "\\srv\share", drive-absolute "C:\x"/"C:/x";
  //  - /^[a-zA-Z]:/          → drive-*relative* "C:foo"/"C:", which win32.isAbsolute
  //    misses yet path.resolve on Windows reinterprets against drive C:'s current
  //    directory (NOT as a workdir entry literally named "C:foo"). A ":"-carrying
  //    drive token is Windows path syntax and cannot be a workdir-relative POSIX
  //    name cross-platform, so reject it rather than silently mis-resolving it.
  if (
    path.posix.isAbsolute(relPath) ||
    path.win32.isAbsolute(relPath) ||
    /^[a-zA-Z]:/.test(relPath)
  ) {
    throw new Error(`absolute path not allowed: ${relPath}`);
  }
  // What remains is a workdir-relative path: normalize separators and strip a
  // leading "./". Traversal ("../…") is caught by the containment check below.
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (cleaned === '' || cleaned === '.') return '';
  const abs = path.resolve(workdir, cleaned);
  const wdAbs = path.resolve(workdir);
  if (abs !== wdAbs && !abs.startsWith(wdAbs + path.sep)) {
    throw new Error(`path escapes workdir: ${relPath}`);
  }
  return cleaned;
}

async function assertRealPathInsideWorkdir(
  workdir: string,
  absPath: string,
): Promise<string> {
  const [wdReal, targetReal] = await Promise.all([
    fs.realpath(workdir),
    fs.realpath(absPath),
  ]);
  if (targetReal !== wdReal && !targetReal.startsWith(wdReal + path.sep)) {
    throw new Error(`path escapes workdir via symlink: ${path.relative(workdir, absPath)}`);
  }
  return targetReal;
}

async function assertRealParentInsideWorkdir(
  workdir: string,
  absPath: string,
): Promise<void> {
  const [wdReal, parentReal] = await Promise.all([
    fs.realpath(workdir),
    fs.realpath(path.dirname(absPath)),
  ]);
  if (parentReal !== wdReal && !parentReal.startsWith(wdReal + path.sep)) {
    throw new Error(`path escapes workdir via symlink: ${path.relative(workdir, absPath)}`);
  }
}

export interface ListDirOptions {
  /**
   * "Doc mode": only show doc/config text files (see DOC_MODE_EXTS); only
   * show directories that have at least one such file as a descendant.
   * The recursive descendant check applies the same ignore matcher and
   * short-circuits on first hit.
   */
  docMode?: boolean;
}

/**
 * Allowed file extensions in doc mode. Intentionally excludes code (.ts /
 * .py / .css / ...) and `.env` (secret-prone). Add new entries here when a
 * user calls out a missing file type — keeping the list small avoids the
 * "everything is a doc" drift that defeats the point of doc mode.
 */
const DOC_MODE_EXTS = new Set([
  'md',
  'txt',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'xml',
  'csv',
]);

function isDocModeFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return false;
  return DOC_MODE_EXTS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Cheap recursive probe: does this directory contain at least one
 * doc-mode-visible file as a descendant (under the same matcher)?
 * Short-circuits on first hit. Used by listDir's docMode to decide
 * whether to surface a subdir.
 *
 * Implementation:
 *   - Sibling subdirs are walked in parallel (Promise.all over the level)
 *     so a top-level dir like apps/desktop/ doesn't serialize 50 subwalks.
 *   - Overlapping probes share only the in-flight `readdir` for each absolute
 *     directory. Traversals keep their own `Found` cell, preserving sibling
 *     short-circuiting without allowing one probe's result to contaminate
 *     another; completed directory reads are never cached.
 *
 * Worst case (deep subtree with no matching file): walks the whole subtree
 * once, but in parallel. BUILTIN_IGNORE prunes node_modules / Library /
 * etc., which are the only realistic huge subtrees.
 */
type Found = { v: boolean };

/** In-flight-only sharing for overlapping doc-mode directory reads. */
const docDirentsInFlight = new Map<string, Promise<Dirent[]>>();

function readDocDirents(abs: string): Promise<Dirent[]> {
  const key = path.resolve(abs);
  const current = docDirentsInFlight.get(key);
  if (current) return current;

  const read = fs.readdir(abs, { withFileTypes: true });
  docDirentsInFlight.set(key, read);
  void read.then(
    () => {
      if (docDirentsInFlight.get(key) === read) docDirentsInFlight.delete(key);
    },
    () => {
      if (docDirentsInFlight.get(key) === read) docDirentsInFlight.delete(key);
    },
  );
  return read;
}

async function hasDocDescendantInner(
  abs: string,
  relPath: string,
  matcher: Matcher,
  found: Found,
): Promise<boolean> {
  if (found.v) return true;
  let dirents: Dirent[];
  try {
    dirents = await readDocDirents(abs);
  } catch {
    return false;
  }
  if (found.v) return true;
  // Pass 1: own files (cheaper than recursing).
  const subdirs: { name: string; childRel: string }[] = [];
  for (const d of dirents) {
    const childRel = relPath === '' ? d.name : `${relPath}/${d.name}`;
    const isDir = d.isDirectory();
    if (matcher.ignores(childRel, isDir)) continue;
    if (d.isSymbolicLink()) continue;
    if (isDir) {
      subdirs.push({ name: d.name, childRel });
    } else if (isDocModeFile(d.name)) {
      found.v = true;
      return true;
    }
  }
  if (subdirs.length === 0 || found.v) return found.v;
  // Pass 2: recurse all subdirs in parallel. Each traversal keeps the same
  // `Found` cell, so a fast hit stops deeper work in sibling branches.
  const results = await Promise.all(
    subdirs.map((s) =>
      hasDocDescendantInner(path.join(abs, s.name), s.childRel, matcher, found),
    ),
  );
  return results.some(Boolean);
}

async function hasDocDescendant(
  abs: string,
  relPath: string,
  matcher: Matcher,
): Promise<boolean> {
  return hasDocDescendantInner(abs, relPath, matcher, { v: false });
}

/**
 * List entries of one directory (single-layer, no recursion). Filtered
 * through the workdir's ignore matcher. Sort: directories before files,
 * each group case-insensitive lexicographic — same convention as VSCode
 * Explorer / Obsidian.
 */
export async function listDir(
  workdir: string,
  relPath: string,
  matcher: Matcher,
  opts: ListDirOptions = {},
): Promise<DirEntry[]> {
  const sub = assertInsideWorkdir(workdir, relPath);
  const abs = sub === '' ? workdir : path.join(workdir, sub);
  // In doc mode this top-level read participates in the same in-flight map as
  // recursive descendant probes. An overlapping `listDir('src')` can thus
  // reuse the read already started while listing the root, without retaining
  // a completed snapshot.
  const dirents = opts.docMode
    ? await readDocDirents(abs)
    : await fs.readdir(abs, { withFileTypes: true });

  // Process all entries in parallel. With docMode on, each surviving subdir
  // triggers a recursive hasDocDescendant probe — running siblings in
  // parallel turns a (#subdirs × per-subdir-walk) wall-clock cost into one
  // bounded by the slowest subtree. lstat + readdir all overlap.
  const candidates = await Promise.all(
    dirents.map(async (d): Promise<DirEntry | null> => {
      const childRel = sub === '' ? d.name : `${sub}/${d.name}`;
      const isDir = d.isDirectory();
      if (matcher.ignores(childRel, isDir)) return null;
      // 原子写中间产物 — 隐藏不让前端看到一闪而过的临时行。
      if (!isDir && d.name.endsWith(XDT_TMP_SUFFIX)) return null;
      // We need stats for size + mtime; use lstat to avoid following symlinks
      // into Library/ et al. (some Unity setups symlink huge caches in).
      let st: Stats;
      try {
        st = await fs.lstat(path.join(abs, d.name));
      } catch {
        // Permission denied or removed mid-scan — skip silently.
        return null;
      }
      // Skip symlinks unless they point inside the workdir; cheaper to just
      // skip than to chase them. User can open via OS if needed.
      if (st.isSymbolicLink()) return null;
      if (opts.docMode) {
        if (isDir) {
          if (!(await hasDocDescendant(path.join(abs, d.name), childRel, matcher))) {
            return null;
          }
        } else if (!isDocModeFile(d.name)) {
          return null;
        }
      }
      return {
        name: d.name,
        relPath: childRel,
        type: isDir ? 'directory' : 'file',
        size: isDir ? 0 : st.size,
        mtimeMs: st.mtimeMs,
      };
    }),
  );
  const out: DirEntry[] = candidates.filter((e): e is DirEntry => e !== null);

  // dirs first (case-insensitive a-z), then files (same)
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase());
  });

  return out;
}

/**
 * Read one file, capped at MAX_FILE_BYTES. Returns UTF-8 string + truncation
 * flag. Binary files (NULL byte in first 4KB, or a `.pdf` with a PDF header)
 * raise an error so the renderer can render the placeholder / PDF preview instead.
 */
export async function readFile(
  workdir: string,
  relPath: string,
): Promise<FileReadResult> {
  const sub = assertInsideWorkdir(workdir, relPath);
  if (sub === '') throw new Error('cannot read workdir root as file');
  const abs = path.join(workdir, sub);
  const realAbs = await assertRealPathInsideWorkdir(workdir, abs);
  const st = await fs.stat(realAbs);
  if (st.isDirectory()) throw new Error(`is a directory: ${relPath}`);

  const truncated = st.size > MAX_FILE_BYTES;
  const handle = await fs.open(realAbs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_FILE_BYTES));
    if (buf.length > 0) {
      await handle.read(buf, 0, buf.length, 0);
    }
    // Quick binary detection: NULL byte in first 4 KiB (PNG/FBX/DLL etc.) or a
    // PDF header in a `.pdf` file (see isBinaryProbe). UTF-16 text files contain
    // NULL bytes too but are rare in dev workflows; renderer can still fall back
    // to "open in OS" if needed.
    const probe = buf.subarray(0, Math.min(buf.length, 4096));
    if (isBinaryProbe(probe, sub)) {
      const err = new Error(`binary file: ${relPath}`);
      (err as Error & { code?: string }).code = 'BINARY_FILE';
      throw err;
    }
    return {
      relPath: sub,
      content: buf.toString('utf8'),
      size: st.size,
      mtimeMs: st.mtimeMs,
      truncated,
    };
  } finally {
    await handle.close();
  }
}

export interface FileChunkResult {
  /** 原始字节片(caller 自行编码,daemon 转 base64 进 JSON)。 */
  data: Buffer;
  /** offset + data.length ≥ 文件大小,即已是最后一片。 */
  eof: boolean;
  size: number;
  mtimeMs: number;
}

/** 单片长度上限:base64 后 ~1.37MB,远低于 NDJSON 解码缓冲,也不挤占 relay 帧。 */
export const FILE_CHUNK_MAX_LENGTH = 1024 * 1024;

/**
 * 大文件分片读:按 [offset, offset+length) 返回原始字节。与 readFile 不同,
 * 不做 2MiB 截断、不做二进制检测——它服务"任意大小文件完整拉回本地缓存"的
 * 传输管线,内容判定由消费端做。路径安全与 readFile 完全同源。
 */
export async function readFileChunk(
  workdir: string,
  relPath: string,
  offset: number,
  length: number,
): Promise<FileChunkResult> {
  const sub = assertInsideWorkdir(workdir, relPath);
  if (sub === '') throw new Error('cannot read workdir root as file');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`bad offset: ${offset}`);
  const len = Math.max(0, Math.min(length, FILE_CHUNK_MAX_LENGTH));
  const abs = path.join(workdir, sub);
  const realAbs = await assertRealPathInsideWorkdir(workdir, abs);
  const st = await fs.stat(realAbs);
  if (st.isDirectory()) throw new Error(`is a directory: ${relPath}`);

  const readLen = Math.max(0, Math.min(len, st.size - offset));
  const handle = await fs.open(realAbs, 'r');
  try {
    // fs.read 可能短读(bytesRead < 请求长度),必须循环读满;否则未填充的
    // 尾部以 0x00 混进结果,消费端(SSH 大文件取回)会把补零字节写进缓存
    // 副本并把 offset 推进过真实数据 —— 内容静默损坏。
    const buf = Buffer.alloc(readLen);
    let filled = 0;
    while (filled < readLen) {
      const { bytesRead } = await handle.read(buf, filled, readLen - filled, offset + filled);
      if (bytesRead === 0) break; // 真 EOF(文件被并发截断):按实际读到的返回
      filled += bytesRead;
    }
    return {
      data: filled === readLen ? buf : buf.subarray(0, filled),
      eof: offset + filled >= st.size,
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Atomically write text content to a file inside workdir. Pattern: write to
 * `${target}.xdt-tmp`, fsync handle, rename → target. Crash-safe (consumer
 * either sees old content or new, never partial).
 *
 * Constraints:
 *   - Path traversal blocked via assertInsideWorkdir.
 *   - File must already exist — this API is for editing previewed files,
 *     not creating new ones (no "save as" semantics in the file-browser).
 *   - Refuses files >MAX_FILE_BYTES on disk (the read path truncates large
 *     files; saving back would silently lose data).
 *   - Refuses content >MAX_FILE_BYTES (defense against giant paste).
 *   - Refuses binary files (NULL byte in first 4KB, or a `.pdf` with a PDF
 *     header) — same probe as readFile, so the editor never opens binaries.
 */
export async function writeFile(
  workdir: string,
  relPath: string,
  content: string,
): Promise<{ size: number; mtimeMs: number }> {
  const sub = assertInsideWorkdir(workdir, relPath);
  if (sub === '') throw new Error('cannot write workdir root');
  const abs = path.join(workdir, sub);
  const realAbs = await assertRealPathInsideWorkdir(workdir, abs);

  // File must exist. Editing-a-file-that-was-just-deleted is a corner case
  // we surface as an error instead of silently re-creating.
  const st = await fs.stat(realAbs);
  if (st.isDirectory()) throw new Error(`is a directory: ${relPath}`);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`file too large to edit (>${MAX_FILE_BYTES} bytes): ${relPath}`);
  }

  const buf = Buffer.from(content, 'utf8');
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`content too large (>${MAX_FILE_BYTES} bytes)`);
  }

  // Defense in depth: re-probe binary signature on the on-disk version.
  // (User shouldn't be able to open & edit a binary anyway, but if some
  // upstream check is bypassed, we don't want to overwrite a .png with
  // textual JSON.)
  const probeHandle = await fs.open(realAbs, 'r');
  try {
    const probe = Buffer.alloc(Math.min(st.size, 4096));
    if (probe.length > 0) await probeHandle.read(probe, 0, probe.length, 0);
    if (isBinaryProbe(probe, sub)) {
      throw new Error(`binary file: ${relPath}`);
    }
  } finally {
    await probeHandle.close();
  }

  const tmp = `${realAbs}${XDT_TMP_SUFFIX}`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(buf);
    await handle.sync();
  } finally {
    await handle.close();
  }
  // rename is atomic on same filesystem (which .xdt-tmp guarantees since
  // we wrote it in the same directory).
  await fs.rename(tmp, realAbs);

  const after = await fs.stat(realAbs);
  return { size: after.size, mtimeMs: after.mtimeMs };
}

/**
 * Create an empty file inside workdir. Refuses if anything already exists at
 * the target path (file/dir/symlink). Parent dir must already exist — caller
 * is the file-tree, parent is always a known visible folder. Returns the
 * stat of the created file.
 */
export async function createFile(
  workdir: string,
  relPath: string,
): Promise<FileStat> {
  const sub = assertInsideWorkdir(workdir, relPath);
  if (sub === '') throw new Error('cannot create at workdir root');
  const abs = path.join(workdir, sub);
  await assertRealParentInsideWorkdir(workdir, abs);
  // 'wx' = create, fail if exists. Doesn't create parent dirs.
  const handle = await fs.open(abs, 'wx');
  await handle.close();
  const st = await fs.stat(abs);
  return { relPath: sub, type: 'file', size: st.size, mtimeMs: st.mtimeMs };
}

/**
 * Create a new file inside workdir and write its full content in one exclusive
 * step. `wx` (O_CREAT|O_EXCL) fails when anything already exists at the target,
 * including a symlink, and never follows a final-component link, so a watcher
 * cannot swap the path between "create" and "write" (the TOCTOU that a
 * createFile → writeFile pair leaves open). Parent dir must already exist and
 * must resolve inside workdir. Refuses content >MAX_FILE_BYTES like writeFile.
 */
export interface NewFileIdentity {
  size: number;
  mtimeMs: number;
  /** Inode identity of the published file; lets the caller verify or delete only this file. */
  /** Decimal strings: Windows file IDs are 64-bit and lose low bits as JS numbers. */
  dev: string;
  ino: string;
  /**
   * Daemon-side descriptor capability (present when a hold registry was supplied): lets
   * `eraseIfSame` zero exactly this inode without a pathname; closed by `releaseNewFile`
   * or after the registry's TTL.
   */
  holdId?: string;
  /** writeNewFile only: whether the staging removal reached disk (false = withdraw via the hold). */
  durable?: boolean;
}

/** Identity from bigint stats, serialised without precision loss. */
export function identityOf(st: { dev: bigint; ino: bigint }): { dev: string; ino: string } {
  return { dev: st.dev.toString(), ino: st.ino.toString() };
}
export function sameIdentity(st: { dev: bigint; ino: bigint }, dev: string, ino: string): boolean {
  return st.dev.toString() === dev && st.ino.toString() === ino;
}

/**
 * Make a directory entry change (link / mkdir) durable: fsync the directory itself.
 * Byte durability of a file (`handle.sync()`) says nothing about whether its name survives
 * a crash; that needs the parent directory synced. Platforms that cannot fsync a directory
 * handle (Windows) report EPERM/EINVAL/EISDIR/ENOTSUP/EBADF and are skipped; a real I/O
 * error (EIO etc.) propagates so the caller does not report a durable publish.
 */
async function syncDirectory(dirPath: string): Promise<void> {
  let dir: FileHandle;
  try {
    dir = await fs.open(dirPath, 'r');
  } catch (err) {
    if (DIR_SYNC_UNSUPPORTED.has((err as NodeJS.ErrnoException)?.code ?? '')) return;
    throw err;
  }
  try {
    await dir.sync();
  } catch (err) {
    if (!DIR_SYNC_UNSUPPORTED.has((err as NodeJS.ErrnoException)?.code ?? '')) throw err;
  } finally {
    await dir.close().catch(() => undefined);
  }
}
const DIR_SYNC_UNSUPPORTED = new Set(['EPERM', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EACCES']);

export async function writeNewFile(
  workdir: string,
  relPath: string,
  content: string,
  holds?: NewFileHoldRegistry,
): Promise<NewFileIdentity & { durable: boolean }> {
  const sub = assertInsideWorkdir(workdir, relPath);
  if (sub === '') throw new Error('cannot write workdir root');
  const abs = path.join(workdir, sub);
  await assertRealParentInsideWorkdir(workdir, abs);
  const buf = Buffer.from(content, 'utf8');
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`content too large (>${MAX_FILE_BYTES} bytes)`);
  }
  // Root-staged publish. Node has no openat / root-anchored write, so instead of
  // writing through a path whose parent a workdir-level watcher could swap for a
  // symlink or move away mid-write, the bytes are written to a private (0600,
  // exclusive) staging file directly under the workdir root — a parent that content
  // inside the workdir cannot relocate — and only then published to the target with
  // `link` (atomic; EEXIST keeps the `wx` semantics; never overwrites). After the
  // publish the target is anchored: the entry of that name inside the re-resolved
  // real parent must be our inode and that parent must still be inside workdir. If
  // the parent was swapped in the tiny link→check interval, the published entry is
  // unlinked (only if it is still our inode) and the content is zeroed through the
  // handle. No private byte is ever written through a swappable path.
  const wdReal = await fs.realpath(workdir);
  // Cross-device (round 29): `link` / `rename` cannot cross filesystems. When the output
  // directory is a nested mount, staging at the workdir root would fail with EXDEV, so the
  // staging inode is placed on the *target's* filesystem instead (inside the verified
  // parent). The inode capability is the daemon-held descriptor (see the hold registry),
  // which is independent of where the staging name lived.
  const parentReal = await fs.realpath(path.dirname(abs));
  const [wdStat, parentStat] = await Promise.all([
    fs.lstat(wdReal, { bigint: true }),
    fs.lstat(parentReal, { bigint: true }),
  ]);
  const stagingDir = chooseStagingDir(wdStat.dev, wdReal, parentStat.dev, parentReal);
  const stagingAbs = path.join(stagingDir, `.${path.basename(abs)}.${randomUUID()}.staging`);
  const handle = await fs.open(stagingAbs, 'wx', 0o600);
  let published = false;
  const escape = () => new Error(`path escapes workdir via symlink: ${sub}`);
  const isOurs = async (candidate: string): Promise<boolean> => {
    const [own, current] = await Promise.all([
      handle.stat({ bigint: true }).catch(() => null),
      fs.lstat(candidate, { bigint: true }).catch(() => null),
    ]);
    return !!own && !!current && current.isFile() && current.ino === own.ino && current.dev === own.dev;
  };
  try {
    await handle.writeFile(buf);
    // Durability before publication: a host that loses power right after the RPC
    // succeeded must not come back with an empty or partial published file.
    await handle.sync();
    // Publish: parent is re-validated right before, then link (never follows a final
    // symlink at `abs`; an existing entry of any kind fails with EEXIST).
    await assertRealParentInsideWorkdir(workdir, abs);
    await fs.link(stagingAbs, abs);
    published = true;
    const parentReal = await fs.realpath(path.dirname(abs)).catch(() => null);
    if (
      !parentReal ||
      (parentReal !== wdReal && !parentReal.startsWith(wdReal + path.sep)) ||
      !(await isOurs(path.join(parentReal, path.basename(abs))))
    ) {
      throw escape();
    }
    // Name durability: the link above is a directory-entry change; without syncing the
    // parent directory a crash right after "success" could bring the host back with the
    // bytes durable but the advertised path gone.
    await syncDirectory(parentReal);
    // The directory sync was another await: re-anchor after it. The parent must still
    // resolve inside workdir and the entry of that name must still be our inode.
    const parentAfterSync = await fs.realpath(path.dirname(abs)).catch(() => null);
    if (
      !parentAfterSync ||
      (parentAfterSync !== wdReal && !parentAfterSync.startsWith(wdReal + path.sep)) ||
      !(await isOurs(path.join(parentAfterSync, path.basename(abs))))
    ) {
      throw escape();
    }
    // The staging entry is a second hard link to the private content. Its removal is part
    // of a successful publish (not best-effort); it is also the server-side completion
    // marker verifyNewFile keys on: while `.<name>.<uuid>.staging` exists, the write is
    // still in flight and may yet be withdrawn.
    // The name is unlinked only if it still carries our inode: a workdir process may have
    // renamed the staging link away (an untracked private copy) and put an unrelated file
    // at that name. Then the publish is withdrawn (the handle zeroes the moved copy too).
    const stagingEntry = await fs.lstat(stagingAbs, { bigint: true }).catch(() => null);
    if (stagingEntry) {
      const own = await handle.stat({ bigint: true });
      if (!stagingEntry.isFile() || stagingEntry.dev !== own.dev || stagingEntry.ino !== own.ino) {
        throw new Error(`staging link was replaced or moved: ${sub}`);
      }
      await fs.unlink(stagingAbs);
      // Close the lstat→unlink gap after the fact: our link count must have dropped by one,
      // otherwise the name was swapped in between and our link still exists elsewhere.
      const after = await handle.stat({ bigint: true });
      if (after.nlink !== own.nlink - 1n) throw new Error(`staging link was replaced or moved: ${sub}`);
    }
    // Whether the staging name was removed by us or is already absent (a bare rename by a
    // workdir process), the inode must now be reachable through the published target only.
    // Any extra link is a private copy outside the ledger lifecycle: withdraw and zero.
    const links = await handle.stat({ bigint: true });
    if (links.nlink !== 1n) throw new Error(`staging link was replaced or moved: ${sub}`);
  } catch (err) {
    // Fail closed without leaving content anywhere: zero through the handle (follows the
    // inode wherever a directory went). The pathnames (published entry, staging link) are
    // left alone: a check-then-unlink on a mutable path can delete an unrelated entry that
    // a workdir process placed there in between, and the content is already gone. Empty
    // names are the conservative residue; a leftover staging name also keeps verifyNewFile
    // from ever accepting this withdrawn publish.
    await handle.truncate(0).catch(() => undefined);
    await handle.close().catch(() => undefined);
    throw err;
  }
  // Past this point the publish is complete and is never withdrawn *by this call* (a recovery
  // caller may already have accepted it): make the staging removal durable, retrying once.
  // A persistent fsync failure is reported as `durable: false` rather than swallowed (round
  // 30): the caller that receives this response is the only party that accepted the publish
  // and still holds the inode capability below, so it can withdraw through the hold. A crash
  // before the removal reached disk would otherwise bring the hidden hard link back with the
  // full private content outside the ledger lifecycle.
  let durable = true;
  try {
    await syncDirectory(stagingDir);
  } catch {
    durable = await syncDirectory(stagingDir).then(() => true, () => false);
  }
  const st = await handle.stat({ bigint: true });
  const identity = { size: Number(st.size), mtimeMs: Number(st.mtimeMs), ...identityOf(st), durable };
  if (!holds) {
    await handle.close();
    return identity;
  }
  // Inode-bound capability (round 29/30): the daemon keeps the writer's own descriptor open
  // for the caller's bookkeeping window. `eraseIfSame` with this hold zeroes the content
  // through the descriptor wherever the directory went; `releaseNewFile` closes it. Nothing
  // is ever deleted by pathname after the fact — no marker, no finalize unlink.
  return { ...identity, holdId: holds.register(handle, st) };
}

/**
 * Where the private staging inode goes: the workdir root (a parent that content inside the
 * workdir cannot relocate) whenever the target directory is on the same filesystem, else
 * the target's own directory — hard links and renames never cross devices (EXDEV).
 */
export function chooseStagingDir(rootDev: bigint, rootDir: string, parentDev: bigint, parentDir: string): string {
  return rootDev === parentDev ? rootDir : parentDir;
}

export interface NewFileHold { handle: FileHandle; dev: bigint; ino: bigint }

/**
 * Open descriptors of freshly published files, kept for the caller's bookkeeping window so
 * that a withdrawal can target the inode itself instead of a mutable pathname. Bounded in
 * count and lifetime: an abandoned hold (client gone) is closed after `ttlMs`, which leaves
 * the published file exactly as a plain `writeNewFile` would have.
 */
export class NewFileHoldRegistry {
  private readonly holds = new Map<string, NewFileHold & { timer: NodeJS.Timeout }>();
  constructor(private readonly opts: { ttlMs?: number; max?: number } = {}) {}

  register(handle: FileHandle, st: { dev: bigint; ino: bigint }): string {
    const max = this.opts.max ?? 64;
    while (this.holds.size >= max) {
      const oldest = this.holds.keys().next().value;
      if (oldest === undefined) break;
      void this.release(oldest);
    }
    const id = randomUUID();
    const timer = setTimeout(() => { void this.release(id); }, this.opts.ttlMs ?? 120_000);
    timer.unref?.();
    this.holds.set(id, { handle, dev: st.dev, ino: st.ino, timer });
    return id;
  }

  get(id: string): NewFileHold | null {
    const hold = this.holds.get(id);
    return hold ? { handle: hold.handle, dev: hold.dev, ino: hold.ino } : null;
  }

  async release(id: string): Promise<boolean> {
    const hold = this.holds.get(id);
    if (!hold) return false;
    this.holds.delete(id);
    clearTimeout(hold.timer);
    await hold.handle.close().catch(() => undefined);
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.holds.keys()].map((id) => this.release(id)));
  }

  get size(): number {
    return this.holds.size;
  }
}

/** Second phase of `writeNewFile` / `verifyNewFile`: drop the daemon-side descriptor. */
export async function releaseNewFile(holds: NewFileHoldRegistry, holdId: string): Promise<{ released: boolean }> {
  return { released: await holds.release(holdId) };
}

/**
 * True while a writeNewFile staging link for `name` still exists in one of the directories
 * a write may have staged in (the workdir root; the target's own directory for
 * cross-device targets). A scan failure is not "no marker": it propagates so the caller
 * retries instead of accepting a publish the original writer may still withdraw.
 */
async function hasStagingSibling(dirs: string[], name: string): Promise<boolean> {
  const prefix = `.${name}.`;
  for (const dir of [...new Set(dirs)]) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      throw new Error(`cannot scan completion marker: ${(err as NodeJS.ErrnoException)?.code ?? 'unknown'}`);
    }
    if (entries.some((entry) => entry.startsWith(prefix) && entry.endsWith('.staging'))) return true;
  }
  return false;
}

/**
 * Prove that the entry at `relPath` is the regular file this host wrote: not a symlink,
 * parent still inside workdir, exact size and SHA-256 of the content. Used after a lost
 * `writeNewFile` response, where size/mtime alone can be spoofed by a workdir-level
 * process. Returns the inode identity so a later cleanup can target only this file; with a
 * hold registry the verified descriptor is retained as the caller's inode capability.
 */
export async function verifyNewFile(
  workdir: string,
  relPath: string,
  expectedSha256: string,
  expectedSize: number,
  holds?: NewFileHoldRegistry,
): Promise<NewFileIdentity> {
  const sub = assertInsideWorkdir(workdir, relPath);
  if (sub === '') throw new Error('cannot verify workdir root');
  const abs = path.join(workdir, sub);
  await assertRealParentInsideWorkdir(workdir, abs);
  const entry = await fs.lstat(abs, { bigint: true });
  if (!entry.isFile()) throw new Error(`not a regular file: ${sub}`);
  if (Number(entry.size) !== expectedSize) throw new Error(`size mismatch: ${sub}`);
  // Never follow a final symlink (a link to the renamed original must not pass). Read/write
  // so the retained descriptor can later zero the content.
  const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const handle = await fs.open(abs, fsConstants.O_RDWR | O_NOFOLLOW);
  let retained = false;
  try {
    const opened = await handle.stat({ bigint: true });
    // The opened inode must be the very entry lstat saw (no swap in between).
    if (opened.dev !== entry.dev || opened.ino !== entry.ino) throw new Error(`identity mismatch: ${sub}`);
    // A finished publish has exactly one link (the target). A second link means either
    // the writer is still in flight (its staging link) or the staging link was renamed
    // away — in both cases the writer may still withdraw (zero) this inode, so recovery
    // must not accept it. This holds even when the staging marker name is gone.
    if (opened.nlink !== 1n) throw new Error(`write still in flight: ${sub}`);
    const buf = await handle.readFile();
    if (buf.length !== expectedSize) throw new Error(`size mismatch: ${sub}`);
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== expectedSha256) throw new Error(`content mismatch: ${sub}`);
    // Server-side completion: a matching published file is not enough while its staging
    // link still exists — the original writeNewFile may still withdraw the publish on a
    // later failure. Only after the staging link is gone is the publish final.
    const wdReal = await fs.realpath(workdir);
    if (await hasStagingSibling([wdReal, await fs.realpath(path.dirname(abs))], path.basename(abs))) {
      throw new Error(`write still in flight: ${sub}`);
    }
    // Reading was an await: the pathname must still name the inode whose content was
    // hashed, and its parent must still be inside workdir, or the recovery is void.
    await assertRealParentInsideWorkdir(workdir, abs);
    const after = await fs.lstat(abs, { bigint: true }).catch(() => null);
    if (!after || !after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error(`identity mismatch after read: ${sub}`);
    }
    const identity = { size: Number(opened.size), mtimeMs: Number(opened.mtimeMs), ...identityOf(opened) };
    if (!holds) return identity;
    retained = true;
    return { ...identity, holdId: holds.register(handle, opened) };
  } finally {
    if (!retained) await handle.close();
  }
}

/**
 * Erase the private content at `relPath` only if it is still the regular file with the given
 * inode identity — and leave the pathname alone.
 *
 * POSIX has no "unlink by inode" primitive: any pathname unlink after a check is a TOCTOU
 * that can delete an unrelated entry placed at that name in between. The sensitive part is
 * the content, and that can be handled without the race: open with O_NOFOLLOW, fstat must
 * match dev/ino, truncate through that descriptor (bound to the inode, not to the pathname).
 * A zero-byte name may remain; that is the conservative outcome. Returns whether our inode
 * was erased.
 *
 * With a hold (the descriptor retained by writeNewFile / verifyNewFile) the erase goes
 * through that descriptor and needs no pathname at all — the directory may have been moved
 * out of workdir since. The hold is released afterwards.
 */
export async function eraseIfSame(
  workdir: string,
  relPath: string,
  dev: string,
  ino: string,
  holds?: NewFileHoldRegistry,
  holdId?: string,
): Promise<{ erased: boolean }> {
  const sub = assertInsideWorkdir(workdir, relPath);
  if (sub === '') throw new Error('cannot delete workdir root');
  if (holdId !== undefined && holds) {
    const hold = holds.get(holdId);
    if (hold && sameIdentity(hold, dev, ino)) {
      try {
        await hold.handle.truncate(0);
        return { erased: true };
      } finally {
        await holds.release(holdId);
      }
    }
  }
  const abs = path.join(workdir, sub);
  // A vanished parent (the directory was moved out of workdir) is not an escape: the
  // published name simply no longer reaches our inode.
  const parentGone = await assertRealParentInsideWorkdir(workdir, abs).then(
    () => false,
    (err: NodeJS.ErrnoException) => {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return true;
      throw err;
    },
  );
  if (parentGone) return { erased: false };
  return { erased: await truncateByIdentity(abs, dev, ino) };
}

async function truncateByIdentity(abs: string, dev: string, ino: string): Promise<boolean> {
  const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let handle: FileHandle;
  try {
    handle = await fs.open(abs, fsConstants.O_RDWR | O_NOFOLLOW);
  } catch (err) {
    // Missing, or a symlink refused by O_NOFOLLOW (ELOOP): not our inode, nothing to do.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ELOOP') return false;
    throw err;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(opened, dev, ino)) return false;
    await handle.truncate(0);
    return true;
  } finally {
    await handle.close();
  }
}

/**
 * Create a folder inside workdir. Errors if anything already exists at the
 * target path. Parent dir must already exist (same rationale as createFile).
 */
export async function createFolder(
  workdir: string,
  relPath: string,
): Promise<FileStat> {
  const sub = assertInsideWorkdir(workdir, relPath);
  if (sub === '') throw new Error('cannot create at workdir root');
  const abs = path.join(workdir, sub);
  await assertRealParentInsideWorkdir(workdir, abs);
  // recursive:false — fail if parent missing or target exists.
  await fs.mkdir(abs, { recursive: false });
  // The new entry must survive a crash as well (writeNewFile's parent may be this folder).
  await syncDirectory(await fs.realpath(path.dirname(abs)));
  const st = await fs.stat(abs);
  return { relPath: sub, type: 'directory', size: 0, mtimeMs: st.mtimeMs };
}

/**
 * Rename / move a file or directory inside workdir. 同一 workdir 内,from 与
 * to 都走 assertInsideWorkdir 防越界。
 *
 * 冲突策略:
 *   - 目标已存在 → 抛错(留给上层 toast)。EXCEPT 大小写仅改写的情况:
 *     NTFS / HFS+ 默认是 case-insensitive,'Foo.md' → 'foo.md' 时 access 会
 *     误报"存在",但 fs.rename 本身能正确改名。所以仅在大小写不同时跳过冲突
 *     检查。
 *   - source 不存在 → fs.rename 自然抛 ENOENT,上层 toast。
 *   - 跨卷不会发生,因为 from/to 都在同一 workdir 下。
 */
export async function renameEntry(
  workdir: string,
  fromRel: string,
  toRel: string,
): Promise<FileStat> {
  const fromSub = assertInsideWorkdir(workdir, fromRel);
  const toSub = assertInsideWorkdir(workdir, toRel);
  if (fromSub === '') throw new Error('cannot rename workdir root');
  if (toSub === '') throw new Error('cannot rename to workdir root');
  if (fromSub === toSub) {
    // no-op,直接返回当前 stat 让上层走刷新逻辑(也可能是大小写在 case-sensitive
    // FS 上重名,但走到这里说明 normalize 后完全相同 → 当 no-op)
    const realFrom = await assertRealPathInsideWorkdir(workdir, path.join(workdir, fromSub));
    const st = await fs.lstat(realFrom);
    return {
      relPath: fromSub,
      type: st.isDirectory() ? 'directory' : 'file',
      size: st.isDirectory() ? 0 : st.size,
      mtimeMs: st.mtimeMs,
    };
  }
  const absFrom = path.join(workdir, fromSub);
  const absTo = path.join(workdir, toSub);
  const realFrom = await assertRealPathInsideWorkdir(workdir, absFrom);
  await assertRealParentInsideWorkdir(workdir, absTo);
  // 大小写仅改写检查:若 normalize 后小写相同,跳过 conflict 检查 — case-only
  // rename 在 case-insensitive FS 上需要直接 rename。
  const caseOnly = fromSub.toLowerCase() === toSub.toLowerCase();
  if (!caseOnly) {
    try {
      await fs.access(absTo);
      throw new Error(`目标已存在: ${toSub}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
  }
  await fs.rename(realFrom, absTo);
  const st = await fs.lstat(absTo);
  return {
    relPath: toSub,
    type: st.isDirectory() ? 'directory' : 'file',
    size: st.isDirectory() ? 0 : st.size,
    mtimeMs: st.mtimeMs,
  };
}

/**
 * Delete a file or directory inside workdir. Directories are removed
 * recursively. No trash / undo — the caller is expected to have shown a
 * confirm prompt.
 */
export async function deleteEntry(workdir: string, relPath: string): Promise<void> {
  const sub = assertInsideWorkdir(workdir, relPath);
  if (sub === '') throw new Error('cannot delete workdir root');
  const abs = path.join(workdir, sub);
  const realAbs = await assertRealPathInsideWorkdir(workdir, abs);
  // rm with recursive+force handles both file and directory; force only
  // suppresses "not found" which is fine for a delete operation.
  await fs.rm(realAbs, { recursive: true, force: true });
}

/** Cheap stat for the unrenderable placeholder (size + mtime). */
export async function statEntry(
  workdir: string,
  relPath: string,
): Promise<FileStat> {
  const sub = assertInsideWorkdir(workdir, relPath);
  if (sub === '') throw new Error('cannot stat workdir root');
  const realAbs = await assertRealPathInsideWorkdir(workdir, path.join(workdir, sub));
  const st = await fs.stat(realAbs);
  return {
    relPath: sub,
    type: st.isDirectory() ? 'directory' : 'file',
    size: st.isDirectory() ? 0 : st.size,
    mtimeMs: st.mtimeMs,
  };
}

/**
 * Convenience wrapper: load matcher + list root in one call. Used by the
 * IPC handler when the renderer enters MD/file-browse mode for the first
 * time on a workdir.
 */
export async function listRoot(
  workdir: string,
  opts: { hideMetaFiles?: boolean; docMode?: boolean } = {},
): Promise<{ entries: DirEntry[]; matcher: Matcher }> {
  const matcher = await loadIgnoreMatcher(workdir, opts);
  const entries = await listDir(workdir, '', matcher, { docMode: opts.docMode });
  log.debug(`listRoot ${workdir} → ${entries.length} entries`);
  return { entries, matcher };
}
