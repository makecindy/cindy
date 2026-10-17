/**
 * audioFileProtocolRange.test.ts
 * ---------------------------------------------------------------------------
 * Locks in the Range header parser AND the handler-level static validation
 * (URL host / path absoluteness / extension whitelist / fs.stat error mapping)
 * for the xdt-audio:// protocol.
 *
 * The Range parser here intentionally diverges from videoProtocol's: it must
 * tell `unsatisfiable` (→ 416) apart from `absent / malformed` (→ 200) so the
 * handler can dispatch correctly. videoProtocol returned `null` for both,
 * which would silently collapse the 416 branch.
 */

import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/never-used-here' },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn(async (p: string) => p),
}));

// 黑名单判定 mock 成可控开关:本文件只测 handler 的接线(blocked→403 / 放行→200 /
// realpath 结果用于读文件);isPathAllowedAgainst 的真实语义由 filePathPolicy.test
// 与 mediaFetch.test 覆盖。真实实现对 Windows 盘符路径在 POSIX 宿主上恒 false,
// 会把下面的 drive-letter 用例误拦。
const pathAllowedMock = vi.hoisted(() => vi.fn(() => true));
vi.mock('../filePathPolicy', () => ({
  getSensitiveMediaBlocklist: () => ['/sentinel-blocklist'],
  isPathAllowedAgainst: pathAllowedMock,
}));

const fs = await import('node:fs/promises');
const electron = await import('electron');
const { parseRangeHeader, registerAudioFileProtocolHandler } = await import(
  '../audioFileProtocol'
);

describe('parseRangeHeader', () => {
  it('returns null when header is absent', () => {
    expect(parseRangeHeader(null, 1000)).toBeNull();
  });

  it('parses bytes=0- (chromium <audio> initial fetch) → full file range', () => {
    expect(parseRangeHeader('bytes=0-', 1000)).toEqual({
      kind: 'range',
      start: 0,
      end: 999,
    });
  });

  it('parses an explicit closed range', () => {
    expect(parseRangeHeader('bytes=100-199', 1000)).toEqual({
      kind: 'range',
      start: 100,
      end: 199,
    });
  });

  it('parses a suffix range (last N bytes)', () => {
    expect(parseRangeHeader('bytes=-256', 1000)).toEqual({
      kind: 'range',
      start: 744,
      end: 999,
    });
  });

  it('clamps an over-long end to the final byte', () => {
    expect(parseRangeHeader('bytes=0-9999', 1000)).toEqual({
      kind: 'range',
      start: 0,
      end: 999,
    });
  });

  it('classifies an out-of-range start or inverted range as unsatisfiable', () => {
    expect(parseRangeHeader('bytes=500-100', 1000)).toEqual({
      kind: 'unsatisfiable',
    });
    expect(parseRangeHeader('bytes=2000-', 1000)).toEqual({
      kind: 'unsatisfiable',
    });
  });

  it('returns null for malformed header (caller falls back to 200)', () => {
    expect(parseRangeHeader('blocks=0-100', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=abc', 1000)).toBeNull();
    expect(parseRangeHeader('', 1000)).toBeNull();
  });

  it('handles whitespace around the value', () => {
    expect(parseRangeHeader('  bytes=0-9  ', 1000)).toEqual({
      kind: 'range',
      start: 0,
      end: 9,
    });
  });
});

// ---------------------------------------------------------------------------
// Handler static validation tests.
//
// We capture the handler function passed to protocol.handle() and invoke it
// directly with a synthetic Request. fs.stat / fs.readFile are mocked so the
// only surface under test is URL parsing → validation → error mapping.
// ---------------------------------------------------------------------------

function getHandler(): (req: Request) => Promise<Response> {
  const handle = electron.protocol.handle as unknown as ReturnType<typeof vi.fn>;
  registerAudioFileProtocolHandler();
  const lastCall = handle.mock.calls[handle.mock.calls.length - 1];
  return lastCall[1] as (req: Request) => Promise<Response>;
}

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

describe('audio handler static validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pathAllowedMock.mockReturnValue(true);
    (fs.realpath as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (p: string) => p,
    );
  });

  it('rejects a realpath target inside the sensitive blocklist with 403 (no read)', async () => {
    pathAllowedMock.mockReturnValue(false);
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Fhome%2Fme%2F.ssh%2Fleak.mp3'),
    );
    expect(res.status).toBe(403);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('checks the blocklist against the realpath and reads from it (symlink escape / TOCTOU)', async () => {
    const real = '/home/me/.ssh/actual.mp3';
    (fs.realpath as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(real);
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ isFile: () => true });
    (fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('X'));
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Finnocent.mp3'),
    );
    expect(res.status).toBe(200);
    // both the lexical (requested) form and the realpath are consulted
    expect(pathAllowedMock).toHaveBeenCalledWith(
      path.resolve('/tmp/innocent.mp3'),
      ['/sentinel-blocklist'],
    );
    expect(pathAllowedMock).toHaveBeenCalledWith(real, ['/sentinel-blocklist']);
    expect(fs.stat).toHaveBeenCalledWith(real);
    expect(fs.readFile).toHaveBeenCalledWith(real);
  });

  it('rejects non-local host with 403', async () => {
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://other/?path=%2Ftmp%2Ffoo.mp3'),
    );
    expect(res.status).toBe(403);
  });

  it('rejects missing path query with 400', async () => {
    const handler = getHandler();
    const res = await handler(makeRequest('xdt-audio://local/'));
    expect(res.status).toBe(400);
  });

  it('rejects relative path with 403', async () => {
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=relative%2Ffoo.mp3'),
    );
    expect(res.status).toBe(403);
  });

  it('rejects non-whitelisted extension with 415', async () => {
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Fetc%2Fpasswd'),
    );
    expect(res.status).toBe(415);
  });

  it('rejects directory (stat.isFile()===false) with 404', async () => {
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      isFile: () => false,
    });
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Fdir.mp3'),
    );
    expect(res.status).toBe(404);
  });

  it('maps ENOENT (file missing) to 404', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Fmissing.mp3'),
    );
    expect(res.status).toBe(404);
  });

  it('maps realpath ENOTDIR (non-dir path component) to 404, not 500', async () => {
    (fs.realpath as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('not a dir'), { code: 'ENOTDIR' }),
    );
    const handler = getHandler();
    const res = await handler(makeRequest('xdt-audio://local/?path=%2Ffoo%2Fbar.mp3%2Fx.mp3'));
    expect(res.status).toBe(404);
  });

  it('maps realpath EPERM to 403 (parity with localFileProtocol)', async () => {
    (fs.realpath as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'EPERM' }),
    );
    const handler = getHandler();
    const res = await handler(makeRequest('xdt-audio://local/?path=%2Ftmp%2Flocked.mp3'));
    expect(res.status).toBe(403);
  });

  it('maps ELOOP (symlink loop) to 404', async () => {
    const err = Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Floop.mp3'),
    );
    expect(res.status).toBe(404);
  });

  it('accepts uppercase whitelisted extension (case-insensitive)', async () => {
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      isFile: () => true,
    });
    (fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      Buffer.from('FAKE_MP3'),
    );
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2FOUT.MP3'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
  });

  it('accepts Windows drive-letter absolute paths (WIN_ABS_RE branch)', async () => {
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      isFile: () => true,
    });
    (fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      Buffer.from('FAKE_MP3'),
    );
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=C%3A%5CUsers%5Cme%5COUT.mp3'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
  });

  it('maps EPERM (Windows permission denial) to 403', async () => {
    const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Flocked.mp3'),
    );
    expect(res.status).toBe(403);
  });

  it('serves filename with a literal % (no double-decode regression)', async () => {
    // URLSearchParams.get already percent-decodes; if the handler
    // ever calls decodeURIComponent again, this filename's residual
    // `% ` becomes an invalid escape and throws URIError → 500.
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      isFile: () => true,
    });
    (fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      Buffer.from('OK'),
    );
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2F100%25%20done.mp3'),
    );
    expect(res.status).toBe(200);
  });
});

describe('audio handler range responses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.stat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      isFile: () => true,
    });
    (fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      Buffer.from('0123456789'),
    );
  });

  it('serves a closed range as 206 with sliced bytes + headers', async () => {
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Fclip.mp3', {
        headers: { Range: 'bytes=2-5' },
      }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(res.headers.get('Content-Length')).toBe('4');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('2345');
  });

  it('serves through EOF when a closed range end exceeds the file size', async () => {
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Fclip.mp3', {
        headers: { Range: 'bytes=2-999' },
      }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 2-9/10');
    expect(res.headers.get('Content-Length')).toBe('8');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('23456789');
  });

  it('maps an unsatisfiable range to 416 with full media headers', async () => {
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Fclip.mp3', {
        headers: { Range: 'bytes=999-' },
      }),
    );
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */10');
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
  });

  it('falls back to 200 full body when Range header is absent', async () => {
    const handler = getHandler();
    const res = await handler(
      makeRequest('xdt-audio://local/?path=%2Ftmp%2Fclip.mp3'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('10');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
  });
});
