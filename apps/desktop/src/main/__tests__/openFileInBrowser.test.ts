import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  handleOpenFileInBrowser,
  resolveBrowserFileTarget,
  type OpenFileInBrowserDeps,
} from '../openFileInBrowser.js';

function harness(overrides: Partial<OpenFileInBrowserDeps> = {}) {
  const deps: OpenFileInBrowserDeps = {
    isPathAllowed: vi.fn(() => true),
    isBrowserOpenablePath: vi.fn(() => true),
    existsSync: vi.fn(() => true),
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ''),
    onOpenExternalError: vi.fn(),
    ...overrides,
  };
  return deps;
}

describe('resolveBrowserFileTarget', () => {
  it('keeps query and hash on a local file URL while resolving its path', () => {
    const filePath = path.resolve('/tmp', 'preview page.html');
    const url = pathToFileURL(filePath);
    url.search = '?mode=review';
    url.hash = '#/section';

    expect(resolveBrowserFileTarget(url.toString())).toEqual({
      filePath,
      fileUrl: url.toString(),
      hasUrlState: true,
    });
  });

  it('rejects non-local file authorities and non-file URLs', () => {
    expect(resolveBrowserFileTarget('file://server/share/index.html')).toBeNull();
    expect(resolveBrowserFileTarget('https://example.test/index.html')).toBeNull();
  });
});

describe('handleOpenFileInBrowser', () => {
  it('opens a full local file URL without dropping query or hash', async () => {
    const filePath = path.resolve('/tmp', 'preview.html');
    const url = pathToFileURL(filePath);
    url.search = '?mode=review';
    url.hash = '#/section';
    const deps = harness();

    await expect(handleOpenFileInBrowser(url.toString(), deps)).resolves.toEqual({
      success: true,
    });

    expect(deps.isPathAllowed).toHaveBeenCalledWith(filePath);
    expect(deps.openExternal).toHaveBeenCalledWith(url.toString());
    expect(deps.openPath).not.toHaveBeenCalled();
  });

  it('keeps legacy absolute paths and falls back to openPath', async () => {
    const filePath = path.resolve('/tmp', 'preview.html');
    const deps = harness({
      openExternal: vi.fn(async () => {
        throw new Error('file URL unavailable');
      }),
    });

    await expect(handleOpenFileInBrowser(filePath, deps)).resolves.toEqual({ success: true });

    expect(deps.openExternal).toHaveBeenCalledWith(pathToFileURL(filePath).toString());
    expect(deps.openPath).toHaveBeenCalledWith(filePath);
  });

  it('does not discard URL state when openExternal fails', async () => {
    const url = pathToFileURL(path.resolve('/tmp', 'preview.html'));
    url.hash = '#/section';
    const deps = harness({
      openExternal: vi.fn(async () => {
        throw new Error('browser rejected URL');
      }),
    });

    await expect(handleOpenFileInBrowser(url.toString(), deps)).resolves.toEqual({
      success: false,
      error: 'browser rejected URL',
    });
    expect(deps.openPath).not.toHaveBeenCalled();
  });
});
