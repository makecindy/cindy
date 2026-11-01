import { describe, expect, it } from 'vitest';

import { chatFileChipMenuRows, chatFileChipMenuTitle } from '@/session/chatFileChipMenuModel';
import type { ChatFilePathTarget } from '@/session/chatFilePathContext';

const file: ChatFilePathTarget = { kind: 'file', relPath: 'src/App.tsx', absPath: '/w/src/App.tsx', line: 42 };
const dir: ChatFilePathTarget = { kind: 'directory', relPath: 'src/components', absPath: '/w/src/components' };
/** workdir 外文件:relPath 为 null,动作走 absPath 通道。 */
const outsideFile: ChatFilePathTarget = { kind: 'file', relPath: null, absPath: '/tmp/cindy-web-hero.png' };

describe('chatFileChipMenuModel', () => {
  it('标题取 basename', () => {
    expect(chatFileChipMenuTitle(file)).toBe('App.tsx');
    expect(chatFileChipMenuTitle(dir)).toBe('components');
    expect(chatFileChipMenuTitle({ kind: 'file', relPath: 'a.md', absPath: '/w/a.md' })).toBe('a.md');
  });

  it('workdir 外文件标题取 absPath basename(含 Windows 反斜杠形态)', () => {
    expect(chatFileChipMenuTitle(outsideFile)).toBe('cindy-web-hero.png');
    expect(chatFileChipMenuTitle({ kind: 'file', relPath: null, absPath: 'C:\\tmp\\shot.png' })).toBe('shot.png');
  });

  it('文件动作集:预览 / 文件浏览器查看 / 发送 / 复制 / 分享', () => {
    expect(chatFileChipMenuRows(file, 'ios').map((r) => r.key)).toEqual([
      'open',
      'revealInBrowser',
      'sendToSession',
      'copyPath',
      'share',
    ]);
  });

  it('目录动作集:无预览/分享,打开即文件浏览器', () => {
    expect(chatFileChipMenuRows(dir, 'ios').map((r) => r.key)).toEqual([
      'open',
      'sendToSession',
      'copyPath',
    ]);
  });

  it('workdir 外文件动作集:无「在文件浏览器中查看」(定位不到外部路径)', () => {
    expect(chatFileChipMenuRows(outsideFile, 'ios').map((r) => r.key)).toEqual([
      'open',
      'sendToSession',
      'copyPath',
      'share',
    ]);
  });

  it('Android 的 PDF 不给「快速预览」(WebView 不渲染 PDF),仍可分享', () => {
    const pdf: ChatFilePathTarget = { kind: 'file', relPath: 'documents/报告.PDF', absPath: '/w/documents/报告.PDF' };
    expect(chatFileChipMenuRows(pdf, 'android').map((r) => r.key)).toEqual([
      'revealInBrowser',
      'sendToSession',
      'copyPath',
      'share',
    ]);
    expect(chatFileChipMenuRows(pdf, 'ios')[0]?.key).toBe('open');
    // 非 PDF 文件在 Android 上照常预览。
    expect(chatFileChipMenuRows(file, 'android')[0]?.key).toBe('open');
  });
});
