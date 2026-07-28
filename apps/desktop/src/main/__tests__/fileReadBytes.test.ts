/** fileReadBytes.test — core of the privileged read-file-bytes IPC.
 *  The trusted-sender gate lives in the handler and is covered by
 *  trustedAppRenderer.test; here we exercise every validation / policy /
 *  symlink / size-cap / sanitized-error path of the injectable core. */

import { describe, expect, it, vi } from 'vitest';

import {
  readFileBytesForPreview,
  READ_FILE_BYTES_CAP,
  type FileHandleLike,
  type FileIdentityStat,
  type ReadFileBytesDeps,
} from '../fileReadBytes';

/** dev/ino/size are bigint, matching the `{ bigint: true }` stats production
 *  injects — a 0 inode means "identity unavailable" and must fail closed. */
function statStub(size: number, isFile = true, ino = 1, dev = 1): FileIdentityStat {
  return { size: BigInt(size), isFile: () => isFile, ino: BigInt(ino), dev: BigInt(dev) };
}

/** Fake FileHandle whose fstat size can differ from the readable bytes, so we
 *  can prove the read is bounded to the fstat'd size (regular-file TOCTOU).
 *  ino/dev model the opened descriptor's identity for the swap-revalidation. */
function fakeHandle(opts: {
  statSize: number;
  isFile?: boolean;
  data?: Buffer;
  ino?: number;
  dev?: number;
  readSpy?: (buf: Buffer, offset: number, length: number, position: number) => void;
}): FileHandleLike {
  const data = opts.data ?? Buffer.alloc(opts.statSize);
  return {
    stat: async () => statStub(opts.statSize, opts.isFile ?? true, opts.ino ?? 1, opts.dev ?? 1),
    read: async (buffer, offset, length, position) => {
      opts.readSpy?.(buffer, offset, length, position);
      const bytesRead = data.copy(buffer, offset, position, position + length);
      return { bytesRead };
    },
    close: async () => undefined,
  };
}

function deps(over: Partial<ReadFileBytesDeps> = {}): ReadFileBytesDeps {
  return {
    isPathAllowed: () => true,
    realpath: async (p) => p,
    // expected identity ino/dev=1 matches fakeHandle's default fstat identity
    stat: async () => statStub(4, true, 1, 1),
    open: async () => fakeHandle({ statSize: 4, data: Buffer.from([1, 2, 3, 4]) }),
    ...over,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as { code?: string }).code ?? `NO_CODE:${String(err)}`;
  }
  throw new Error('expected the call to reject, but it resolved');
}

const ABS = '/Users/x/project/paper.pdf';

describe('readFileBytesForPreview', () => {
  it('returns an exact-copy Uint8Array + real size on success', async () => {
    const res = await readFileBytesForPreview({ filePath: ABS }, deps());
    expect(Array.from(res.bytes)).toEqual([1, 2, 3, 4]);
    expect(res.size).toBe(4);
    expect(res.bytes.byteOffset).toBe(0);
    expect(res.bytes.buffer.byteLength).toBe(4);
  });

  it('rejects a null / non-object params with INVALID_PARAMS (no raw TypeError)', async () => {
    expect(await codeOf(readFileBytesForPreview(null, deps()))).toBe('INVALID_PARAMS');
    expect(await codeOf(readFileBytesForPreview(42, deps()))).toBe('INVALID_PARAMS');
  });

  it('rejects a non-string / relative filePath with INVALID_PARAMS', async () => {
    expect(await codeOf(readFileBytesForPreview({ filePath: 123 }, deps()))).toBe('INVALID_PARAMS');
    expect(await codeOf(readFileBytesForPreview({ filePath: 'rel/paper.pdf' }, deps()))).toBe(
      'INVALID_PARAMS',
    );
  });

  it('rejects a blocked lexical path with PERMISSION_DENIED (before any fs access)', async () => {
    const realpath = vi.fn(async (p: string) => p);
    expect(
      await codeOf(
        readFileBytesForPreview({ filePath: ABS }, deps({ isPathAllowed: () => false, realpath })),
      ),
    ).toBe('PERMISSION_DENIED');
    expect(realpath).not.toHaveBeenCalled();
  });

  it('rejects a symlink whose realpath escapes into a blocked dir (PERMISSION_DENIED, no open)', async () => {
    const open = vi.fn(async () => fakeHandle({ statSize: 4 }));
    // lexical /tmp/leak.pdf passes, but it resolves into /etc → must be denied.
    const code = await codeOf(
      readFileBytesForPreview(
        { filePath: '/tmp/leak.pdf' },
        deps({
          isPathAllowed: (p) => !p.startsWith('/etc'),
          realpath: async () => '/etc/shadow',
          open,
        }),
      ),
    );
    expect(code).toBe('PERMISSION_DENIED');
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects when the opened descriptor identity differs from the realpath (ancestor symlink swap)', async () => {
    // expected realpath identity ino=1; the opened fd resolves to ino=999 → an
    // ancestor component was swapped to point elsewhere between realpath & open.
    expect(
      await codeOf(
        readFileBytesForPreview(
          { filePath: ABS },
          deps({
            stat: async () => statStub(4, true, 1, 1),
            open: async () => fakeHandle({ statSize: 4, data: Buffer.from([1, 2, 3, 4]), ino: 999 }),
          }),
        ),
      ),
    ).toBe('PRECONDITION_FAILED');
  });

  it('fails closed when the inode identity is unavailable (ino reported as 0)', async () => {
    // Some Windows / network filesystems report ino 0. Both sides then read 0,
    // so an equality check would pass and the swap guard would silently be a
    // no-op exactly where it is needed. Must reject instead.
    expect(
      await codeOf(
        readFileBytesForPreview(
          { filePath: ABS },
          deps({
            stat: async () => statStub(4, true, 0, 1),
            open: async () =>
              fakeHandle({ statSize: 4, data: Buffer.from([1, 2, 3, 4]), ino: 0 }),
          }),
        ),
      ),
    ).toBe('PRECONDITION_FAILED');
  });

  it('rejects a non-regular file (FIFO/socket/device) with INVALID_PARAMS', async () => {
    expect(
      await codeOf(
        readFileBytesForPreview(
          { filePath: ABS },
          deps({ open: async () => fakeHandle({ statSize: 0, isFile: false }) }),
        ),
      ),
    ).toBe('INVALID_PARAMS');
  });

  it('rejects when the fstat size already exceeds the cap (PRECONDITION_FAILED)', async () => {
    expect(
      await codeOf(
        readFileBytesForPreview(
          { filePath: ABS },
          deps({ open: async () => fakeHandle({ statSize: READ_FILE_BYTES_CAP + 1 }) }),
        ),
      ),
    ).toBe('PRECONDITION_FAILED');
  });

  it('bounds the read to the fstat size even if the file is larger (regular-file TOCTOU)', async () => {
    // fstat reports 4 bytes; the underlying data is 100. The read must be
    // bounded to 4 (never buffer the extra bytes into main-process memory).
    let maxLengthRequested = 0;
    const handle = fakeHandle({
      statSize: 4,
      data: Buffer.alloc(100, 7),
      readSpy: (_b, _o, length) => {
        maxLengthRequested = Math.max(maxLengthRequested, length);
      },
    });
    const res = await readFileBytesForPreview({ filePath: ABS, maxSize: 8 }, deps({ open: async () => handle }));
    expect(res.size).toBe(4);
    expect(res.bytes.byteLength).toBe(4);
    expect(maxLengthRequested).toBeLessThanOrEqual(4);
  });

  it('handles a shrunk file (EOF before fstat size) by returning what was read', async () => {
    // fstat says 10 but only 3 bytes are readable → return those 3.
    const res = await readFileBytesForPreview(
      { filePath: ABS },
      deps({ open: async () => fakeHandle({ statSize: 10, data: Buffer.from([9, 8, 7]) }) }),
    );
    expect(Array.from(res.bytes)).toEqual([9, 8, 7]);
    expect(res.size).toBe(3);
  });

  it('a NaN / non-positive maxSize falls back to the hard cap (does not drop it)', async () => {
    expect(
      await codeOf(
        readFileBytesForPreview(
          { filePath: ABS, maxSize: Number.NaN },
          deps({ open: async () => fakeHandle({ statSize: READ_FILE_BYTES_CAP + 1 }) }),
        ),
      ),
    ).toBe('PRECONDITION_FAILED');
    const ok = await readFileBytesForPreview({ filePath: ABS, maxSize: -5 }, deps());
    expect(ok.size).toBe(4);
  });

  it('maps realpath / open failures to a sanitized NOT_FOUND', async () => {
    expect(
      await codeOf(
        readFileBytesForPreview(
          { filePath: ABS },
          deps({ realpath: async () => { throw new Error('ENOENT: /secret/abs/path'); } }),
        ),
      ),
    ).toBe('NOT_FOUND');
    expect(
      await codeOf(
        readFileBytesForPreview(
          { filePath: ABS },
          deps({ open: async () => { throw new Error('EACCES: /secret/abs/path'); } }),
        ),
      ),
    ).toBe('NOT_FOUND');
  });

  it('maps an fstat() failure to a sanitized INTERNAL', async () => {
    const handle: FileHandleLike = {
      stat: async () => { throw new Error('EIO: /secret/abs/path'); },
      read: async () => ({ bytesRead: 0 }),
      close: async () => undefined,
    };
    expect(
      await codeOf(readFileBytesForPreview({ filePath: ABS }, deps({ open: async () => handle }))),
    ).toBe('INTERNAL');
  });

  it('maps a read() failure to a sanitized INTERNAL', async () => {
    const handle: FileHandleLike = {
      stat: async () => statStub(4),
      read: async () => { throw new Error('EIO: /secret/abs/path'); },
      close: async () => undefined,
    };
    expect(
      await codeOf(readFileBytesForPreview({ filePath: ABS }, deps({ open: async () => handle }))),
    ).toBe('INTERNAL');
  });
});
