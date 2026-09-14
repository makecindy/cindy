/**
 * inspectPdfPages 的真文件测试:手搓最小 PDF → 真 pdfjs 解析 → 断言结构判定。
 *
 * 用手写 PDF 而不是二进制 fixture,是为了让「这份 PDF 里到底有什么」在测试里
 * 一眼可读 —— 第 2 页确实一个绘制指令都没有,所以它必须被判成 blank。
 * 这条判定是 cindy_docs 产出自检的地基:整页空白的 PDF 字节数完全正常,
 * 除了回读结构没有别的办法发现。
 */

import { describe, expect, it } from 'vitest';

import {
  inspectPdfPages,
  pageVisibilityUnverified,
  selectPdfPageNumbers,
} from '../reviewPdfUtilityProcess.js';

/**
 * 生成一份合法的最小 PDF。
 * pageSpecs 里每项要么是一段文字(该页画这段文字),要么 null(完全空白页)。
 */
function buildPdf(
  pageSpecs: Array<string | null | { raw: string }>,
  mediaBox = '[0 0 595.28 841.89]',
): Uint8Array {
  const objs: string[] = [];
  const push = (body: string): number => {
    objs.push(body);
    return objs.length; // 1-based object number
  };

  const pageNums: number[] = [];

  // 先占掉 1(Catalog)与 2(Pages),内容最后回填 —— 它们要引用后面对象的编号。
  push('');
  push('');
  const font = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  for (const spec of pageSpecs) {
    if (spec === null) {
      pageNums.push(
        push(`<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox} /Resources << >> >>`),
      );
      continue;
    }
    const stream = typeof spec === 'string' ? `BT /F1 24 Tf 72 760 Td (${spec}) Tj ET` : spec.raw;
    const contentNum = push(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
    pageNums.push(
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox} ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentNum} 0 R >>`,
      ),
    );
  }

  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] =
    `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] ` +
    `/Count ${pageNums.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, index) => {
    offsets[index] = out.length;
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

describe('inspectPdfPages', () => {
  it('声明极大页数时只构造 maxPages 个默认页码', () => {
    expect(selectPdfPageNumbers(Number.MAX_SAFE_INTEGER, [], 3)).toEqual([1, 2, 3]);
    expect(selectPdfPageNumbers(100, [99, 2, 2, 101, 1], 2)).toEqual([1, 2]);
  });

  it('读出页数、尺寸、文本量,并把真正空白的页判成 blank', async () => {
    const pdf = buildPdf(['Hello Cindy Docs', null]);
    const result = await inspectPdfPages(pdf, [], 10, 400);

    expect(result.numPages).toBe(2);
    expect(result.pagesInspected).toBe(2);

    const [first, second] = result.pages;
    expect(first!.page).toBe(1);
    expect(Math.round(first!.width)).toBe(595);
    expect(Math.round(first!.height)).toBe(842);
    expect(first!.rotation).toBe(0);
    expect(first!.textChars).toBe('Hello Cindy Docs'.length);
    expect(first!.textPreview).toContain('Hello Cindy Docs');
    expect(first!.blank).toBe(false);

    // 第 2 页没有 Contents,任何绘制指令都没有 —— 这就是「打开是白的」那种页。
    expect(second!.textChars).toBe(0);
    expect(second!.drawOps).toBe(0);
    expect(second!.imageOps).toBe(0);
    expect(second!.blank).toBe(true);
  });

  it('按页码挑页,越界页码被丢掉而不是报错', async () => {
    const pdf = buildPdf(['one', 'two', 'three']);
    const result = await inspectPdfPages(pdf, [3, 1, 99], 10, 400);
    expect(result.numPages).toBe(3);
    // 去重 + 升序,越界的 99 被丢弃
    expect(result.pages.map((p) => p.page)).toEqual([1, 3]);
    expect(result.pages[1]!.textPreview).toContain('three');
  });

  it('只含图形状态与变换控制算子的页面仍判为空白', async () => {
    const pdf = buildPdf([{ raw: 'q 1 0 0 1 0 0 cm Q' }]);
    const result = await inspectPdfPages(pdf, [], 10, 100);
    expect(result.pages[0]).toMatchObject({ textChars: 0, drawOps: 0, imageOps: 0, blank: true });
  });

  it('算子表解析失败时把空文本页标记为未验证', () => {
    expect(pageVisibilityUnverified(0, null, null)).toBe(true);
    expect(pageVisibilityUnverified(0, 0, 0)).toBe(false);
    expect(pageVisibilityUnverified(12, 3, 0)).toBe(false);
  });

  it('maxPages 卡住检查页数,不会把整份文档读完', async () => {
    const pdf = buildPdf(['a', 'b', 'c', 'd', 'e']);
    const result = await inspectPdfPages(pdf, [], 2, 400);
    expect(result.numPages).toBe(5);
    expect(result.pagesInspected).toBe(2);
    expect(result.pages.map((p) => p.page)).toEqual([1, 2]);
  });

  it('previewChars 截断文本预览', async () => {
    const pdf = buildPdf(['abcdefghijklmnop']);
    const result = await inspectPdfPages(pdf, [], 10, 5);
    expect(result.pages[0]!.textPreview).toHaveLength(5);
    // 截断的是预览,字符总数仍然是真实值
    expect(result.pages[0]!.textChars).toBe(16);
  });

  it('非 A4 尺寸如实报出来(供上层判断 pageSize 是不是传错了)', async () => {
    const pdf = buildPdf(['x'], '[0 0 612 792]');
    const result = await inspectPdfPages(pdf, [], 10, 100);
    expect(Math.round(result.pages[0]!.width)).toBe(612);
    expect(Math.round(result.pages[0]!.height)).toBe(792);
  });

  it('损坏的 PDF 抛错而不是返回一份"看起来正常"的空结果', async () => {
    await expect(
      inspectPdfPages(new Uint8Array(Buffer.from('not a pdf at all')), [], 10, 100),
    ).rejects.toThrow();
  });
});
