import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cindy-shell-open-test' },
}));

const { isLocalOriginalForPluginOpen, resolveLocalOriginalForPluginOpen, resolveShellOpenPathTarget } = await import('../shellOpenPath.js');

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

  // #8726: `/D:/x` 是盘符路径的 URI pathname 写法;不剥离时 normalize 产出
  // 当前盘下的非法 `\D:\x`,shell.openPath 必败。注入平台 + path.win32 模拟
  // Windows 语义(engineering-conventions §3.3),不靠 mock process.platform。
  it('strips the URI-pathname slash on a Windows drive path (injected win32)', () => {
    expect(resolveShellOpenPathTarget('/D:/Java', 'win32')).toBe('D:\\Java');
    expect(resolveShellOpenPathTarget('/d:/a/b 文档.txt', 'win32')).toBe('d:\\a\\b 文档.txt');
    // 裸盘符归一到盘根目录:目录链接尾斜杠被剥落后以 /D: 到达
    expect(resolveShellOpenPathTarget('/D:', 'win32')).toBe('D:\\');
    // UNC 与 POSIX 形态不受影响
    expect(resolveShellOpenPathTarget('//server/share/x.txt', 'win32')).toBe(
      '\\\\server\\share\\x.txt',
    );
  });

  it('keeps a /D: root directory name untouched on POSIX hosts', () => {
    expect(resolveShellOpenPathTarget('/D:/Java', 'linux')).toBe('/D:/Java');
    expect(resolveShellOpenPathTarget('/D:/Java', 'darwin')).toBe('/D:/Java');
    expect(resolveShellOpenPathTarget('/D:', 'linux')).toBe('/D:');
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

/*
 * 测试价值
 * - 生产入口与可观察结果：isLocalOriginalForPluginOpen 决定 shell:open-path 是否先把文件交给声明了
 *   fileOpener 的插件；为 false 时照旧交给系统默认应用。
 * - 规则依据：其它电脑文件的缓存副本不能交给插件改（改动回不到原电脑）；媒体库文件同理。
 * - 现有覆盖缺口：新判定。
 * - 最小失败输入：大小写不同的远程缓存路径；只共享前缀的同级目录。
 * - tier：unit（注入 win32 路径语义，纯函数）。
 */
describe('isLocalOriginalForPluginOpen', () => {
  const roots = [
    'C:\\Users\\a\\AppData\\Roaming\\Cindy\\remote-file-cache',
    'C:\\Users\\a\\AppData\\Roaming\\Cindy\\chat-attachment-cache',
  ];
  it.each([
    ['a local original', 'C:\\work\\a.docx', 'C:\\work\\a.docx', true],
    ['a remote-file cache copy in another letter case', 'c:\\users\\a\\appdata\\roaming\\cindy\\Remote-File-Cache\\x-a.docx',
      'c:\\users\\a\\appdata\\roaming\\cindy\\Remote-File-Cache\\x-a.docx', false],
    ['a chat attachment cache copy', 'C:\\Users\\a\\AppData\\Roaming\\Cindy\\chat-attachment-cache\\o\\a.bin',
      'C:\\Users\\a\\AppData\\Roaming\\Cindy\\chat-attachment-cache\\o\\a.bin', false],
    ['a managed media reference', 'cindy-media://blobs/abc.docx', 'C:\\data\\blobs\\abc.docx', false],
    ['a sibling folder sharing only a prefix', 'C:\\Users\\a\\AppData\\Roaming\\Cindy\\remote-file-cache-old\\a.docx',
      'C:\\Users\\a\\AppData\\Roaming\\Cindy\\remote-file-cache-old\\a.docx', true],
  ])('%s', (_label, input, resolved, expected) => {
    expect(isLocalOriginalForPluginOpen(input, resolved, roots, 'win32')).toBe(expected);
  });
});

// An alias must not make a managed copy eligible for plugin delivery.
it('rejects a file whose resolved target is inside a relocated cache root', async () => {
  const file = path.resolve('workspace', 'document.docx');
  const cache = path.resolve('data', 'remote-cache');
  const cacheTarget = path.resolve('relocated-cache');
  const target = path.join(cacheTarget, 'document.docx');
  const stat = vi.fn(async () => ({ isFile: () => true }));
  await expect(resolveLocalOriginalForPluginOpen(file, file, [cache], () => true, {
    realpath: async (entry) => entry === file ? target : cacheTarget,
    stat,
  })).resolves.toBeNull();
  expect(stat).not.toHaveBeenCalled();
});
