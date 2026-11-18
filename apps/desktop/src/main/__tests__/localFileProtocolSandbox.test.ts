/**
 * localFileProtocolSandbox.test.ts
 * ---------------------------------------------------------------------------
 * End-to-end guard for the xdt-file:// directory-confinement layer added to
 * shrink the "arbitrary local file read" surface:
 *   - a whitelisted-extension URL whose target realpath's INTO a sensitive dir
 *     (symlink escape, e.g. ~/.ssh, /etc) → 403 (was 200 before the sandbox);
 *   - a broken symlink / missing target → 404;
 *   - an innocuous target → 200 (no regression).
 *
 * Mirrors the electron/fs mock setup of the sibling handler tests. The
 * blocklist is built from the real homedir + host platform; `fs.realpath`
 * (node:fs/promises) is mocked to simulate where a symlink resolves to.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeMarkdownImageSrc } from '../../renderer/lib/localPathResolver';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/never-used-here' },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock('node:fs', () => ({
  createReadStream: vi.fn(() => Readable.from([Buffer.from('FAKE_BYTES')])),
  // identity keeps blocklist roots verbatim (resolved form) without touching a
  // real filesystem, so the injected realpath targets below match exactly.
  realpathSync: { native: (p: string) => p },
}));

const fs = await import('node:fs/promises');
const electron = await import('electron');
const { registerLocalFileProtocolHandler } = await import('../localFileProtocol');

function getHandler(): (req: Request) => Promise<Response> {
  const handle = electron.protocol.handle as unknown as ReturnType<typeof vi.fn>;
  registerLocalFileProtocolHandler();
  const lastCall = handle.mock.calls[handle.mock.calls.length - 1];
  return lastCall[1] as (req: Request) => Promise<Response>;
}

const ABS_DIR = process.platform === 'win32' ? 'C:\\tmp\\' : '/tmp/';
function urlFor(filename: string): string {
  return `xdt-file://local/?path=${encodeURIComponent(ABS_DIR + filename)}`;
}

const realpathMock = fs.realpath as unknown as ReturnType<typeof vi.fn>;
const statMock = fs.stat as unknown as ReturnType<typeof vi.fn>;

describe('localFileProtocol — sensitive-directory confinement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statMock.mockResolvedValue({ isFile: () => true, size: 10 });
  });

  // #11261, unit: real renderer URL conversion -> registered protocol handler.
  // Slash-form Windows shares used to reach the filesystem; no real SMB is contacted.
  it.each(['file:////nas/share/a.png', 'file:///\\nas/share/a.png'])(
    'rejects rendered Windows shared image %s before any filesystem access', async (src) => {
      const url = normalizeMarkdownImageSrc(src, 'C:\\proj', true);
      const res = await getHandler()(new Request(url!));
      expect(res.status).toBe(403);
      expect(realpathMock).not.toHaveBeenCalled();
      expect(statMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a symlink that resolves into ~/.ssh with 403', async () => {
    const sshTarget = path.join(os.homedir(), '.ssh', 'id_rsa.png');
    realpathMock.mockResolvedValue(sshTarget);
    const handler = getHandler();
    const res = await handler(new Request(urlFor('innocent.png')));
    expect(res.status).toBe(403);
  });

  it('rejects a target that resolves into a system dir (/etc) with 403', async () => {
    // /etc is only meaningful on POSIX; on win32 use a system dir instead.
    const sysTarget =
      process.platform === 'win32'
        ? 'C:\\Windows\\System32\\evil.png'
        : '/etc/evil.png';
    realpathMock.mockResolvedValue(sysTarget);
    const handler = getHandler();
    const res = await handler(new Request(urlFor('innocent.png')));
    expect(res.status).toBe(403);
  });

  it('rejects a sensitive lexical path whose realpath points elsewhere with 403', async () => {
    // Root created AFTER the blocklist was cached, as a symlink to an uncached
    // target: the realpath no longer matches any cached root, but the lexical
    // (requested) path does — the guard must consult both forms.
    const sshRequested = path.join(os.homedir(), '.ssh', 'id_rsa.png');
    const retargeted =
      process.platform === 'win32' ? 'C:\\secrets\\id_rsa.png' : '/mnt/secrets/id_rsa.png';
    realpathMock.mockResolvedValue(retargeted);
    const handler = getHandler();
    const res = await handler(
      new Request(`xdt-file://local/?path=${encodeURIComponent(sshRequested)}`),
    );
    expect(res.status).toBe(403);
  });

  it('denies a sensitive lexical path BEFORE realpath (realpath never called)', async () => {
    // Literal blocklist must fire first so a permission failure on realpath
    // can't turn a known-sensitive path into a 500.
    const sshRequested = path.join(os.homedir(), '.ssh', 'id_rsa.png');
    realpathMock.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EPERM' }));
    const handler = getHandler();
    const res = await handler(
      new Request(`xdt-file://local/?path=${encodeURIComponent(sshRequested)}`),
    );
    expect(res.status).toBe(403);
    expect(realpathMock).not.toHaveBeenCalled();
  });

  it('maps realpath EPERM on a non-sensitive path to 403 (Windows permission denial)', async () => {
    realpathMock.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EPERM' }));
    const handler = getHandler();
    const res = await handler(new Request(urlFor('locked.png')));
    expect(res.status).toBe(403);
  });

  it('returns 404 when the target is missing / broken symlink (ENOENT)', async () => {
    realpathMock.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    const handler = getHandler();
    const res = await handler(new Request(urlFor('gone.png')));
    expect(res.status).toBe(404);
  });

  it('maps realpath ELOOP (symlink loop) to 404, not 500', async () => {
    realpathMock.mockRejectedValue(Object.assign(new Error('loop'), { code: 'ELOOP' }));
    const handler = getHandler();
    const res = await handler(new Request(urlFor('loop.png')));
    expect(res.status).toBe(404);
  });

  it('serves an innocuous target (outside every sensitive dir) as 200', async () => {
    realpathMock.mockImplementation(async (p: string) => p); // identity → /tmp/ok.png
    const handler = getHandler();
    const res = await handler(new Request(urlFor('ok.png')));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
  });
});
