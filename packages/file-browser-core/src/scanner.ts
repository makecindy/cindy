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

import { promises as fs, type Stats, type Dirent } from 'node:fs';
import path from 'node:path';

import { scopedLogger } from './logging.js';
import { loadIgnoreMatcher, type Matcher } from './ignore.js';

const log = scopedLogger('file-browser/scanner');

/** Hard cap on file size we'll send to the renderer. Anything larger gets
 *  truncated; renderer shows a "file truncated, open in OS to see more"
 *  banner. 2 MiB is enough for any realistic markdown/code file. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

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
 *   - A shared `Found` cell short-circuits: any walk that's about to start
 *     bails if some other branch has already returned true.
 *
 * Worst case (deep subtree with no matching file): walks the whole subtree
 * once, but in parallel. BUILTIN_IGNORE prunes node_modules / Library /
 * etc., which are the only realistic huge subtrees.
 */
type Found = { v: boolean };

async function hasDocDescendantInner(
  abs: string,
  relPath: string,
  matcher: Matcher,
  found: Found,
): Promise<boolean> {
  if (found.v) return true;
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
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
  // Pass 2: recurse all subdirs in parallel. Each child re-checks `found`
  // at entry, so a fast hit anywhere in the tree stops new work cheaply.
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
  const dirents = await fs.readdir(abs, { withFileTypes: true });

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
 * flag. Binary files (NULL byte in first 4KB) raise an error so the renderer
 * can render the unrenderable-placeholder card instead.
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
    // Quick binary detection: NULL byte in first 4 KiB. Catches PNG/FBX/DLL
    // etc. UTF-16 text files contain NULL bytes too but are rare in dev
    // workflows; renderer can still fall back to "open in OS" if needed.
    const probe = buf.subarray(0, Math.min(buf.length, 4096));
    if (probe.includes(0)) {
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
 *   - Refuses binary files (NULL byte in first 4KB) — same probe as readFile,
 *     so the editor never opens binaries to begin with.
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
    if (probe.includes(0)) {
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
