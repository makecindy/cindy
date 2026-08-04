import { describe, expect, it } from 'vitest';
import {
  describeTextPreviewFailure,
  isHtmlFilePreviewCandidate,
  isTextFilePreviewCandidate,
  nonTextFilePreviewStatusText,
  remoteFilePreviewKind,
  textPreviewStatusText,
  type TextFilePreviewState,
} from '../filePreview.js';

describe('file preview shared model', () => {
  it('formats preview status without implying eager file reads', () => {
    expect(textPreviewStatusText({ status: 'idle' }, true)).toContain('按需读取远程文本预览');
    expect(textPreviewStatusText({ status: 'loading' }, true)).toBe('正在从远程电脑读取文本预览');
    expect(textPreviewStatusText({ status: 'ready', data: 'hello', size: 1024 }, true)).toBe('已加载文本预览 · 1.0 KB');
    expect(textPreviewStatusText({ status: 'unavailable', message: 'blocked', size: 0 }, true)).toBe('blocked');
    expect(textPreviewStatusText({ status: 'idle' }, false)).toContain('无法从远程电脑读取预览');
  });

  it('marks HTML generated artifacts as render-first previews without leaving the text channel', () => {
    // 桌面端点开 HTML 就进浏览器渲染;手机端此前只能看源码,因为 HTML 落在
    // SUPPORTED_TEXT_EXTS 里、预览页按文本分派。渲染判定单列一处,不动 'text' 结论。
    expect(isHtmlFilePreviewCandidate('/repo/report.html')).toBe(true);
    expect(isHtmlFilePreviewCandidate('/repo/report.htm')).toBe(true);
    expect(isHtmlFilePreviewCandidate('/repo/REPORT.HTML')).toBe(true);
    // 取字节仍走文本通道:两个判定同时为真,源码态与内容搜索不受影响。
    expect(isTextFilePreviewCandidate('/repo/report.html')).toBe(true);
    expect(remoteFilePreviewKind('/repo/report.html')).toBe('text');

    expect(isHtmlFilePreviewCandidate('/repo/notes.md')).toBe(false);
    expect(isHtmlFilePreviewCandidate('/repo/index.html.bak')).toBe(false);
    expect(isHtmlFilePreviewCandidate('/repo/archive.zip')).toBe(false);
    expect(isHtmlFilePreviewCandidate('')).toBe(false);
    // `.xhtml` 刻意排除(review P1):手机的 WebView 只能按 text/html 加载,合法 XHTML
    // 会被 HTML parser 曲解成白屏。它仍是文本 → 退化成源码态,内容照样可读。
    expect(isHtmlFilePreviewCandidate('/repo/page.xhtml')).toBe(false);
    expect(isTextFilePreviewCandidate('/repo/page.xhtml')).toBe(true);
  });

  it('入参只吃真实文件名,`?` / `#` 一律按合法字符处理(review P2)', () => {
    // 契约收成一种语义后不再有启发式:扩展名就是最后一个点之后的东西。
    // `.txt` 结尾的不进可执行 WebView。
    expect(isHtmlFilePreviewCandidate('/repo/notes.html#readme.txt')).toBe(false);
    // 名字里带 `?` / `#` 且**不以** HTML 扩展名结尾的同样不进 —— 前两版都在这里放行过
    // (fail-closed:少一次渲染,不会多一次执行)。
    expect(isHtmlFilePreviewCandidate('/repo/report.html?draft')).toBe(false);
    expect(isHtmlFilePreviewCandidate('/repo/report.htm#notes')).toBe(false);
    // 确实以 HTML 扩展名结尾的照常进,名字中段有 `?` / `#` 不影响。
    expect(isHtmlFilePreviewCandidate('/repo/report#draft.html')).toBe(true);
    expect(isHtmlFilePreviewCandidate('/repo/report?v=1.html')).toBe(true);
    // 同理不做 trim:尾随空白 / 制表符在 macOS / Linux 上都是合法文件名的一部分,
    // 归一化掉会让它们冒充 HTML 扩展名(review P1)。
    expect(isHtmlFilePreviewCandidate('/repo/report.html ')).toBe(false);
    expect(isHtmlFilePreviewCandidate('/repo/payload.htm\t')).toBe(false);
    expect(isHtmlFilePreviewCandidate('/repo/report.html')).toBe(true);
    // 尾随**反斜杠**同理(review P1 第二轮):它在 macOS / Linux 上是合法文件名字符,
    // 而 basenameRemotePath 的 stripTrailingPathSeparators 会把它削掉、让文件冒充 .html。
    // 现在按分隔符切最后一段但不削尾 → 最后一段为空 → false。
    expect(isHtmlFilePreviewCandidate('/repo/report.html\\')).toBe(false);
    expect(isHtmlFilePreviewCandidate('report.html\\')).toBe(false);
    // 目录形态同样不进渲染态。
    expect(isHtmlFilePreviewCandidate('/repo/report.html/')).toBe(false);
    // Windows 路径的正常形态照旧。
    expect(isHtmlFilePreviewCandidate('C:\\proj\\report.html')).toBe(true);
  });

  it('入参按真实文件名处理,`?` / `#` 不再被当 URL 语法截断(review P1)', () => {
    // 原实现先 split(/[?#]/)[0],于是 macOS / Linux 上合法的 `report#draft.html` 被截成
    // `report` → 无扩展名 → 判 unknown,**连文本预览都不给**。全部 7 个调用方传的都是
    // 真实文件名 / 路径,没有一个传 URL,所以那份截断没有真实需求。
    expect(remoteFilePreviewKind('/repo/report#draft.html')).toBe('text');
    expect(remoteFilePreviewKind('/repo/report?v=1.html')).toBe('text');
    // 与渲染态判定对齐:这两个名字既能读文本,也能进渲染态(上游分派不再拦住它们)。
    expect(isHtmlFilePreviewCandidate('/repo/report#draft.html')).toBe(true);
    expect(isHtmlFilePreviewCandidate('/repo/report?v=1.html')).toBe(true);
    // 反过来:名字里带 `?` / `#` 但**不以**已知扩展名结尾的,现在按真实扩展名判(不再截断后误判)。
    expect(remoteFilePreviewKind('/repo/notes.html#readme.txt')).toBe('text'); // .txt 也是文本
    expect(remoteFilePreviewKind('/repo/data.zip?x=1')).toBe('binary');
  });

  it('only treats desktop text-like files as remote text preview candidates', () => {
    expect(remoteFilePreviewKind('/repo/notes.md')).toBe('text');
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
