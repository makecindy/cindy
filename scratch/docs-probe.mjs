#!/usr/bin/env node
/**
 * scratch/docs-probe.mjs —— cindy_docs 的真实产出探针(纯 Node,不起 Electron)。
 *
 * 单测已经覆盖了各工具的往返断言,这个脚本是给人看的:跑一次会在临时目录里
 * 真生成 docx / pptx / xlsx / csv,解包检查关键 XML,并把文件留在磁盘上供人工
 * 用 Word / PowerPoint / Excel 打开目检 —— 「XML 里有这个字符串」和「Office 真能
 * 打开」是两回事,后者只能靠人。
 *
 * 用法: node scratch/docs-probe.mjs [输出目录]
 *
 * 注:render_pdf 不在探针范围内 —— 它需要 Electron 的 BrowserWindow,只能在真实
 * 客户端里验。inspect_pdf 的解析内核(pdfjs)在这里用手搓 PDF 验过。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';

import {
  markdownToDocxBuffer,
  parseDelimited,
} from '../packages/lizi-mcps/src/cindy-docs/index.ts';

const outDir = process.argv[2] ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-docs-probe-')));
await fs.mkdir(outDir, { recursive: true });

const checks = [];
function check(label, ok, detail = '') {
  checks.push({ label, ok, detail });
  console.log(`${ok ? '  ok ' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function unzipText(buffer, entry) {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(entry);
  if (!file) throw new Error(`zip 里没有 ${entry}`);
  return file.async('string');
}

// ── docx ────────────────────────────────────────────────────────────────────
console.log('\n[docx] markdown → Word');
const markdown = [
  '# 季度经营回顾',
  '',
  '本季度收入 **同比增长 18%**,主要来自 *企业版* 续约。',
  '',
  '## 关键动作',
  '',
  '- 完成 `v2.4` 上线',
  '- 华东区扩编',
  '  - 新增 3 名售前',
  '',
  '1. 十月:签约 12 家',
  '2. 十一月:签约 9 家',
  '',
  '> 风险:头部客户续约集中在 Q4。',
  '',
  '| 区域 | 收入 |',
  '|---|--:|',
  '| 华东 | 1200 |',
  '| 华南 | 860 |',
  '',
  '```sql',
  'select region, sum(amount) from deals group by 1;',
  '```',
  '',
  '<!-- pagebreak -->',
  '',
  '## 附录',
  '',
  '详见 [数据看板](https://example.com/board)。',
].join('\n');

const docxBuffer = await markdownToDocxBuffer(markdown, { title: '季度经营回顾' });
const docxPath = path.join(outDir, 'probe.docx');
await fs.writeFile(docxPath, docxBuffer);
const documentXml = await unzipText(docxBuffer, 'word/document.xml');
check('文件非空', docxBuffer.length > 4000, `${docxBuffer.length} bytes`);
check('标题落成 Heading1', documentXml.includes('Heading1'));
check('粗体 run', documentXml.includes('<w:b/>'));
check('斜体 run', documentXml.includes('<w:i/>'));
check('行内代码等宽字体', documentXml.includes('Courier New'));
check('无序列表 numPr', documentXml.includes('<w:numPr>'));
check('表格结构', documentXml.includes('<w:tbl>') && documentXml.includes('华东'));
// 超链接的 URL 落在 rels 里,正文只留 <w:hyperlink r:id="...">,两边都要对上。
const docxRels = await unzipText(docxBuffer, 'word/_rels/document.xml.rels');
check(
  '超链接',
  documentXml.includes('<w:hyperlink') && docxRels.includes('https://example.com/board'),
);
check('有序列表编号', (await unzipText(docxBuffer, 'word/numbering.xml')).includes('decimal'));
check('分页符', documentXml.includes('w:type="page"'));
check('代码块内容', documentXml.includes('select region'));
check('引用块左边框', documentXml.includes('w:left') && documentXml.includes('风险'));

// ── pptx ────────────────────────────────────────────────────────────────────
console.log('\n[pptx] slides → PowerPoint');
const { default: pptxgen } = await import('pptxgenjs');
const pptx = new pptxgen();
pptx.layout = 'LAYOUT_16x9';
const slide = pptx.addSlide();
slide.background = { color: 'FFFFFF' };
slide.addText('本季度我们把续约率拉回到 92%', { x: 0.7, y: 0.55, w: 11.9, h: 0.9, fontSize: 28, bold: true });
slide.addText(
  [
    { text: '企业版续约率 92%(上季 84%)', options: { bullet: true, breakLine: true } },
    { text: '流失集中在中小客户', options: { bullet: true, breakLine: true } },
  ],
  { x: 0.7, y: 1.75, w: 11.9, h: 4.2, fontSize: 18 },
);
slide.addNotes('这页只讲结论,细节放附录。');
const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
const pptxPath = path.join(outDir, 'probe.pptx');
await fs.writeFile(pptxPath, pptxBuffer);
const slideXml = await unzipText(pptxBuffer, 'ppt/slides/slide1.xml');
check('文件非空', pptxBuffer.length > 10000, `${pptxBuffer.length} bytes`);
check('标题文本', slideXml.includes('续约率'));
check('要点文本', slideXml.includes('流失集中在中小客户'));
const notesXml = await unzipText(pptxBuffer, 'ppt/notesSlides/notesSlide1.xml');
check('演讲者备注', notesXml.includes('细节放附录'));

// ── xlsx ────────────────────────────────────────────────────────────────────
console.log('\n[xlsx] rows → Excel(写完再读回)');
const { default: ExcelJS } = await import('exceljs');
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('明细');
const header = ws.addRow(['区域', '收入', '是否达标']);
header.font = { bold: true };
ws.views = [{ state: 'frozen', ySplit: 1 }];
ws.addRow(['华东', 1200, true]);
ws.addRow(['华南', 860, false]);
// 公式格必须连缓存值一起写:xlsx 不存计算结果,少了它 Excel 重算前那格是空的。
ws.addRow(['合计', { formula: 'SUM(B2:B3)', result: 2060 }, true]);
const xlsxPath = path.join(outDir, 'probe.xlsx');
await fs.writeFile(xlsxPath, Buffer.from(await wb.xlsx.writeBuffer()));

const readBack = new ExcelJS.Workbook();
await readBack.xlsx.readFile(xlsxPath);
const rb = readBack.getWorksheet('明细');
check('工作表存在', Boolean(rb));
check('表头加粗', rb.getRow(1).font?.bold === true);
check('冻结首行', rb.views?.[0]?.state === 'frozen' && rb.views?.[0]?.ySplit === 1);
check('数字仍是数字', rb.getRow(2).getCell(2).value === 1200);
check('布尔仍是布尔', rb.getRow(2).getCell(3).value === true);
const formulaCell = rb.getRow(4).getCell(2).value;
check('公式文本落盘', formulaCell?.formula === 'SUM(B2:B3)', JSON.stringify(formulaCell));
check('公式缓存值落盘(不靠 LibreOffice 重算)', formulaCell?.result === 2060);

// ── csv ─────────────────────────────────────────────────────────────────────
console.log('\n[csv] RFC4180 解析');
const csv = 'a,b,c\r\n1,"含,逗号","说 ""引号"""\r\n2,"跨\n行",x\r\n';
const parsed = parseDelimited(csv, { delimiter: ',' });
check('行数', parsed.length === 3, JSON.stringify(parsed));
check('引号内逗号', parsed[1][1] === '含,逗号');
check('转义引号', parsed[1][2] === '说 "引号"');
check('引号内换行', parsed[2][1] === '跨\n行');

// ── summary ─────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.ok);
console.log(`\n产物目录: ${outDir}`);
console.log(`  ${path.basename(docxPath)} / ${path.basename(pptxPath)} / ${path.basename(xlsxPath)}`);
console.log('请用 Word / PowerPoint / Excel 打开目检 —— XML 断言不能替代真实打开。');
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
if (failed.length > 0) {
  for (const f of failed) console.error(`  FAIL ${f.label}`);
  process.exitCode = 1;
}
