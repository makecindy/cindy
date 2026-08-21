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
import { columnPercents } from '../cindy-docs/docxStyles.js';
import { inferNumberFormat, isSummaryRow } from '../cindy-docs/make_xlsx.js';
import { PPTX_LAYOUT_IDS, PPTX_THEMES } from '../cindy-docs/make_pptx.js';
import { layoutSlots, SLIDE_H, SLIDE_W } from '../cindy-docs/pptxMasters.js';
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
  // 六个文档工具是顶层直接注册的,不再经 call_tool 二级分派(2026-08-21 改)。
  return payload(await client.callTool({ name, arguments: args }));
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
    // 封面也有强调短线了(2026-08-22):原来封面除了一根细竖条什么都没有,
    // 目检下来就是「白底加几行字」。
    expect(cover.accentLine).toBeDefined();
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
    // 封面标题字号 44pt = DrawingML 4400(2026-08-22 从 40pt 放大:封面通栏只有
    // 一行字,40pt 在实机目检里显得又小又散)。
    expect(slide1).toContain('4400');

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
    expect(documentXml).toContain('摘要');
    // 封面是独立节,后面正文另起一节
    expect(documentXml.match(/<w:sectPr[\s>]/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

    /*
      日期在**封面页脚**里,不在正文流里。原来它跟在标题下面,靠段间距悬在半空,
      标题一长就跟着往下挪、位置永远不稳;现在沉到页脚才真的贴着页底。
      这里断言的是位置,不只是「出现过」—— 只查 document.xml 含不含日期,
      恰恰是搬回正文流也能通过的那种弱断言。
    */
    expect(documentXml).not.toContain(formatDocsDate());
    const coverFooter = await unzip(result.path as string, 'word/footer1.xml');
    expect(coverFooter).toContain(formatDocsDate());

    // 封面顶部那条实心强调带:用段落底纹画,不是边框 —— 边框只有线,填不出面积。
    expect(documentXml).toContain(`<w:shd w:fill="${DOCS_THEMES.navy.accent}"`);

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

/**
 * 版面尺寸必须与 pptxMasters 的几何常量一致。
 *
 * 曾经不一致:layout 用了 pptxgenjs 的 'LAYOUT_16x9'(10" × 5.625"),几何却按
 * 13.333" × 7.5" 写 —— 页脚和页码定位在 y=7.02,整个落在页面外,**从来没显示过**,
 * 正文框也伸出页底。这条只比对数字,不依赖任何人肉目检。
 */
describe('页面尺寸与几何常量对齐', () => {
  const EMU = 914400;

  it('生成的 pptx 页面尺寸就是 SLIDE_W × SLIDE_H', async () => {
    const client = await connect();
    const result = await callTool(client, 'make_pptx', {
      slides: [{ title: '页面尺寸', layout: 'content', bullets: ['一条'] }],
      outPath: 'size.pptx',
    });
    const xml = await unzip(result.path as string, 'ppt/presentation.xml');
    const size = xml.match(/<p:sldSz[^>]*>/)![0];
    expect(Number(size.match(/cx="(\d+)"/)![1]) / EMU).toBeCloseTo(SLIDE_W, 2);
    expect(Number(size.match(/cy="(\d+)"/)![1]) / EMU).toBeCloseTo(SLIDE_H, 2);
  });

  it('母版上的每个形状都落在页面之内(页脚页码不许跑到页外)', async () => {
    const client = await connect();
    const result = await callTool(client, 'make_pptx', {
      title: '页脚检查',
      slides: [{ title: '页脚', layout: 'content', bullets: ['一条'] }],
      outPath: 'footer.pptx',
    });
    const layouts = await unzipAll(
      result.path as string,
      (name) => name.startsWith('ppt/slideLayouts/') && name.endsWith('.xml'),
    );
    for (const m of layouts.matchAll(
      /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g,
    )) {
      const y = Number(m[2]) / EMU;
      const h = Number(m[4]) / EMU;
      if (h === 0) continue; // pptxgenjs 写的空组占位
      expect(y + h).toBeLessThanOrEqual(SLIDE_H + 0.01);
    }
  });
});

/*
 * 下面三组只比数字,不靠人眼 —— 每一条都对应一个目检真看出来、而「XML 里有这个
 * 字符串」那种自检永远看不出来的毛病。
 */
describe('表格与版式的数值不变量', () => {
  it('单字「率」也要认成百分比列 —— 工具描述承诺过', () => {
    // 这条就是目检里那一列显示 0.03 而不是 3.3% 的直接原因:老正则写的是「比率」,
    // 于是「退款率」「转化率」「完成率」这些最常见的百分比表头一个都匹配不上。
    for (const header of ['退款率', '转化率', '完成率', '占比', '毛利率 %', 'Refund rate']) {
      expect(inferNumberFormat(header, [0.0325, 0.064])).toBe('0.0%');
    }
    // 大于 1 的「率」不套百分号:汇率、频率这类不是占比。
    expect(inferNumberFormat('汇率', [7.12, 7.3])).toBe('#,##0.00');
    // 没有语义信号的整数列照旧走千分位。
    expect(inferNumberFormat('订单数', [1284, 3921])).toBe('#,##0');
  });

  it('汇总行按结构判定 —— 公式占多数,不查「合计 / Total」词表', () => {
    const f = (formula: string) => ({ formula, result: 1 });
    expect(isSummaryRow(['合计', '', f('SUM(A1:A9)'), f('SUM(B1:B9)')])).toBe(true);
    // 换任何语言都成立:判据是「这一行的数是算出来的」,不是它叫什么。
    expect(isSummaryRow(['Gesamt', f('SUM(A1:A9)'), f('SUM(B1:B9)')])).toBe(true);
    // 普通数据行不算,哪怕里面夹了一个计算列。
    expect(isSummaryRow(['7月', '直营门店', 1284, 986400, f('D2-E2')])).toBe(false);
    expect(isSummaryRow([])).toBe(false);
  });

  it('表格列宽按内容分,且总和仍是 100%', () => {
    // 「严重度」放两个字,「建议」放一整句 —— 等分会让一边空一片、一边挤三行。
    const pcts = columnPercents([8, 12, 6, 24]);
    expect(pcts.length).toBe(4);
    expect(Math.round(pcts.reduce((a, b) => a + b, 0))).toBe(100);
    // 内容多的列必须比内容少的列宽。
    expect(pcts[3]).toBeGreaterThan(pcts[2]!);
    expect(pcts[1]).toBeGreaterThan(pcts[2]!);
    // 极端值不许把某一列压到没法看。
    const extreme = columnPercents([1, 1, 400]);
    expect(Math.min(...extreme)).toBeGreaterThanOrEqual(7.9);
    expect(Math.round(extreme.reduce((a, b) => a + b, 0))).toBe(100);
  });

  it('斑马纹必须和底色拉开肉眼可辨的差', () => {
    // 原来 light/navy 的斑马纹与白底只差 2%,整张表看不出隔行 —— 打了等于没打。
    const lum = (hex: string) =>
      parseInt(hex.slice(0, 2), 16) * 0.299 +
      parseInt(hex.slice(2, 4), 16) * 0.587 +
      parseInt(hex.slice(4, 6), 16) * 0.114;
    for (const name of ['light', 'dark', 'navy'] as const) {
      const t = DOCS_THEMES[name];
      expect(Math.abs(lum(t.background) - lum(t.zebra))).toBeGreaterThan(6);
    }
  });
});
