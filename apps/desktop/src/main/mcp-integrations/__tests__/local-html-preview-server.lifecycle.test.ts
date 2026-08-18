import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Startup/teardown lifecycle of the preview server, kept in its own file
 * because reproducing a listener failure requires stubbing `node:http`, and
 * that stub must not reach the rest of the suite.
 *
 * Both cases here failed before the generation counter replaced the sticky
 * `failed`/`disposed` flags, so they are regression guards rather than
 * descriptions of the current implementation.
 */

/** Flipped per-test; the stub only interferes while it is true. */
let failNextListen = false;

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: ((...args: unknown[]) => {
      const srv = (actual.createServer as (...a: unknown[]) => import('node:http').Server)(...args);
      const realListen = srv.listen.bind(srv);
      srv.listen = ((...listenArgs: unknown[]) => {
        if (failNextListen) {
          failNextListen = false;
          // Same shape as a real bind failure: asynchronous 'error', no
          // 'listening'. The server object stays usable so close() is safe.
          setImmediate(() => srv.emit('error', new Error('EADDRINUSE (simulated)')));
          return srv;
        }
        return (realListen as (...a: unknown[]) => import('node:http').Server)(...listenArgs);
      }) as typeof srv.listen;
      return srv;
    }) as typeof actual.createServer,
  };
});

const { createLocalPreviewServer } = await import('../local-html-preview-server.js');

describe('local preview server lifecycle', () => {
  let tmpRoot: string;
  let workingDir: string;
  let grants: string[][];
  let server: ReturnType<typeof createLocalPreviewServer>;

  beforeEach(async () => {
    failNextListen = false;
    tmpRoot = await mkdtemp(nodePath.join(os.tmpdir(), 'preview-lifecycle-'));
    workingDir = nodePath.join(tmpRoot, 'work');
    await mkdir(nodePath.join(workingDir, 'dist'), { recursive: true });
    await writeFile(nodePath.join(workingDir, 'dist', 'index.html'), '<p>hi</p>');
    grants = [];
    server = createLocalPreviewServer({
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      applyPreviewOrigins: (origins) => grants.push(origins),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    server.dispose();
  });

  const create = () =>
    server.createPreviewUrl({ workingDir, localPath: 'dist/index.html' });

  it('recovers from a listener error instead of staying unavailable', async () => {
    failNextListen = true;
    // A bind failure propagates the underlying error verbatim; the MCP
    // boundary maps any message without a recognised code prefix to
    // BROWSER_RUNTIME_LOCAL_PREVIEW_UNAVAILABLE, so callers still see the
    // right code.
    await expect(create()).rejects.toThrow(/EADDRINUSE/);
    // The whole point: a transient bind failure must not disable previews for
    // the rest of the process lifetime. Latching it meant the only recovery
    // was restarting the app, which sends callers back to a raw browser.
    const { url } = await create();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/preview\/[a-f0-9]{64}\//);
    expect(grants.at(-1)).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/)]);
    // The failed attempt must not have granted anything.
    expect(grants.filter((g) => g.length > 0)).toHaveLength(1);
  });

  it('refuses a request whose backend was torn down mid-validation', async () => {
    // Land a dispose() inside the entry-validation await window — the same
    // shape as the user switching to the sidebar backend while the filesystem
    // checks are running. Before the generation counter, the in-flight request
    // then reset the dispose flag and granted a fresh SSRF origin for a
    // backend that does not support previews.
    const realRealpath = fsPromises.realpath.bind(fsPromises);
    let tripped = false;
    vi.spyOn(fsPromises, 'realpath').mockImplementation((async (p: string) => {
      if (!tripped) {
        tripped = true;
        server.dispose();
      }
      return realRealpath(p);
    }) as typeof fsPromises.realpath);

    await expect(create()).rejects.toThrow(/UNAVAILABLE/);
    expect(tripped).toBe(true);
    // No origin may be trusted as a result of that request. dispose() itself
    // pushes an empty revocation, so assert on the non-empty grants only.
    expect(grants.filter((g) => g.length > 0)).toHaveLength(0);

    // And the server is still reusable afterwards (dispose → new start).
    vi.restoreAllMocks();
    const { url } = await create();
    expect(url).toContain('/preview/');
    expect(grants.at(-1)).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/)]);
  });
});
