/**
 * cindy_docs 美观默认值:PPT 母版版式、Word 封面/标题层级/表格、Excel 色带/
 * 斑马纹/数字格式、PDF 无样式 HTML 套模板。真文件往返,不起 Electron。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCindyDocsMcpServer } from '../cindy_docsMcpServer.js';
import { PPTX_LAYOUT_IDS, PPTX_THEMES } from '../cindy-docs/make_pptx.js';
import { layoutSlots } from '../cindy-docs/pptxMasters.js';
import { applyReportTemplate, htmlLooksUnstyled } from '../cindy-docs/pdfTemplate.js';
import { DOCS_THEMES, formatDocsDate, themeToArgb } from '../cindy-docs/themes.js';
import type { DocsMcpDeps, DocsMcpSessionCtx, DocsPdfRenderInput } from '../cindy-docs/types.js';

let workdir: string;
const created: string[] = [];

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-docs-defaults-'));
  created.push(workdir);
});

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function sessionCtx(overrides: Partial<DocsMcpSessionCtx> = {}): DocsMcpSessionCtx {
  return {
    agentKind: 'claude-code',
    workingDir: workdir,
    sessionId: 'sess-defaults',
    ...overrides,
  };
}

async function connect(deps: DocsMcpDeps = {}, ctx = sessionCtx()) {
  const server = createCindyDocsMcpServer(deps, ctx);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'docs-defaults-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  return client;
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return payload(await client.callTool({ name: 'call_tool', arguments: { name, args } }));
}

async function unzip(file: string, entry: string): Promise<string> {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const found = zip.file(entry);
  if (!found) throw new Error(`missing ${entry}; have ${Object.keys(zip.files).join(',')}`);
  return found.async('string');
}

async function unzipAll(file: string, predicate: (name: string) => boolean): Promise<string> {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const parts: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (!predicate(name)) continue;
    const found = zip.file(name);
    if (found) parts.push(await found.async('string'));
  }
  return parts.join('\n');
}

describe('PPT 母版版式', () => {
  it('layoutSlots 封面/分节/内容页几何互不相同,有图时正文收窄', () => {
    const cover = layoutSlots('cover', { hasImage: false, hasSubtitle: true });
    const section = layoutSlots('section', { hasImage: false, hasSubtitle: false });
    const content = layoutSlots('content', { hasImage: false, hasSubtitle: false });
    const split = layoutSlots('content', { hasImage: true, hasSubtitle: false });

    expect(cover.title.fontSize).toBeGreaterThan(section.title.fontSize);
    expect(section.title.fontSize).toBeGreaterThan(content.title.fontSize);
    expect(content.accentLine).toBeDefined();
    expect(cover.accentLine).toBeUndefined();
    expect(split.body.w).toBeLessThan(content.body.w);
    expect(split.image).toBeDefined();
  });

  it('三套版式写入母版,封面无页码,内容页有页码和页脚标签', async () => {
    const client = await connect();
    const result = await callTool(client, 'make_pptx', {
      title: 'Q3 经营回顾',
      theme: 'navy',
      slides: [
        { title: 'Q3 经营回顾', layout: 'cover', subtitle: '华东区 · 内部汇报' },
        { title: '增长从哪里来', layout: 'section' },
        { title: '结论先行', layout: 'content', bullets: ['续约拉动', '新品尚未放量'] },
      ],
      outPath: 'deck.pptx',
    });
    expect(result.ok).toBe(true);
    expect(result.theme).toBe('navy');
    expect(result.layouts).toEqual(['cover', 'section', 'content']);
    expect(result.footer).toBe(true);

    const layouts = await unzipAll(
      result.path as string,
      (name) => name.startsWith('ppt/slideLayouts/') && name.endsWith('.xml'),
    );
    expect(layouts).toContain(PPTX_LAYOUT_IDS.cover);
    expect(layouts).toContain(PPTX_LAYOUT_IDS.section);
    expect(layouts).toContain(PPTX_LAYOUT_IDS.content);

    const slide1 = await unzip(result.path as string, 'ppt/slides/slide1.xml');
    expect(slide1).toContain('Q3 经营回顾');
    expect(slide1).toContain('华东区');
    expect(slide1).toContain(PPTX_THEMES.navy.background);
    // 封面标题字号 40pt = DrawingML 4000
    expect(slide1).toContain('4000');

    expect(layouts).toContain(PPTX_THEMES.navy.accent);
    expect(layouts).toContain('Q3 经营回顾');
    // pptxgenjs 把页码写成 type="slidenum" 字段;母版上的 hf sldNum="0" 只是关闭位,不算。
    expect(layouts).toMatch(/type="slidenum"/);
  });

  it('footer:false 时母版不登记页码', async () => {
    const client = await connect();
    const result = await callTool(client, 'make_pptx', {
      footer: false,
      slides: [{ title: '只有内容', layout: 'content', bullets: ['一条'] }],
      outPath: 'no-footer.pptx',
    });
    expect(result.ok).toBe(true);
    expect(result.footer).toBe(false);
    const layouts = await unzipAll(
      result.path as string,
      (name) => name.startsWith('ppt/slideLayouts/') && name.endsWith('.xml'),
    );
    expect(layouts).not.toMatch(/type="slidenum"/);
  });
});

describe('Word 封面 / 标题层级 / 表格', () => {
  it('给了 title 就出独立封面,标题层级和表格色带写进 styles / 表格 XML', async () => {
    const client = await connect();
    const result = await callTool(client, 'make_docx', {
      title: '季度经营回顾',
      subtitle: '内部稿',
      theme: 'navy',
      markdown: [
        '# 摘要',
        '',
        '正文一段。',
        '',
        '## 明细',
        '',
        '| 区域 | 收入 |',
        '|---|--:|',
        '| 华东 | 1200 |',
        '| 华南 | 860 |',
      ].join('\n'),
      outPath: 'report.docx',
    });
    expect(result.ok).toBe(true);
    expect(result.cover).toBe(true);
    expect(result.theme).toBe('navy');

    const documentXml = await unzip(result.path as string, 'word/document.xml');
    expect(documentXml).toContain('季度经营回顾');
    expect(documentXml).toContain('内部稿');
    expect(documentXml).toContain(formatDocsDate());
    expect(documentXml).toContain('摘要');
    // 封面是独立节,后面正文另起一节
    expect(documentXml.match(/<w:sectPr[\s>]/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

    const stylesXml = await unzip(result.path as string, 'word/styles.xml');
    expect(stylesXml).toContain('Heading1');
    expect(stylesXml).toContain('Heading2');
    expect(stylesXml).toContain(DOCS_THEMES.navy.title);
    expect(stylesXml).toContain(DOCS_THEMES.navy.accent);

    // 表头色带用强调色,斑马纹落在第二行数据
    expect(documentXml).toContain(DOCS_THEMES.navy.accent);
    expect(documentXml).toContain(DOCS_THEMES.navy.zebra);
  });

  it('cover:false 时 title 仍作正文标题段,不另起封面节', async () => {
    const client = await connect();
    const result = await callTool(client, 'make_docx', {
      title: '无封面',
      cover: false,
      markdown: '只有一段。',
      outPath: 'plain.docx',
    });
    expect(result.ok).toBe(true);
    expect(result.cover).toBe(false);
    const documentXml = await unzip(result.path as string, 'word/document.xml');
    expect(documentXml).toContain('无封面');
    expect(documentXml.match(/<w:sectPr[\s>]/g)?.length ?? 0).toBe(1);
  });
});

describe('Excel 表头色带 / 斑马纹 / 数字格式', () => {
  it('表头用强调色、奇数数据行打斑马纹、整数列带千分位', async () => {
    const client = await connect();
    const result = await callTool(client, 'make_xlsx', {
      theme: 'navy',
      sheets: [
        {
          name: '明细',
          header: ['区域', '收入', '占比'],
          rows: [
            ['华东', 1200, 0.18],
            ['华南', 860, 0.12],
            ['华北', 2040, 0.3],
          ],
        },
      ],
      outPath: 'pretty.xlsx',
    });
    expect(result.ok).toBe(true);
    expect(result.theme).toBe('navy');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.path as string);
    const ws = wb.getWorksheet('明细')!;
    const headerFill = ws.getRow(1).getCell(1).fill as { fgColor?: { argb?: string } };
    expect(headerFill.fgColor?.argb).toBe(themeToArgb(DOCS_THEMES.navy.accent));
    expect(ws.getRow(1).font?.color?.argb).toBe(themeToArgb(DOCS_THEMES.navy.accentOn));

    const zebra = ws.getRow(3).getCell(1).fill as { fgColor?: { argb?: string } };
    expect(zebra.fgColor?.argb).toBe(themeToArgb(DOCS_THEMES.navy.zebra));
    const even = ws.getRow(2).getCell(1).fill as { fgColor?: { argb?: string } } | undefined;
    expect(even?.fgColor?.argb ?? '').not.toBe(themeToArgb(DOCS_THEMES.navy.zebra));

    expect(ws.getColumn(2).numFmt).toBe('#,##0');
    expect(ws.getColumn(3).numFmt).toMatch(/%/);
  });

  it('zebra:false 时不打斑马纹', async () => {
    const client = await connect();
    const result = await callTool(client, 'make_xlsx', {
      zebra: false,
      sheets: [{ name: 'S', header: ['a'], rows: [[1], [2]] }],
      outPath: 'plain.xlsx',
    });
    expect(result.ok).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.path as string);
    const fill = wb.getWorksheet('S')!.getRow(3).getCell(1).fill as
      | { fgColor?: { argb?: string } }
      | undefined;
    expect(fill?.fgColor?.argb ?? '').not.toBe(themeToArgb(DOCS_THEMES.light.zebra));
  });
});

describe('PDF 无样式 HTML 套报告模板', () => {
  it('htmlLooksUnstyled 只在没有 stylesheet 时为真', () => {
    expect(htmlLooksUnstyled('<h1>hi</h1>')).toBe(true);
    expect(htmlLooksUnstyled('<style>h1{color:red}</style><h1>hi</h1>')).toBe(false);
    expect(
      htmlLooksUnstyled('<link rel="stylesheet" href="a.css"><h1>hi</h1>'),
    ).toBe(false);
    const wrapped = applyReportTemplate('<h1>hi</h1>', DOCS_THEMES.light);
    expect(wrapped.applied).toBe(true);
    expect(wrapped.html).toContain('data-cindy-docs-template="report"');
    expect(applyReportTemplate(wrapped.html, DOCS_THEMES.light).applied).toBe(false);
  });

  it('render_pdf 对无样式 HTML 自动套模板,已有 style 的原样透传', async () => {
    const seen: DocsPdfRenderInput[] = [];
    const pdfBytes = Buffer.from(`%PDF-1.7\n${'x'.repeat(4096)}\n%%EOF`);
    const client = await connect({
      renderHtmlToPdf: async (input) => {
        seen.push(input);
        return { buffer: pdfBytes, fontsReady: true };
      },
    });

    const auto = await callTool(client, 'render_pdf', {
      html: '<h1>季度回顾</h1><p>正文</p>',
      outPath: 'auto.pdf',
    });
    expect(auto.ok).toBe(true);
    expect(auto.templateApplied).toBe(true);
    expect(seen[0]!.html).toContain('data-cindy-docs-template="report"');
    expect(seen[0]!.html).toContain('季度回顾');
    // 套模板后由 CSS @page 管边距,Electron 边距归零避免双边距
    expect(seen[0]!.margins).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });

    const styled = await callTool(client, 'render_pdf', {
      html: '<style>h1{color:red}</style><h1>已有样式</h1>',
      outPath: 'styled.pdf',
    });
    expect(styled.ok).toBe(true);
    expect(styled.templateApplied).toBe(false);
    expect(seen[1]!.html).toBe('<style>h1{color:red}</style><h1>已有样式</h1>');
    expect(seen[1]!.margins).toEqual({ top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 });
  });

  it('template:none 跳过套模板;用户显式 margins 优先生效', async () => {
    const seen: DocsPdfRenderInput[] = [];
    const pdfBytes = Buffer.from(`%PDF-1.7\n${'x'.repeat(4096)}\n%%EOF`);
    const client = await connect({
      renderHtmlToPdf: async (input) => {
        seen.push(input);
        return { buffer: pdfBytes, fontsReady: true };
      },
    });
    const skipped = await callTool(client, 'render_pdf', {
      html: '<h1>hi</h1>',
      outPath: 'none.pdf',
      template: 'none',
    });
    expect(skipped.templateApplied).toBe(false);
    expect(seen[0]!.html).toBe('<h1>hi</h1>');

    const custom = await callTool(client, 'render_pdf', {
      html: '<h1>hi</h1>',
      outPath: 'margins.pdf',
      margins: { top: 1, bottom: 1, left: 0.5, right: 0.5 },
    });
    expect(custom.templateApplied).toBe(true);
    expect(seen[1]!.margins).toEqual({ top: 1, bottom: 1, left: 0.5, right: 0.5 });
  });
});
