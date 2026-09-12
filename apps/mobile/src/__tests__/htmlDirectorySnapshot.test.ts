import { describe, expect, it, vi } from 'vitest';
import { collectHtmlSnapshot, htmlSnapshotLocation, HTML_SNAPSHOT_MAX_BYTES, snapshotDocumentPaths } from '@/session/htmlDirectorySnapshot';
import { interceptSnapshotNavigation } from '@/session/htmlNavigationPolicy';
import { HTML_SNAPSHOT_CSP, withSnapshotHtmlCsp } from '@/session/htmlPreviewCsp';

const entry = (relPath: string, type: 'file' | 'directory' = 'file', size = 1) => ({ name: relPath.split('/').pop()!, relPath, type, size });
const signal = () => new AbortController().signal;

describe('HTML directory snapshot', () => {
  it('includes build outputs, nested navigation and root-relative assets while withholding hidden files', async () => {
    const tree = { '': [entry('index.html'), entry('second.html'), entry('dist', 'directory'), entry('.env')], dist: [entry('dist/main.js')] };
    const list = vi.fn(async (rel: string) => tree[rel as keyof typeof tree]);
    const files = await collectHtmlSnapshot('index.html', list, signal());
    expect(files.map((f) => f.relPath)).toEqual(['index.html', 'second.html', 'dist/main.js']);
    expect(snapshotDocumentPaths(files)).toEqual(['/index.html', '/', '/second.html']);
  });
  it.each([
    [entry('../escape.html')], [entry('index.html'), entry('index.html')],
    [{ ...entry('index.html'), size: NaN }], [{ ...entry('index.html'), type: 'symlink' }],
    [{ ...entry('index.html'), relPath: '/index.html' }],
  ].map((bad) => ({ bad })))('rejects malformed or duplicated entries', async ({ bad }) => {
    await expect(collectHtmlSnapshot('index.html', async () => bad, signal())).rejects.toThrow('PREVIEW_LIST_FAILED');
  });
  it('fails whole snapshots on missing entry and quota overflow, without truncation', async () => {
    await expect(collectHtmlSnapshot('index.html', async () => [], signal())).rejects.toThrow('NOT_FOUND');
    await expect(collectHtmlSnapshot('index.html', async () => [entry('index.html', 'file', HTML_SNAPSHOT_MAX_BYTES + 1)], signal())).rejects.toThrow('PREVIEW_TOO_LARGE');
    await expect(collectHtmlSnapshot('index.html', async () => Array.from({ length: 2001 }, (_, i) => entry(String(i))), signal())).rejects.toThrow('PREVIEW_TOO_LARGE');
  });
  it('aborts after a pending listing without proceeding to another directory', async () => {
    const controller = new AbortController();
    const list = vi.fn(async () => { controller.abort(); return [entry('dist', 'directory')]; });
    await expect(collectHtmlSnapshot('index.html', list, controller.signal)).rejects.toThrow();
    expect(list).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['/tmp/site/index.html', '/tmp/site', 'index.html'],
    ['C:\\site\\中文.htm', 'C:/site', '中文.htm'],
    ['C:\\index.html', 'C:/', 'index.html'],
    ['/index.html', '/', 'index.html'],
  ])('preserves remote roots for %s', (path, root, name) => {
    expect(htmlSnapshotLocation(path)).toEqual({ root, entry: name });
  });
});

describe('snapshot navigation and policy', () => {
  const initial = 'http://127.0.0.1:43123/__cindy/token';
  const documents = ['/index.html', '/', '/second.html', '/%E4%B8%AD%E6%96%87.html'];
  it.each(['/index.html', '/second.html?x=1#anchor', '/', '/%E4%B8%AD%E6%96%87.html'])('allows guarded local document %s', (path) => {
    expect(interceptSnapshotNavigation('http://127.0.0.1:43123' + path, initial, documents)).toBe(true);
  });
  it.each(['https://example.org', 'http://127.0.0.1:43124/index.html', 'file:///tmp/index.html', 'about:blank', 'javascript:alert(1)', 'http://127.0.0.1:43123/image.svg', 'http://user@127.0.0.1:43123/index.html'])('rejects %s', (url) => {
    expect(interceptSnapshotNavigation(url, initial, documents)).toBe(false);
  });
  it('guards each HTML before author scripts while preserving module and asset references', () => {
    const html = '<script type="module" src="dist/main.js"></script><a href="second.html">中文</a>';
    const guarded = withSnapshotHtmlCsp(html);
    expect(guarded.endsWith(html)).toBe(true);
    expect(guarded.indexOf('RTCPeerConnection')).toBeLessThan(guarded.indexOf('src="dist/main.js"'));
    expect(HTML_SNAPSHOT_CSP).toContain("connect-src 'self'");
    expect(HTML_SNAPSHOT_CSP).toContain("frame-src 'none'");
    expect(HTML_SNAPSHOT_CSP).not.toMatch(/https?:|\*/);
  });
});
