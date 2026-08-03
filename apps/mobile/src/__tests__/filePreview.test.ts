import { describe, expect, it } from 'vitest';
import {
  describeTextPreviewFailure,
  isTextFilePreviewCandidate,
  nonTextFilePreviewStatusText,
  remoteFilePreviewKind,
  textPreviewStatusText,
  type TextFilePreviewState,
} from '@/session/filePreview';

describe('filePreview', () => {
  it('formats preview status without implying eager file reads', () => {
    expect(textPreviewStatusText({ status: 'idle' }, true)).toContain('按需读取远程文本预览');
    expect(textPreviewStatusText({ status: 'loading' }, true)).toBe('正在从远程电脑读取文本预览');
    expect(textPreviewStatusText({ status: 'ready', data: 'hello', size: 1024 }, true)).toBe('已加载文本预览 · 1.0 KB');
    expect(textPreviewStatusText({ status: 'unavailable', message: 'blocked', size: 0 }, true)).toBe('blocked');
    expect(textPreviewStatusText({ status: 'idle' }, false)).toContain('无法从远程电脑读取预览');
  });

  it('only treats desktop text-like files as remote text preview candidates', () => {
    expect(remoteFilePreviewKind('/repo/notes.md')).toBe('text');
    // `?` / `#` 按真实文件名字符处理,不再当 URL 语法截断(review P1;详见共享层用例)。
    // 原实现把 `report#draft.html` 截成 `report` → unknown → 连文本预览都不给。
    expect(remoteFilePreviewKind('/repo/report#draft.html')).toBe('text');
    expect(remoteFilePreviewKind('/repo/report?v=1.html')).toBe('text');
    expect(remoteFilePreviewKind('/repo/Makefile')).toBe('text');
    expect(remoteFilePreviewKind('/repo/spec.pdf')).toBe('pdf');
    expect(remoteFilePreviewKind('/repo/workflow.drawio')).toBe('drawio');
    expect(remoteFilePreviewKind('/repo/workflow.drawio.svg')).toBe('drawio');
    expect(remoteFilePreviewKind('/repo/sheet.xlsx')).toBe('office');
    expect(remoteFilePreviewKind('/repo/archive.zip')).toBe('binary');
    expect(remoteFilePreviewKind('')).toBe('unknown');
    expect(isTextFilePreviewCandidate('/repo/notes.md')).toBe(true);
    expect(isTextFilePreviewCandidate('/repo/spec.pdf')).toBe(false);
  });

  it('keeps non-text file fallbacks explicit instead of exposing the text-read action', () => {
    expect(nonTextFilePreviewStatusText('pdf')).toContain('PDF 文件暂不在手机版内嵌预览');
    expect(nonTextFilePreviewStatusText('drawio')).toContain('Draw.io 文件暂不在手机版内嵌预览');
    expect(nonTextFilePreviewStatusText('office')).toContain('Office 文件暂不在手机版内嵌预览');
    expect(nonTextFilePreviewStatusText('binary')).toContain('当前文件不是文本格式');
    expect(nonTextFilePreviewStatusText('unknown')).toContain('当前文件类型无法确认');
    expect(textPreviewStatusText({ status: 'idle' }, false, 'pdf')).toContain('PDF 文件暂不在手机版内嵌预览');
    expect(textPreviewStatusText({ status: 'idle' }, false, 'drawio')).toContain('Draw.io 文件暂不在手机版内嵌预览');
  });

  it('keeps remote preview failure reasons actionable', () => {
    expect(describeTextPreviewFailure({
      success: false,
      reason: 'oversize',
      size: 8 * 1024 * 1024,
      limitMb: 5,
    })).toContain('文件超过远程预览上限');
    expect(describeTextPreviewFailure({ success: false, reason: 'forbidden', size: 0 })).toBe('被控电脑拒绝读取这个路径。');
    expect(describeTextPreviewFailure({ success: false, reason: 'not_found', size: 0 })).toBe('被控电脑上没有找到这个文件。');
    expect(describeTextPreviewFailure({ success: false, reason: 'read_failed', size: 0, error: 'EACCES' })).toBe('读取失败: EACCES');
    expect(describeTextPreviewFailure({ success: false, size: 128, error: 'binary file' })).toBe('binary file');
  });

  it('keeps the state union intentionally narrow', () => {
    const state: TextFilePreviewState = { status: 'ready', data: 'ok', size: 2 };
    expect(textPreviewStatusText(state, true)).toContain('已加载文本预览');
  });
});
