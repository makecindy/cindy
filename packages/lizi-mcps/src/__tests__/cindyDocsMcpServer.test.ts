/**
 * cindy_docs MCP server 测试:真 McpServer + InMemoryTransport,真文件往返。
 *
 * 覆盖:
 *  - 六个工具顶层暴露(防回退:曾藏在二级分派后导致模型从不调用)
 *  - render_pdf / inspect_pdf 的注册门(host 没注入对应回调时工具不出现)
 *  - office_to_pdf 已彻底下线(裁决:不保留任何依赖系统级 LibreOffice 的路径)
 *  - make_docx / make_pptx / make_xlsx 的真文件产出(解包断言 XML / exceljs 读回)
 *  - make_xlsx 的公式纪律:公式文本 + 缓存值一起落盘,回读拿到算好的值而不是 null
 *  - read_sheet 的 xlsx / csv / tsv 与截断标注
 *  - inspect_pdf 的判读结论(纸张名 / 空白页 / verdict)与失败归类
 *  - 路径边界:.. 穿越、绝对路径越界、symlink 逃逸
 *  - overwrite 语义
 *  - 无 workingDir 时 fail closed
 *  - render_pdf 的空产物 / 超时归类 / fontsReady 透传
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCindyDocsMcpServer } from '../cindy_docsMcpServer.js';
import {
  detectPptxImageMime,
  isSupportedPptxImage,
  PPTX_THEMES,
  resolvePptxGenConstructor,
} from '../cindy-docs/make_pptx.js';
import { DocsPathError, readInputFileWithinLimit } from '../cindy-docs/_paths.js';
import { RENDER_PDF_MAX_HTML_BYTES } from '../cindy-docs/render_pdf.js';
import { MAX_XLSX_ZIP_ENTRIES } from '../cindy-docs/read_sheet.js';
import type {
  DocsMcpDeps,
  DocsMcpSessionCtx,
  DocsPdfInspection,
  DocsPdfPageInspection,
  DocsPdfRenderInput,
  WriteDocsOutputFn,
} from '../cindy-docs/types.js';

let workdir: string;
const created: string[] = [];

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-docs-test-'));
  created.push(workdir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (created.length > 0) {
    const dir = created.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function sessionCtx(overrides: Partial<DocsMcpSessionCtx> = {}): DocsMcpSessionCtx {
  return {
    agentKind: 'claude-code',
    workingDir: workdir,
    sessionId: 'sess-1',
    ...overrides,
  };
}

async function connect(deps: DocsMcpDeps = {}, ctx = sessionCtx()) {
  const server = createCindyDocsMcpServer({ writeDocsOutput: testWriter, ...deps }, ctx);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'docs-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  return client;
}

const testWriter: WriteDocsOutputFn = async ({ path: outputPath, data, overwrite }) => {
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, data, { flag: overwrite ? 'w' : 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DocsPathError('FILE_EXISTS', `目标文件已存在: ${outputPath}`, 'overwrite');
    }
    throw error;
  }
};

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

/** 六个工具顶层直接调用(2026-08-21 起不再经 call_tool 二级分派)。 */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return payload(await client.callTool({ name, arguments: args }));
}

async function unzip(file: string, entry: string): Promise<string> {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const found = zip.file(entry);
  if (!found) throw new Error(`missing ${entry}; have ${Object.keys(zip.files).join(',')}`);
  return found.async('string');
}

describe('cindy_docs 入口工具', () => {
  // 防回退:六个工具必须顶层可见。曾经它们藏在 list_tools/call_tool 二级分派
  // 后面,真机上模型因此从未调用过任何一个(make_pptx 调用数 0),回了句「做不了」。
  it('六个工具全部顶层暴露,没有二级分派入口', async () => {
    const client = await connect({
      renderHtmlToPdf: async () => ({
        buffer: Buffer.from('%PDF-'),
        fontsReady: true,
      }),
      inspectPdf: async () => ({ numPages: 1, pagesInspected: 0, pages: [] }),
    });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'inspect_pdf',
      'make_docx',
      'make_pptx',
      'make_xlsx',
      'read_sheet',
      'render_pdf',
    ]);
    expect(tools.map((t) => t.name)).not.toContain('list_tools');
    expect(tools.map((t) => t.name)).not.toContain('call_tool');
  });

  it('顶层描述自解释:说清什么时候用,并带上路径与错误码约束', async () => {
    const client = await connect({
      renderHtmlToPdf: async () => ({
        buffer: Buffer.from('%PDF-'),
        fontsReady: true,
      }),
      inspectPdf: async () => ({ numPages: 1, pagesInspected: 0, pages: [] }),
    });
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? '']));
    // 顶层描述是模型唯一的选型依据 —— 触发词必须写在里面。
    expect(byName.get('make_pptx')).toContain('PPT');
    expect(byName.get('make_docx')).toContain('Word');
    expect(byName.get('make_xlsx')).toContain('Excel');
    expect(byName.get('render_pdf')).toContain('PDF');
    expect(byName.get('inspect_pdf')).toContain('自检');
    for (const description of byName.values()) {
      expect(description).toContain('PATH_NOT_ALLOWED');
    }
  });

  it('office_to_pdf 已彻底下线,连工具名都不存在', async () => {
    const client = await connect({
      renderHtmlToPdf: async () => ({
        buffer: Buffer.from('%PDF-'),
        fontsReady: true,
      }),
      inspectPdf: async () => ({ numPages: 1, pagesInspected: 0, pages: [] }),
    });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('office_to_pdf');
    // 顶层化后不存在的工具由 MCP 协议层直接拒绝(不再有 call_tool 的
    // UNKNOWN_TOOL payload) —— 断言"调用会失败"即可。
    const called = await client.callTool({
      name: 'office_to_pdf',
      arguments: { path: 'a.docx', outPath: 'a.pdf' },
    });
    expect((called as { isError?: boolean }).isError).toBe(true);
  });

  it('host 没注入渲染回调时 render_pdf / inspect_pdf 不注册', async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('render_pdf');
    expect(names).not.toContain('inspect_pdf');
    // 三个 author 工具与 read_sheet 不依赖 host 回调,恒在。
    expect(names.sort()).toEqual(['make_docx', 'make_pptx', 'make_xlsx', 'read_sheet']);
  });

  it('缺必填参数被 schema 拦下,错误里带得出哪个字段', async () => {
    const client = await connect();
    // outPath 必填。顶层工具的入参校验由 MCP SDK 用同一份 zod shape 执行,
    // 失败信息里含字段名,模型据此自纠。
    const called = await client.callTool({
      name: 'make_docx',
      arguments: { markdown: 'x' },
    });
    expect((called as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(called)).toContain('outPath');
  });

  it('未知字段不被静默忽略', async () => {
    const client = await connect();
    const called = await client.callTool({
      name: 'make_docx',
      arguments: { markdown: 'x', outPath: 'a.docx', tittle: '拼错的字段' },
    });
    // 拼错的字段不被静默剥掉:SDK 用同一份 zod shape 严格校验,直接判失败。
    expect((called as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(called)).toContain('tittle');
  });
});

describe('make_docx', () => {
  it('生成真 Word 文件,标题/粗体/列表/表格/代码块/分页符都落到 XML', async () => {
    const client = await connect();
    const markdown = [
      '# 一级标题',
      '',
      '正文 **加粗** 与 *斜体* 与 `code`。',
      '',
      '- 无序一',
      '- 无序二',
      '',
      '1. 有序一',
      '2. 有序二',
      '',
      '> 引用一句',
      '',
      '| 列A | 列B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '<!-- pagebreak -->',
      '',
      '尾页正文。',
    ].join('\n');

    const result = await callTool(client, 'make_docx', {
      markdown,
      outPath: 'documents/报告.docx',
      title: '测试报告',
    });
    expect(result.ok).toBe(true);
    expect(result.format).toBe('docx');
    expect(result.relativePath).toBe(path.join('documents', '报告.docx'));
    expect(result.bytes as number).toBeGreaterThan(3000);

    const file = result.path as string;
    const xml = await unzip(file, 'word/document.xml');
    expect(xml).toContain('Heading1');
    expect(xml).toContain('一级标题');
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('<w:i/>');
    expect(xml).toContain('Courier New');
    expect(xml).toContain('<w:numPr>');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('引用一句');
    expect(xml).toContain('const x = 1;');
    expect(xml).toContain('w:type="page"');
    // title 同时写进 core properties
    expect(await unzip(file, 'docProps/core.xml')).toContain('测试报告');
    // 有序列表用 decimal 编号定义
    expect(await unzip(file, 'word/numbering.xml')).toContain('decimal');
  });

  it('引用块内外的有序列表不共用编号(instance 计数器全篇唯一)', async () => {
    const client = await connect();
    const result = await callTool(client, 'make_docx', {
      markdown: ['> 1. 引用里的一', '> 2. 引用里的二', '', '1. 块外的一', '2. 块外的二'].join('\n'),
      outPath: 'lists.docx',
    });
    expect(result.ok).toBe(true);
    const xml = await unzip(result.path as string, 'word/document.xml');
    const instances = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]);
    // 两个列表各自一个 numId,不能是同一个 —— 否则块外列表会从 3 开始编号。
    expect(new Set(instances).size).toBe(2);
  });

  it('输出目录不存在时自动创建', async () => {
    const client = await connect();
    const result = await callTool(client, 'make_docx', {
      markdown: '# hi',
      outPath: 'a/b/c/deep.docx',
    });
    expect(result.ok).toBe(true);
    await expect(fs.stat(path.join(workdir, 'a/b/c/deep.docx'))).resolves.toBeTruthy();
  });
});

describe('make_xlsx', () => {
  it('写出的表能被 exceljs 读回,表头加粗 + 冻结首行 + 类型保真', async () => {
    const client = await connect();
    const result = await callTool(client, 'make_xlsx', {
      sheets: [
        {
          name: '明细',
          header: ['区域', '收入', '达标'],
          rows: [
            ['华东', 1200, true],
            ['华南', 860, false],
            ['西北', null, false],
          ],
        },
        { name: '备注', rows: [['只有数据没有表头']] },
      ],
      outPath: 'data/report.xlsx',
    });
    expect(result.ok).toBe(true);
    expect(result.sheets).toEqual([
      { name: '明细', rows: 3 },
      { name: '备注', rows: 1 },
    ]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.path as string);
    const ws = wb.getWorksheet('明细')!;
    expect(ws.getRow(1).font?.bold).toBe(true);
    // exceljs 的 views 是 normal / frozen / split 的联合类型,ySplit 只存在于
    // frozen 分支 —— 断言前先窄化,别用 any 把类型信息丢掉。
    const view = ws.views?.[0];
    expect(view?.state).toBe('frozen');
    expect(view?.state === 'frozen' ? view.ySplit : undefined).toBe(1);
    expect(ws.getRow(2).getCell(1).value).toBe('华东');
    expect(ws.getRow(2).getCell(2).value).toBe(1200);
    expect(ws.getRow(2).getCell(3).value).toBe(true);
    // 列宽按内容自适应,且不小于下限
    expect(ws.getColumn(1).width!).toBeGreaterThanOrEqual(8);
    // 无表头的表不冻结
    expect(wb.getWorksheet('备注')!.views?.[0]?.state ?? 'normal').not.toBe('frozen');
  });

  it('非法工作表名被消毒,重名自动去重', async () => {
    const client = await connect();
    const result = await callTool(client, 'make_xlsx', {
      sheets: [
        { name: 'a/b:c', rows: [['1']] },
        { name: 'a/b:c', rows: [['2']] },
      ],
      outPath: 'x.xlsx',
    });
    expect(result.ok).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.path as string);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['a_b_c', 'a_b_c_2']);
  });

  it('工作表名按 Excel 的大小写不敏感语义去重,保留展示名称', async () => {
    const client = await connect();
    const result = await callTool(client, 'make_xlsx', {
      sheets: [
        { name: 'Data', rows: [['one']] },
        { name: 'data', rows: [['two']] },
      ],
      outPath: 'case-insensitive.xlsx',
    });
    expect(result.ok).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.path as string);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Data', 'data_2']);
  });

  // 公式纪律:xlsx 只存公式文本,不存值。缓存值(result)必须一起写进去,否则
  // Excel 重算之前那格是空的,而 read_sheet / 预览 / Numbers 直接读到 null。
  // 这是「不引入 LibreOffice 重算」这条裁决的零依赖等价物,必须被测试钉死。
  it('公式单元格连同缓存值一起落盘,回读拿到的是算好的值而不是空', async () => {
    const client = await connect();
    const result = await callTool(client, 'make_xlsx', {
      sheets: [
        {
          name: '汇总',
          header: ['区域', '收入'],
          rows: [
            ['华东', 1200],
            ['华南', 860],
            ['合计', { formula: 'SUM(B2:B3)', result: 2060 }],
            // 模型经常带上等号,两种写法都要能落对。
            ['均值', { formula: '=AVERAGE(B2:B3)', result: 1030 }],
            ['备注', { formula: 'IF(B4>2000,"达标","未达标")', result: '达标' }],
          ],
        },
      ],
      outPath: 'formula.xlsx',
    });
    expect(result.ok).toBe(true);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(result.path as string);
    const ws = wb.getWorksheet('汇总')!;

    const sum = ws.getRow(4).getCell(2).value as {
      formula: string;
      result: number;
    };
    expect(sum.formula).toBe('SUM(B2:B3)');
    expect(sum.result).toBe(2060);

    // 前导等号被剥掉:xlsx 里存的公式本来就不带 '='。
    const avg = ws.getRow(5).getCell(2).value as {
      formula: string;
      result: number;
    };
    expect(avg.formula).toBe('AVERAGE(B2:B3)');
    expect(avg.result).toBe(1030);

    const text = ws.getRow(6).getCell(2).value as {
      formula: string;
      result: string;
    };
    expect(text.result).toBe('达标');

    // 而且 read_sheet 回读时看到的是缓存值,不是公式文本、更不是 null ——
    // 这正是「不靠 LibreOffice 重算」要保住的那个性质。
    const readBack = await callTool(client, 'read_sheet', {
      path: 'formula.xlsx',
    });
    const rows = readBack.rows as unknown[][];
    expect(rows[3]![1]).toBe(2060);
    expect(rows[4]![1]).toBe(1030);
    expect(rows[5]![1]).toBe('达标');
  });

  it('公式缺 result 直接判参数错,不给"打开才发现是空格"的机会', async () => {
    const client = await connect();
    const called = await client.callTool({
      name: 'make_xlsx',
      arguments: {
        sheets: [{ name: 'S', rows: [[{ formula: 'SUM(A1:A2)' }]] }],
        outPath: 'bad.xlsx',
      },
    });
    expect((called as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(called)).toContain('result');
  });
});

describe('make_pptx', () => {
  it('accepts direct and wrapped pptxgenjs constructors', () => {
    class FakePptx {}
    expect(resolvePptxGenConstructor(FakePptx)).toBe(FakePptx);
    expect(resolvePptxGenConstructor({ default: FakePptx })).toBe(FakePptx);
    expect(resolvePptxGenConstructor({ default: { default: FakePptx } })).toBe(FakePptx);
    expect(() => resolvePptxGenConstructor({ default: {} })).toThrow(
      'pptxgenjs did not expose a constructor',
    );
  });

  it('生成真 pptx,标题/要点/备注都在,深浅主题背景不同', async () => {
    const client = await connect();
    const light = await callTool(client, 'make_pptx', {
      slides: [
        {
          title: '结论先行',
          bullets: ['要点一', '要点二'],
          notes: '这里是备注',
          body: '补充说明',
        },
        { title: '第二页' },
      ],
      outPath: 'deck-light.pptx',
      theme: 'light',
      title: '汇报',
    });
    expect(light.ok).toBe(true);
    expect(light.slides).toBe(2);
    expect(light.theme).toBe('light');

    const slide1 = await unzip(light.path as string, 'ppt/slides/slide1.xml');
    expect(slide1).toContain('结论先行');
    expect(slide1).toContain('要点一');
    expect(slide1).toContain('补充说明');
    expect(slide1).toContain(PPTX_THEMES.light.background);
    const notes = await unzip(light.path as string, 'ppt/notesSlides/notesSlide1.xml');
    expect(notes).toContain('这里是备注');

    const dark = await callTool(client, 'make_pptx', {
      slides: [{ title: '深色' }],
      outPath: 'deck-dark.pptx',
      theme: 'dark',
    });
    const darkSlide = await unzip(dark.path as string, 'ppt/slides/slide1.xml');
    expect(darkSlide).toContain(PPTX_THEMES.dark.background);
    expect(PPTX_THEMES.dark.background).not.toBe(PPTX_THEMES.light.background);
  });

  it('图片路径越界时整个生成不发生,不留半成品', async () => {
    const client = await connect();
    const result = await callTool(client, 'make_pptx', {
      slides: [{ title: '第一页' }, { title: '带图', imagePath: '../../../etc/hosts' }],
      outPath: 'deck.pptx',
    });
    expect(result.errorCode).toBe('PATH_NOT_ALLOWED');
    await expect(fs.stat(path.join(workdir, 'deck.pptx'))).rejects.toThrow();
  });

  it('不支持的图片格式先被拦下,不生成打不开的坏包', async () => {
    await fs.writeFile(path.join(workdir, 'pic.webp'), 'not-really-webp');
    const client = await connect();
    const result = await callTool(client, 'make_pptx', {
      slides: [{ title: '带图', imagePath: 'pic.webp' }],
      outPath: 'deck.pptx',
    });
    expect(result.errorCode).toBe('UNSUPPORTED_IMAGE');
    expect((result.data as Record<string, string>).hint).toContain('.png');
    await expect(fs.stat(path.join(workdir, 'deck.pptx'))).rejects.toThrow();

    // 支持的扩展名照常放行
    expect(isSupportedPptxImage('/a/b.PNG')).toBe(true);
    expect(isSupportedPptxImage('/a/b.svg')).toBe(false);
  });

  it('支持的图片后缀也必须有真实图片字节,MIME 按内容而不是后缀决定', async () => {
    await fs.writeFile(path.join(workdir, 'fake.png'), 'plain text');
    const client = await connect();
    const invalid = await callTool(client, 'make_pptx', {
      slides: [{ title: '伪图片', imagePath: 'fake.png' }],
      outPath: 'fake-image.pptx',
    });
    expect(invalid.errorCode).toBe('INVALID_IMAGE');
    await expect(fs.stat(path.join(workdir, 'fake-image.pptx'))).rejects.toThrow();

    const jpegNamedPng = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00,
      0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
    ]);
    expect(detectPptxImageMime(jpegNamedPng)).toBe('image/jpeg');
  });
});

describe('read_sheet', () => {
  it('读回自己刚生成的 xlsx,支持按名与按序号选表', async () => {
    const client = await connect();
    await callTool(client, 'make_xlsx', {
      sheets: [
        { name: 'S1', header: ['a', 'b'], rows: [[1, 2]] },
        { name: 'S2', header: ['c'], rows: [['x']] },
      ],
      outPath: 'r.xlsx',
    });

    const first = await callTool(client, 'read_sheet', { path: 'r.xlsx' });
    expect(first.ok).toBe(true);
    expect(first.sheet).toBe('S1');
    expect(first.sheetNames).toEqual(['S1', 'S2']);
    expect(first.rows).toEqual([
      ['a', 'b'],
      [1, 2],
    ]);
    expect(first.truncated).toBe(false);

    expect((await callTool(client, 'read_sheet', { path: 'r.xlsx', sheet: 'S2' })).rows).toEqual([
      ['c'],
      ['x'],
    ]);
    expect((await callTool(client, 'read_sheet', { path: 'r.xlsx', sheet: 2 })).sheet).toBe('S2');

    const missing = await callTool(client, 'read_sheet', {
      path: 'r.xlsx',
      sheet: '不存在',
    });
    expect(missing.errorCode).toBe('SHEET_NOT_FOUND');
    expect((missing.data as Record<string, string>).hint).toContain('S1');
    expect((await callTool(client, 'read_sheet', { path: 'r.xlsx', sheet: 9 })).errorCode).toBe(
      'SHEET_NOT_FOUND',
    );
  });

  it('读 csv / tsv,引号与跨行字段保真', async () => {
    const client = await connect();
    await fs.writeFile(
      path.join(workdir, 'a.csv'),
      'name,note\r\n甲,"含,逗号"\r\n乙,"跨\n行"\r\n',
      'utf-8',
    );
    const csv = await callTool(client, 'read_sheet', { path: 'a.csv' });
    expect(csv.format).toBe('csv');
    expect(csv.rows).toEqual([
      ['name', 'note'],
      ['甲', '含,逗号'],
      ['乙', '跨\n行'],
    ]);

    await fs.writeFile(path.join(workdir, 'a.tsv'), 'x\ty\n1\t2\n', 'utf-8');
    expect((await callTool(client, 'read_sheet', { path: 'a.tsv' })).rows).toEqual([
      ['x', 'y'],
      ['1', '2'],
    ]);
  });

  it('超过 maxRows 时明确标注截断,不假装这就是全表', async () => {
    const client = await connect();
    const lines = Array.from({ length: 50 }, (_, i) => `${i},v${i}`).join('\n');
    await fs.writeFile(path.join(workdir, 'big.csv'), lines, 'utf-8');
    const result = await callTool(client, 'read_sheet', {
      path: 'big.csv',
      maxRows: 10,
    });
    expect(result.returnedRows).toBe(10);
    expect(result.totalRows).toBe(50);
    expect(result.truncated).toBe(true);
    expect(result.startRow).toBe(1);
    expect(result.endRow).toBe(10);
    expect(result.nextStartRow).toBe(11);
    expect(result.truncationNote).toContain('50');

    const middle = await callTool(client, 'read_sheet', {
      path: 'big.csv',
      startRow: 21,
      maxRows: 10,
    });
    expect(middle.rows).toEqual(
      Array.from({ length: 10 }, (_, i) => [String(i + 20), `v${i + 20}`]),
    );
    expect(middle.startRow).toBe(21);
    expect(middle.endRow).toBe(30);
    expect(middle.nextStartRow).toBe(31);

    const last = await callTool(client, 'read_sheet', {
      path: 'big.csv',
      startRow: 41,
      maxRows: 10,
    });
    expect(last.returnedRows).toBe(10);
    expect(last.truncated).toBe(false);
    expect(last.nextStartRow).toBeUndefined();
  });

  it('CSV 列分页元数据按全文件最宽行统计,不随当前行页缩小', async () => {
    const client = await connect();
    const wideRow = Array.from({ length: 100 }, (_, i) => `v${i}`).join(',');
    await fs.writeFile(path.join(workdir, 'wide.csv'), `a,b\n${wideRow}\n`, 'utf8');
    const first = await callTool(client, 'read_sheet', {
      path: 'wide.csv',
      maxRows: 1,
      maxColumns: 8,
    });
    expect(first.totalColumns).toBe(100);
    expect(first.nextStartColumn).toBe(9);
  });

  it('按 worksheet.rowCount 保留物理行号,稀疏尾行会正确标记截断', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sparse');
    sheet.getCell('A1000').value = 'tail';
    await fs.writeFile(
      path.join(workdir, 'sparse.xlsx'),
      Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer),
    );
    const client = await connect();
    const first = await callTool(client, 'read_sheet', {
      path: 'sparse.xlsx',
      maxRows: 200,
    });
    expect(first.totalRows).toBe(1000);
    expect(first.returnedRows).toBe(200);
    expect(first.truncated).toBe(true);

    const full = await callTool(client, 'read_sheet', {
      path: 'sparse.xlsx',
      maxRows: 1000,
    });
    expect(full.totalRows).toBe(1000);
    expect(full.truncated).toBe(false);
    expect((full.rows as unknown[][])[999]![0]).toBe('tail');

    const tail = await callTool(client, 'read_sheet', {
      path: 'sparse.xlsx',
      startRow: 999,
      maxRows: 2,
    });
    expect(tail.rows).toEqual([[null], ['tail']]);
    expect(tail.startRow).toBe(999);
    expect(tail.endRow).toBe(1000);
    expect(tail.truncated).toBe(false);
  });

  it('宽表按列窗口读取,不会物化 XFD 右侧的大量空格', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Wide');
    sheet.getCell('XFD1').value = 'tail-column';
    await fs.writeFile(
      path.join(workdir, 'wide.xlsx'),
      Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer),
    );
    const client = await connect();
    const first = await callTool(client, 'read_sheet', {
      path: 'wide.xlsx',
      maxRows: 1,
      maxColumns: 8,
    });
    expect(first.totalColumns).toBe(16384);
    expect(first.returnedRows).toBe(1);
    expect((first.rows as unknown[][])[0]).toHaveLength(8);
    expect(first.nextStartColumn).toBe(9);

    const tail = await callTool(client, 'read_sheet', {
      path: 'wide.xlsx',
      maxRows: 1,
      startColumn: 16384,
      maxColumns: 1,
    });
    expect(tail.rows).toEqual([['tail-column']]);
    expect(tail.truncated).toBe(false);
    expect(tail.nextStartColumn).toBeUndefined();
  });

  it('xlsx 输入先过文件大小与 ZIP 解压比上限,不把异常压缩包交给 ExcelJS', async () => {
    const client = await connect();
    await fs.writeFile(path.join(workdir, 'huge.xlsx'), Buffer.alloc(32 * 1024 * 1024 + 1, 0));
    expect((await callTool(client, 'read_sheet', { path: 'huge.xlsx' })).errorCode).toBe(
      'FILE_TOO_LARGE',
    );

    const zip = new JSZip();
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<sheetData>' + 'x'.repeat(2 * 1024 * 1024) + '</sheetData>',
    );
    await fs.writeFile(
      path.join(workdir, 'bomb.xlsx'),
      await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      }),
    );
    const bomb = await callTool(client, 'read_sheet', { path: 'bomb.xlsx' });
    expect(bomb.errorCode).toBe('FILE_TOO_LARGE');
    expect((bomb.data as Record<string, string>).hint).toContain('压缩');

    const manyEntries = new JSZip();
    for (let i = 0; i <= MAX_XLSX_ZIP_ENTRIES; i += 1) {
      manyEntries.file(`xl/comments/empty-${i}.xml`, '');
    }
    await fs.writeFile(
      path.join(workdir, 'many-entries.xlsx'),
      await manyEntries.generateAsync({
        type: 'nodebuffer',
        compression: 'STORE',
      }),
    );
    const entries = await callTool(client, 'read_sheet', {
      path: 'many-entries.xlsx',
    });
    expect(entries.errorCode).toBe('FILE_TOO_LARGE');
    expect((entries.data as Record<string, string>).hint).toContain('ZIP 条目');
  });

  it('.xls 与未知扩展名给出可执行的降级指引', async () => {
    const client = await connect();
    await fs.writeFile(path.join(workdir, 'old.xls'), 'x', 'utf-8');
    const xls = await callTool(client, 'read_sheet', { path: 'old.xls' });
    expect(xls.errorCode).toBe('UNSUPPORTED_FORMAT');
    expect((xls.data as Record<string, string>).hint).toContain('.xlsx');

    await fs.writeFile(path.join(workdir, 'a.pdf'), 'x', 'utf-8');
    expect((await callTool(client, 'read_sheet', { path: 'a.pdf' })).errorCode).toBe(
      'UNSUPPORTED_FORMAT',
    );
  });

  it('文件不存在返回 NOT_A_FILE', async () => {
    const client = await connect();
    expect((await callTool(client, 'read_sheet', { path: 'ghost.csv' })).errorCode).toBe(
      'NOT_A_FILE',
    );
  });
});

describe('路径边界与覆盖语义', () => {
  it('四种生成工具拒绝缺失或错误的输出扩展名', async () => {
    const client = await connect({
      renderHtmlToPdf: async () => ({
        buffer: Buffer.from('%PDF-1.7'),
        fontsReady: true,
      }),
    });
    const cases: Array<[string, Record<string, unknown>]> = [
      ['make_docx', { markdown: '# x', outPath: 'wrong.pdf' }],
      ['make_pptx', { slides: [{ title: 'x' }], outPath: 'wrong.docx' }],
      ['make_xlsx', { sheets: [{ name: 'S', rows: [[1]] }], outPath: 'wrong' }],
      ['render_pdf', { html: '<p>x</p>', outPath: 'wrong.pptx' }],
    ];
    for (const [tool, args] of cases) {
      expect((await callTool(client, tool, args)).errorCode).toBe('INVALID_EXTENSION');
    }
  });

  it('.. 穿越与工作目录外的绝对路径都被拒', async () => {
    const client = await connect();
    for (const outPath of [
      '../escape.docx',
      path.join(os.tmpdir(), 'escape.docx'),
      '/etc/x.docx',
    ]) {
      const result = await callTool(client, 'make_docx', {
        markdown: '# x',
        outPath,
      });
      expect(result.errorCode).toBe('PATH_NOT_ALLOWED');
      expect((result.data as Record<string, string>).hint).toContain('工作目录');
    }
  });

  it('经 symlink 指向工作目录外也被拒', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-docs-outside-'));
    created.push(outside);
    await fs.symlink(outside, path.join(workdir, 'link'), 'dir');
    const client = await connect();
    const result = await callTool(client, 'make_docx', {
      markdown: '# x',
      outPath: 'link/escaped.docx',
    });
    expect(result.errorCode).toBe('PATH_NOT_ALLOWED');
    await expect(fs.stat(path.join(outside, 'escaped.docx'))).rejects.toThrow();
  });

  it('同名文件默认不覆盖,overwrite:true 才覆盖', async () => {
    const client = await connect();
    const first = await callTool(client, 'make_docx', {
      markdown: '# 第一版',
      outPath: 'a.docx',
    });
    expect(first.ok).toBe(true);
    const firstBytes = first.bytes as number;

    const blocked = await callTool(client, 'make_docx', {
      markdown: '# 第二版',
      outPath: 'a.docx',
    });
    expect(blocked.errorCode).toBe('FILE_EXISTS');
    expect((blocked.data as Record<string, string>).hint).toContain('overwrite');
    // 被拒时原文件必须原封不动
    expect((await fs.stat(path.join(workdir, 'a.docx'))).size).toBe(firstBytes);

    const forced = await callTool(client, 'make_docx', {
      markdown: '# 第二版内容更长一些用来改变体积',
      outPath: 'a.docx',
      overwrite: true,
    });
    expect(forced.ok).toBe(true);
    expect(await unzip(forced.path as string, 'word/document.xml')).toContain('第二版');
  });

  it('输入读取只接受与边界校验相同的已打开文件身份', async () => {
    const inside = path.join(workdir, 'inside.txt');
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-docs-outside-'));
    created.push(outsideDir);
    const outside = path.join(outsideDir, 'outside.txt');
    await fs.writeFile(inside, 'inside');
    await fs.writeFile(outside, 'outside');

    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async () => originalOpen(outside, 'r'));
    await expect(
      readInputFileWithinLimit(
        workdir,
        inside,
        1024,
        (bytes) => new DocsPathError('FILE_TOO_LARGE', String(bytes), 'too large'),
      ),
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
  });

  it('无 workingDir 时 fail closed', async () => {
    const client = await connect({}, sessionCtx({ workingDir: '' }));
    const result = await callTool(client, 'make_docx', {
      markdown: '# x',
      outPath: 'a.docx',
    });
    expect(result.errorCode).toBe('NO_SESSION_CONTEXT');
  });

  it('远程(SSH)会话拒绝生成本地文件', async () => {
    const client = await connect({}, sessionCtx({ remoteHostId: 'box-1' }));
    const result = await callTool(client, 'make_docx', {
      markdown: '# x',
      outPath: 'a.docx',
    });
    expect(result.errorCode).toBe('REMOTE_SESSION_UNSUPPORTED');
  });

  it('归属解析不出来时不借用构建期 ctx', async () => {
    // getSessionContext 是权威来源:返回 undefined 表示本次调用无法确认归属,
    // 此时必须 fail closed,而不是回落到闭包里那个 workdir。
    const ctx = sessionCtx({ getSessionContext: () => undefined });
    const client = await connect({}, ctx);
    const result = await callTool(client, 'make_docx', {
      markdown: '# x',
      outPath: 'a.docx',
    });
    expect(result.errorCode).toBe('NO_SESSION_CONTEXT');
  });
});

describe('render_pdf', () => {
  const pdfBytes = Buffer.from(`%PDF-1.7\n${'x'.repeat(4096)}\n%%EOF`);

  it('把 host 返回的字节落盘,并透传排版参数', async () => {
    const seen: DocsPdfRenderInput[] = [];
    const client = await connect({
      renderHtmlToPdf: async (input) => {
        seen.push(input);
        return { buffer: pdfBytes, fontsReady: true };
      },
    });
    const result = await callTool(client, 'render_pdf', {
      html: '<h1>hi</h1>',
      outPath: 'out/a.pdf',
      pageSize: 'Letter',
      landscape: true,
      template: 'none',
      margins: { top: 1, bottom: 1, left: 0.5, right: 0.5 },
    });
    expect(result.ok).toBe(true);
    expect(result.format).toBe('pdf');
    expect(result.bytes).toBe(pdfBytes.length);
    expect(await fs.readFile(path.join(workdir, 'out/a.pdf'))).toEqual(pdfBytes);
    expect(seen[0]).toMatchObject({
      html: '<h1>hi</h1>',
      pageSize: 'Letter',
      landscape: true,
      printBackground: true,
      margins: { top: 1, bottom: 1, left: 0.5, right: 0.5 },
      timeoutMs: 30_000,
      fontTimeoutMs: 5_000,
    });
  });

  it('htmlPath 走边界校验后把已验证字节交给 host,不再传可变路径', async () => {
    const seen: DocsPdfRenderInput[] = [];
    await fs.writeFile(path.join(workdir, 'src.html'), '<p>x</p>', 'utf-8');
    const client = await connect({
      renderHtmlToPdf: async (input) => {
        seen.push(input);
        return { buffer: pdfBytes, fontsReady: true };
      },
    });
    const result = await callTool(client, 'render_pdf', {
      htmlPath: 'src.html',
      outPath: 'a.pdf',
      template: 'none',
    });
    expect(result.ok).toBe(true);
    expect(seen[0]!.html).toBeUndefined();
    expect(seen[0]!.htmlBytes).toBeDefined();
    expect(Buffer.from(seen[0]!.htmlBytes!).toString('utf8')).toBe('<p>x</p>');
  });

  it('htmlPath 的任务目录图片与样式表先快照成 data URI', async () => {
    const seen: DocsPdfRenderInput[] = [];
    await fs.writeFile(path.join(workdir, 'chart.png'), 'png-bytes', 'utf8');
    await fs.writeFile(
      path.join(workdir, 'style.css'),
      '.hero { background-image: url("./chart.png"); }',
      'utf8',
    );
    await fs.writeFile(
      path.join(workdir, 'src.html'),
      '<html><head><link rel="stylesheet" href="./style.css"></head><body><img src="./chart.png"></body></html>',
      'utf8',
    );
    const client = await connect({
      renderHtmlToPdf: async (input) => {
        seen.push(input);
        return { buffer: pdfBytes, fontsReady: true };
      },
    });
    const result = await callTool(client, 'render_pdf', {
      htmlPath: 'src.html',
      outPath: 'snapshotted.pdf',
      template: 'none',
    });
    expect(result.ok).toBe(true);
    const rendered = Buffer.from(seen[0]!.htmlBytes!).toString('utf8');
    expect(rendered).toContain('data:image/png;base64,');
    expect(rendered).toContain('data:text/css;base64,');
    expect(rendered).not.toContain('./chart.png');
    expect(Object.prototype.hasOwnProperty.call(seen[0], 'htmlBaseDir')).toBe(false);
  });

  it('htmlPath 与 html 必须二选一', async () => {
    const client = await connect({
      renderHtmlToPdf: async () => ({ buffer: pdfBytes, fontsReady: true }),
    });
    expect((await callTool(client, 'render_pdf', { outPath: 'a.pdf' })).errorCode).toBe(
      'INVALID_ARGS',
    );
    expect(
      (
        await callTool(client, 'render_pdf', {
          outPath: 'a.pdf',
          html: '<p/>',
          htmlPath: 'x.html',
        })
      ).errorCode,
    ).toBe('INVALID_ARGS');
  });

  it('htmlPath 与内联 html 都在主进程读取前执行同一大小上限', async () => {
    const renderHtmlToPdf = vi.fn(async () => ({
      buffer: pdfBytes,
      fontsReady: true,
    }));
    const client = await connect({ renderHtmlToPdf });

    const hugePath = path.join(workdir, 'huge.html');
    const handle = await fs.open(hugePath, 'w');
    await handle.truncate(RENDER_PDF_MAX_HTML_BYTES + 1);
    await handle.close();

    expect(
      (
        await callTool(client, 'render_pdf', {
          htmlPath: 'huge.html',
          outPath: 'path.pdf',
        })
      ).errorCode,
    ).toBe('FILE_TOO_LARGE');
    expect(
      (
        await callTool(client, 'render_pdf', {
          html: 'x'.repeat(RENDER_PDF_MAX_HTML_BYTES + 1),
          outPath: 'inline.pdf',
        })
      ).errorCode,
    ).toBe('FILE_TOO_LARGE');
    expect(renderHtmlToPdf).not.toHaveBeenCalled();
  });

  it('空产物报 RENDER_EMPTY,超小产物带回验告警', async () => {
    const empty = await connect({
      renderHtmlToPdf: async () => ({
        buffer: Buffer.alloc(0),
        fontsReady: true,
      }),
    });
    expect(
      (await callTool(empty, 'render_pdf', { html: '<p/>', outPath: 'a.pdf' })).errorCode,
    ).toBe('RENDER_EMPTY');

    const tiny = await connect({
      renderHtmlToPdf: async () => ({
        buffer: Buffer.from('%PDF-1.7'),
        fontsReady: true,
      }),
    });
    const result = await callTool(tiny, 'render_pdf', {
      html: '<p/>',
      outPath: 'b.pdf',
    });
    expect(result.ok).toBe(true);
    expect(result.warning).toContain('白页');
  });

  it('超时被归成 RENDER_TIMEOUT,其余失败归 RENDER_FAILED', async () => {
    const timeout = await connect({
      renderHtmlToPdf: async () => {
        throw new Error('HTML 渲染超时(30000ms timeout)');
      },
    });
    const timedOut = await callTool(timeout, 'render_pdf', {
      html: '<p/>',
      outPath: 'a.pdf',
    });
    expect(timedOut.errorCode).toBe('RENDER_TIMEOUT');

    const failed = await connect({
      renderHtmlToPdf: async () => {
        throw new Error('render process gone');
      },
    });
    expect(
      (await callTool(failed, 'render_pdf', { html: '<p/>', outPath: 'a.pdf' })).errorCode,
    ).toBe('RENDER_FAILED');
  });

  it('渲染失败时不留下空文件', async () => {
    const client = await connect({
      renderHtmlToPdf: async () => {
        throw new Error('boom');
      },
    });
    await callTool(client, 'render_pdf', { html: '<p/>', outPath: 'a.pdf' });
    await expect(fs.stat(path.join(workdir, 'a.pdf'))).rejects.toThrow();
  });
});

describe('inspect_pdf', () => {
  const page = (over: Partial<DocsPdfPageInspection> = {}): DocsPdfPageInspection => ({
    page: 1,
    width: 595.28,
    height: 841.89,
    rotation: 0,
    textChars: 120,
    textPreview: '季度经营回顾',
    drawOps: 42,
    imageOps: 1,
    blank: false,
    visibilityUnverified: false,
    ...over,
  });

  async function withPdf(
    inspection: DocsPdfInspection,
    bytes = Buffer.from(`%PDF-1.7\n${'x'.repeat(5000)}`),
  ) {
    const client = await connect({ inspectPdf: async () => inspection });
    await fs.writeFile(path.join(workdir, 'out.pdf'), bytes);
    return client;
  }

  it('把结构翻译成可判读的结论:纸张名 + 空白页 + verdict', async () => {
    const client = await withPdf({
      numPages: 2,
      pagesInspected: 2,
      pages: [page(), page({ page: 2, textChars: 0, drawOps: 0, imageOps: 0, blank: true })],
    });
    const result = await callTool(client, 'inspect_pdf', { path: 'out.pdf' });
    expect(result.ok).toBe(true);
    expect(result.numPages).toBe(2);
    expect(result.blankPages).toEqual([2]);
    expect(result.verdict).toBe('partial-blank');
    expect(result.warning).toContain('第 2 页');
    const pages = result.pages as Array<Record<string, unknown>>;
    expect(pages[0]!.paper).toBe('A4');
  });

  it('整份全空白给出"不能交付"的结论', async () => {
    const client = await withPdf({
      numPages: 1,
      pagesInspected: 1,
      pages: [page({ textChars: 0, drawOps: 0, imageOps: 0, blank: true })],
    });
    const result = await callTool(client, 'inspect_pdf', { path: 'out.pdf' });
    expect(result.verdict).toBe('blank');
    expect(result.warning).toContain('不能交付');
  });

  it('全部正常时 verdict=ok 且没有告警', async () => {
    const client = await withPdf({
      numPages: 1,
      pagesInspected: 1,
      pages: [page()],
    });
    const result = await callTool(client, 'inspect_pdf', { path: 'out.pdf' });
    expect(result.verdict).toBe('ok');
    expect(result.warning).toBeUndefined();
    expect(result.blankPages).toEqual([]);
  });

  it('横向与非标准纸张都翻译成人能对照的说法', async () => {
    const client = await withPdf({
      numPages: 2,
      pagesInspected: 2,
      pages: [page({ width: 841.89, height: 595.28 }), page({ page: 2, width: 300, height: 300 })],
    });
    const pages = (await callTool(client, 'inspect_pdf', { path: 'out.pdf' })).pages as Array<
      Record<string, unknown>
    >;
    expect(pages[0]!.paper).toBe('A4 landscape');
    expect(pages[1]!.paper).toBe('4.17×4.17 in');
  });

  it('页码与上限原样透传给 host', async () => {
    const seen: unknown[] = [];
    const client = await connect({
      inspectPdf: async (input) => {
        seen.push(input);
        return { numPages: 9, pagesInspected: 0, pages: [] };
      },
    });
    await fs.writeFile(path.join(workdir, 'out.pdf'), Buffer.from('%PDF-1.7 body'));
    await callTool(client, 'inspect_pdf', {
      path: 'out.pdf',
      pages: [1, 5],
      maxPages: 3,
    });
    expect(seen[0]).toMatchObject({
      pages: [1, 5],
      maxPages: 3,
      timeoutMs: 15_000,
    });
  });

  it('指定页码全部越界时不把零页检查误报为 ok', async () => {
    const client = await withPdf({ numPages: 3, pagesInspected: 0, pages: [] });
    const result = await callTool(client, 'inspect_pdf', {
      path: 'out.pdf',
      pages: [99],
    });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NO_PAGES_INSPECTED');
    expect((result.data as Record<string, unknown>).numPages).toBe(3);
  });

  it('0 字节的 PDF 直接判定生成失败', async () => {
    const client = await withPdf({ numPages: 0, pagesInspected: 0, pages: [] }, Buffer.alloc(0));
    const result = await callTool(client, 'inspect_pdf', { path: 'out.pdf' });
    expect(result.errorCode).toBe('EMPTY_FILE');
  });

  it('超限 PDF 在交给解析进程前按 stat 拒绝', async () => {
    const inspectPdf = vi.fn(async () => ({
      numPages: 0,
      pagesInspected: 0,
      pages: [],
    }));
    const client = await connect({ inspectPdf });
    const hugePath = path.join(workdir, 'huge.pdf');
    const handle = await fs.open(hugePath, 'w');
    await handle.truncate(64 * 1024 * 1024 + 1);
    await handle.close();

    const result = await callTool(client, 'inspect_pdf', { path: 'huge.pdf' });
    expect(result.errorCode).toBe('FILE_TOO_LARGE');
    expect(inspectPdf).not.toHaveBeenCalled();
  });

  it('非 pdf 扩展名与越界路径都被拒', async () => {
    const client = await connect({
      inspectPdf: async () => ({ numPages: 0, pagesInspected: 0, pages: [] }),
    });
    await fs.writeFile(path.join(workdir, 'a.txt'), 'x');
    expect((await callTool(client, 'inspect_pdf', { path: 'a.txt' })).errorCode).toBe(
      'UNSUPPORTED_FORMAT',
    );
    expect((await callTool(client, 'inspect_pdf', { path: '../x.pdf' })).errorCode).toBe(
      'PATH_NOT_ALLOWED',
    );
  });

  it('解析超时与解析失败分开归类', async () => {
    await fs.writeFile(path.join(workdir, 'out.pdf'), Buffer.from('%PDF-1.7 body'));
    const timeout = await connect({
      inspectPdf: async () => {
        throw new Error('PDF extraction timed out in the isolated process');
      },
    });
    expect((await callTool(timeout, 'inspect_pdf', { path: 'out.pdf' })).errorCode).toBe(
      'INSPECT_TIMEOUT',
    );

    const broken = await connect({
      inspectPdf: async () => {
        throw new Error('InvalidPDFException');
      },
    });
    const failed = await callTool(broken, 'inspect_pdf', { path: 'out.pdf' });
    expect(failed.errorCode).toBe('INSPECT_FAILED');
    expect((failed.data as Record<string, string>).hint).toContain('重做');
  });
});

describe('工具错误遥测', () => {
  it('errorCode 会被交给注入的 logger', async () => {
    const warn = vi.fn();
    const client = await connect({
      logger: {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
      },
    });
    await callTool(client, 'read_sheet', { path: 'ghost.csv' });
    expect(warn).toHaveBeenCalled();
  });
});
