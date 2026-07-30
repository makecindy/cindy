/**
 * fileReadBytes — sender-agnostic core of the `read-file-bytes` IPC.
 *
 * The IPC handler (bootstrap-electron.ts) adds the trusted-sender gate
 * (`assertTrustedAppRendererEvent`) and injects the real fs/policy deps; this
 * module holds the validation + bounded-read logic so it is unit-testable
 * without Electron. Every failure throws a sanitized `IpcError` (no raw fs
 * message or absolute-path leak) — the renderer's invoke() rejects and
 * PdfPreview falls back to its placeholder.
 *
 * Hardening (each exercised by fileReadBytes.test.ts):
 *   - params must be an object (null/non-object → INVALID_PARAMS, not a raw
 *     TypeError from destructuring);
 *   - filePath must be an absolute string (INVALID_PARAMS);
 *   - the lexical path AND its realpath must both pass the injected policy — a
 *     symlink whose name passes but resolves into a blocked dir (e.g.
 *     /tmp/leak.pdf → /etc/…) is denied (PERMISSION_DENIED); we then open the
 *     resolved path so a check→open swap can't smuggle a different file;
 *   - a single descriptor is fstat'd and read (no path re-resolution between
 *     the size check and the read): non-regular files (FIFO/socket/device) are
 *     rejected (INVALID_PARAMS), and the read buffer is bounded to the fstat'd
 *     size (≤ maxSize) so a regular file that grows/gets replaced after the
 *     check can never make the read exceed the ceiling in main-process memory
 *     (PRECONDITION_FAILED when already over cap at fstat time);
 *   - realpath / open / read errors map to sanitized NOT_FOUND / INTERNAL;
 *   - success returns an exact-copy Uint8Array (no pooled-slab spillover).
 */

import * as nodePath from 'node:path';

import { throwIpcError } from './utils/ipcValidate.js';

/** Hard ceiling regardless of the caller-requested maxSize. */
export const READ_FILE_BYTES_CAP = 30 * 1024 * 1024;

/**
 * The stat fields this module needs. `dev`/`ino`/`size` are bigint because the
 * identity check below is only sound on bigint stats: the default numeric
 * `Stats` rounds 64-bit file ids past 2^53 (large NTFS volumes), which would let
 * two different files on one device compare equal. Callers therefore inject
 * `stat(p, { bigint: true })` / `handle.stat({ bigint: true })`.
 */
export interface FileIdentityStat {
  dev: bigint;
  ino: bigint;
  size: bigint;
  isFile(): boolean;
}

/** The subset of fs.promises.FileHandle this module uses (injectable for tests). */
export interface FileHandleLike {
  stat: () => Promise<FileIdentityStat>;
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesRead: number }>;
  close: () => Promise<void>;
}

export interface ReadFileBytesDeps {
  isPathAllowed: (filePath: string) => boolean;
  realpath: (filePath: string) => Promise<string>;
  /** stat of the (symlink-free) realpath, for the expected dev/ino identity. */
  stat: (filePath: string) => Promise<FileIdentityStat>;
  open: (filePath: string) => Promise<FileHandleLike>;
}

/**
 * `dev + ino` is the stable identity between the policy-checked path and the
 * opened descriptor. A 0 inode means the platform / filesystem does not report
 * one (some Windows and network filesystems), i.e. the identity is UNAVAILABLE
 * — fail closed rather than let `0 === 0` silently satisfy the swap guard in
 * exactly the cases it exists to catch. Same rule as `isSameFileObject` in
 * chatAttachmentSave.ts.
 */
function isSameFileObject(expected: FileIdentityStat, actual: FileIdentityStat): boolean {
  return expected.ino !== 0n && expected.dev === actual.dev && expected.ino === actual.ino;
}

export async function readFileBytesForPreview(
  params: unknown,
  deps: ReadFileBytesDeps,
): Promise<{ bytes: Uint8Array; size: number }> {
  // Validate the payload shape BEFORE destructuring: a null / non-object
  // params from a buggy or hostile renderer must land on INVALID_PARAMS, not
  // throw a raw TypeError that leaks a stack to the renderer.
  if (typeof params !== 'object' || params === null) {
    throwIpcError('INVALID_PARAMS', 'params must be an object');
  }
  const { filePath, maxSize: rawMaxSize } = params as { filePath?: unknown; maxSize?: unknown };

  // Coerce defensively: a NaN / non-finite / non-positive maxSize must fall
  // back to the hard cap, never make Math.min return NaN (which would make the
  // size comparisons below vacuously false and drop the cap entirely).
  const requested = Number(rawMaxSize);
  const maxSize =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, READ_FILE_BYTES_CAP)
      : READ_FILE_BYTES_CAP;

  if (typeof filePath !== 'string' || !nodePath.isAbsolute(filePath)) {
    throwIpcError('INVALID_PARAMS', 'filePath must be an absolute path');
  }
  if (!deps.isPathAllowed(filePath)) {
    throwIpcError('PERMISSION_DENIED', 'path is not allowed');
  }

  // Resolve symlinks and re-check the policy on the REAL target: isPathAllowed
  // is a lexical deny-list, and stat/read follow symlinks, so a symlink whose
  // name passes but resolves into a blocked dir must be denied here. We then
  // open the resolved path; the injected `open` is expected to use O_NOFOLLOW
  // on the final component so a realpath→open swap of that component fails
  // (ELOOP) instead of following into a denied file.
  const realPath = await deps
    .realpath(filePath)
    .catch(() => throwIpcError('NOT_FOUND', 'file not found'));
  if (!deps.isPathAllowed(realPath)) {
    throwIpcError('PERMISSION_DENIED', 'path is not allowed');
  }

  // Expected identity of the resolved target, captured right after the policy
  // check. O_NOFOLLOW (in the injected open) only guards the FINAL component; an
  // ancestor dir swapped to a symlink between realpath and open would still be
  // followed. Comparing the opened descriptor's dev/ino against this expected
  // identity rejects that swap (a mismatch means open landed on a different
  // inode than the path we policy-checked). Node has no portable openat2 /
  // RESOLVE_NO_SYMLINKS, so this fd-identity revalidation is the mitigation;
  // the shipped xdt-file:// protocol (localFileProtocol.ts) carries the same
  // residual realpath→stat micro-race.
  const expected = await deps
    .stat(realPath)
    .catch(() => throwIpcError('NOT_FOUND', 'file not found'));

  const handle = await deps
    .open(realPath)
    .catch(() => throwIpcError('NOT_FOUND', 'file not found'));
  try {
    const st = await handle.stat().catch(() => throwIpcError('INTERNAL', 'failed to stat file'));
    // Regular files only: a FIFO / socket / device stats as size 0 and would
    // otherwise be read as an unbounded stream.
    if (!st.isFile()) {
      throwIpcError('INVALID_PARAMS', 'not a regular file');
    }
    // Descriptor-identity revalidation: the opened fd must be the very inode the
    // policy-checked realpath resolved to (guards the ancestor-symlink swap).
    // Fails closed when the identity is unavailable — see isSameFileObject.
    if (!isSameFileObject(expected, st)) {
      throwIpcError('PRECONDITION_FAILED', 'file changed during read');
    }
    // Down to Number only after the identity check: the size ceiling is a plain
    // number and a 30MB cap is far below Number.MAX_SAFE_INTEGER.
    const size = Number(st.size);
    if (size > maxSize) {
      throwIpcError('PRECONDITION_FAILED', 'file exceeds the preview size limit');
    }
    // Bound the buffer to the fstat'd size of THIS descriptor (≤ maxSize): even
    // if the file grows or is replaced after the check, we never read more than
    // this into main-process memory. Loop over short reads; stop early on EOF
    // (file shrank) and return exactly what was read.
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle
        .read(buffer, offset, size - offset, offset)
        .catch(() => throwIpcError('INTERNAL', 'failed to read file'));
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // buffer.buffer is exact-size (Buffer.alloc is unpooled); slice to the bytes
    // actually read so a shrunk file doesn't ship trailing zero padding.
    const bytes = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + offset));
    return { bytes, size: offset };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
