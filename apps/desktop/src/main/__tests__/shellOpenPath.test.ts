import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cindy-shell-open-test' },
}));

const { resolveShellOpenPathTarget } = await import('../shellOpenPath.js');

describe('resolveShellOpenPathTarget', () => {
  it('keeps absolute file paths unchanged', () => {
    const target = path.resolve('/tmp', 'recording.ogg');
    expect(resolveShellOpenPathTarget(target)).toBe(target);
  });

  it('normalizes separators to the host form (forward-slash Windows paths)', () => {
    // 正斜杠 Windows 路径过 shell.openPath 会解析失败,必须折成本机分隔符。
    // 仅 win32 主机可直接断言反斜杠;POSIX 上 normalize 幂等。
    if (process.platform === 'win32') {
      expect(resolveShellOpenPathTarget('C:/Users/a/文档.docx')).toBe('C:\\Users\\a\\文档.docx');
    } else {
      expect(resolveShellOpenPathTarget('/tmp/a//b.txt')).toBe('/tmp/a/b.txt');
    }
  });

  it('resolves a valid cindy-media reference inside the main process', () => {
    const hash = 'a'.repeat(64);
    expect(resolveShellOpenPathTarget(`cindy-media://blobs/${hash}.ogg`)).toBe(
      // 实现走 path.resolve;win32 会把 /tmp 前缀解析出盘符,期望值同步用 resolve。
      path.resolve('/tmp/cindy-shell-open-test', 'cindy-media', 'blobs', 'aa', `${hash}.ogg`),
    );
  });

  it('rejects non-path inputs and malformed managed-media references', () => {
    expect(resolveShellOpenPathTarget('https://example.test/file.mp4')).toBeNull();
    expect(() => resolveShellOpenPathTarget('cindy-media://blobs/../../secret.ogg')).toThrow(
      'invalid url',
    );
  });
});
