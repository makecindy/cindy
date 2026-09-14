/**
 * cindy-docs/make_xlsx.ts —— 结构化数据 → Excel 工作簿(.xlsx)。
 *
 * 表头处理是刻意的:加粗 + 浅底 + 冻结首行 + 按内容估宽。用户拿到的第一屏就
 * 应该是能直接看的表,而不是一片等宽未冻结的裸数据。
 */

import ExcelJS from 'exceljs';
import { z } from 'zod';

import type { DocsToolRegistry } from '../cindy_docsToolRegistry.js';
import {
  assertOutputExtension,
  describeOutput,
  DocsPathError,
  prepareOutputPath,
  resolveSessionRoot,
} from './_paths.js';
import { artifactMetadata, errorPayload, okPayload } from './_payload.js';
import {
  DEFAULT_DOCS_THEME,
  resolveDocsTheme,
  themeToArgb,
  type DocsTheme,
  type DocsThemeName,
} from './themes.js';
import type { DocsMcpSessionCtx, WriteDocsOutputFn } from './types.js';

/** 列宽估算上下限:太窄看不全,太宽一屏放不下几列。 */
const MIN_COL_WIDTH = 8;
const MAX_COL_WIDTH = 60;
/** 只用前若干行估宽 —— 万行表逐格量宽既慢又没必要。 */
const WIDTH_SAMPLE_ROWS = 200;
const BORDER_ROW_CAP = 2000;
/** ExcelJS 会在当前进程中构建整棵工作簿对象树，输入必须先过硬边界。 */
const MAX_XLSX_SHEETS = 32;
const MAX_XLSX_ROWS_PER_SHEET = 5000;
const MAX_XLSX_COLUMNS = 256;
const MAX_XLSX_CELL_TEXT_CHARS = 32_767;
const MAX_XLSX_FORMULA_CHARS = 8192;
const MAX_XLSX_TOTAL_CELLS = 100_000;
const MAX_XLSX_TOTAL_TEXT_BYTES = 8 * 1024 * 1024;

const DESCRIPTION = [
  '把结构化数据生成为 Excel 工作簿(.xlsx),支持多个工作表。',
  '',
  '【何时用】用户要 Excel / 表格文件 / 对账表 / 可以自己排序筛选的数据。',
  '数据本身要是二维的(行 × 列);一段叙述性文字应该用 make_docx 而不是本工具。',
  '',
  '【格式】每张表的 header 会加粗 + 主题强调色带 + 冻结首行,列宽按内容自适应。',
  '数据行默认斑马纹;整数列自动千分位,0–1 的占比列(表头含 % / 率 / 占比)自动百分号。',
  'theme: "light"(默认) / "dark" / "navy";zebra 默认 true。',
  'rows 里的每个单元格可以是字符串、数字、布尔或 null(留空)。',
  '数字请传数字类型而不是字符串,否则 Excel 里不能参与求和。',
  `单份工作簿最多 ${MAX_XLSX_SHEETS} 张表、每表 ${MAX_XLSX_ROWS_PER_SHEET} 行 × ${MAX_XLSX_COLUMNS} 列、合计 ${MAX_XLSX_TOTAL_CELLS} 个单元格。`,
  '',
  '【公式】要写公式就传 { formula, result },例如',
  '{ "formula": "SUM(B2:B4)", "result": 3060 }。',
  '**result(算好的值)必填**:xlsx 文件本身不存公式的计算结果,少了它,用户在',
  'Excel 里点开重算之前那一格是空的,预览、Numbers 和各种解析库也全读到空值。',
  '你既然写得出这个公式,就把结果一并算出来填上。',
  '',
  '【输出】outPath 必须在本任务的工作目录内。目录不存在会自动创建;',
  '同名文件默认不覆盖,确要覆盖再传 overwrite: true。',
].join('\n');

/**
 * 公式单元格。**result 是刻意必填的**:xlsx 只存公式文本,不存值 —— 缓存值要写文件
 * 的人自己填。少了它,Excel/WPS 打开重算前那一格是空的,而 Numbers、预览、大多数
 * 解析库(含本工具的 read_sheet)直接读到 null。业界绕这个坑的常见做法是「写完再拿
 * LibreOffice 重算一遍」,那等于给文档功能绑一个系统级依赖 —— 我们不走那条路,
 * 改成让调用方把算好的值一起给过来。模型本来就知道这个数,写下来是零成本的。
 */
const CellTextSchema = z.string().max(MAX_XLSX_CELL_TEXT_CHARS);

const FormulaCellSchema = z.object({
  formula: z
    .string()
    .min(1)
    .max(MAX_XLSX_FORMULA_CHARS)
    .describe('Excel 公式,不带开头的等号,如 "SUM(B2:B10)"。'),
  result: z
    .union([CellTextSchema, z.number(), z.boolean()])
    .describe('公式的计算结果(缓存值)。必填 —— 没有它,打开文件重算前这格是空的。'),
});

const CellSchema = z.union([
  CellTextSchema,
  z.number(),
  z.boolean(),
  z.null(),
  FormulaCellSchema,
]);

const SheetSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(31)
    .describe('工作表名。Excel 限 31 字符,且不能含 : \\ / ? * [ ]。'),
  header: z
    .array(CellTextSchema)
    .max(MAX_XLSX_COLUMNS)
    .optional()
    .describe('可选表头行。给了就会加粗 + 主题色带 + 冻结首行。'),
  rows: z
    .array(z.array(CellSchema).max(MAX_XLSX_COLUMNS))
    .max(MAX_XLSX_ROWS_PER_SHEET)
    .describe('数据行,每行是一个单元格数组。数字请用数字类型。'),
});

const SheetsSchema = z.array(SheetSchema).min(1).max(MAX_XLSX_SHEETS);

type XlsxSheetInput = z.infer<typeof SheetSchema>;

/** 聚合边界需在 ExcelJS 构造 Workbook 之前执行，避免先实体化再报错。 */
export function assertXlsxAggregateBounds(sheets: readonly XlsxSheetInput[]): void {
  let totalCells = 0;
  let totalTextBytes = 0;
  const addText = (value: unknown): void => {
    if (typeof value === 'string') totalTextBytes += Buffer.byteLength(value, 'utf8');
  };
  for (const sheet of sheets) {
    totalCells += sheet.header?.length ?? 0;
    for (const header of sheet.header ?? []) addText(header);
    for (const row of sheet.rows) {
      totalCells += row.length;
      for (const cell of row) {
        if (isFormulaCell(cell)) {
          addText(cell.formula);
          addText(cell.result);
        } else {
          addText(cell);
        }
      }
    }
    if (totalCells > MAX_XLSX_TOTAL_CELLS) {
      throw new DocsPathError(
        'FILE_TOO_LARGE',
        `工作簿合计超过 ${MAX_XLSX_TOTAL_CELLS} 个单元格`,
        `请把工作簿拆分到不超过 ${MAX_XLSX_TOTAL_CELLS} 个单元格后重试。`,
      );
    }
    if (totalTextBytes > MAX_XLSX_TOTAL_TEXT_BYTES) {
      throw new DocsPathError(
        'FILE_TOO_LARGE',
        '工作簿文本合计超过 8 MB',
        '请缩短单元格文本或拆分工作簿后重试。',
      );
    }
  }
}

type FormulaCell = z.infer<typeof FormulaCellSchema>;

function isFormulaCell(value: unknown): value is FormulaCell {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { formula?: unknown }).formula === 'string'
  );
}

/** 公式文本允许带或不带前导 '='(模型两种都会写),统一剥掉再交给 exceljs。 */
function normalizeFormula(formula: string): string {
  return formula.startsWith('=') ? formula.slice(1) : formula;
}

/** 落到 exceljs 的实际单元格值。公式格走 { formula, result } 形态(原生支持缓存值)。 */
function toExcelValue(cell: unknown): unknown {
  if (isFormulaCell(cell)) {
    return {
      formula: normalizeFormula(cell.formula),
      result: cell.result,
    };
  }
  return cell === null ? null : cell;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  // 列宽按「用户会看到的东西」估:公式格显示的是结果,不是公式文本。
  if (isFormulaCell(value)) return value.result === null ? '' : String(value.result);
  return String(value);
}

function numericSamples(values: unknown[]): number[] {
  const out: number[] = [];
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out.push(value);
      continue;
    }
    if (isFormulaCell(value) && typeof value.result === 'number' && Number.isFinite(value.result)) {
      out.push(value.result);
    }
  }
  return out;
}

/** 按表头语义 + 列里的数推断一种对人友好的默认数字格式。 */
export function inferNumberFormat(
  header: string | undefined,
  values: unknown[],
): string | undefined {
  const nums = numericSamples(values);
  if (nums.length === 0) return undefined;
  const label = header ?? '';
  /*
    单字「率」必须在里面。原来写的是「比率」,于是「退款率」「转化率」「完成率」
    这些最常见的百分比列一个都匹配不上 —— 而工具描述明明白白承诺了「表头含
    % / 率 / 占比 自动百分号」。目检一眼看穿:那一列显示的是 0.03,不是 3.3%。

    放宽到单字不会误伤:下面那道 0–1 区间闸把「汇率」「频率」这类大于 1 的挡在
    外面,匹配上了也不会套百分号。
  */
  const looksPercent = /[%％]|率|占比|比例|百分|percent|rate|ratio|share/i.test(label);
  if (looksPercent && nums.every((n) => n >= 0 && n <= 1)) return '0.0%';
  if (nums.every((n) => Number.isInteger(n))) return '#,##0';
  return '#,##0.00';
}

/**
 * 列宽要按**用户看到的字符数**算,不是按原始值。
 *
 * 原来量的是 `String(986400)`(6 字),而单元格实际显示 `986,400`(7 字);百分比列
 * 更离谱:量 `0.0325`(6 字),显示 `3.3%`(4 字)。前者让金额列偏窄 —— Excel 放不下
 * 就显示一整格 `#####`,这是「表格很破」最直接的一种。
 *
 * 只做宽度估算用,不追求和 Excel 的渲染逐像素一致。
 */
export function formattedWidthSample(text: string, numFmt: string | undefined): string {
  if (!numFmt) return text;
  const n = Number(text);
  if (!Number.isFinite(n) || text.trim() === '') return text;
  if (numFmt.includes('%')) return `${(n * 100).toFixed(1)}%`;
  const digits = numFmt.includes('.00') ? 2 : 0;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * 汇总行判定 —— **按结构判,不按字眼判**。
 *
 * 「最后一行的非空格里公式格占多数」就是汇总行:它的数是**算出来的**,不是录入的。
 * 这条规则不需要维护一张「合计 / 总计 / 小计 / Total / 合計 / 합계…」的词表,
 * 换任何语言都成立,也不会因为某张表把汇总行叫「本季累计」就漏判。
 *
 * 只看最后一行:整表都是公式的场景(比如一张纯计算表)不该每行都被强调。
 */
export function isSummaryRow(row: readonly unknown[]): boolean {
  const filled = row.filter((cell) => cell !== null && cell !== undefined && cell !== '');
  if (filled.length === 0) return false;
  const formulas = filled.filter((cell) => isFormulaCell(cell)).length;
  return formulas * 2 > filled.length;
}

function paintRow(
  row: ExcelJS.Row,
  fillArgb: string,
  font?: Partial<ExcelJS.Font>,
  columnCount?: number,
): void {
  const paint = (cell: ExcelJS.Cell): void => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: fillArgb },
    };
    if (font) cell.font = { ...(cell.font ?? {}), ...font };
  };
  if (columnCount !== undefined) {
    for (let column = 1; column <= columnCount; column += 1) paint(row.getCell(column));
    return;
  }
  row.eachCell({ includeEmpty: true }, paint);
}

function applyThinBorder(
  ws: ExcelJS.Worksheet,
  theme: DocsTheme,
  rows: number,
  cols: number,
): void {
  if (rows === 0 || cols === 0 || rows * cols > BORDER_ROW_CAP * 8) return;
  const border = {
    style: 'thin' as const,
    color: { argb: themeToArgb(theme.line) },
  };
  const box = { top: border, bottom: border, left: border, right: border };
  const limit = Math.min(rows, BORDER_ROW_CAP);
  for (let r = 1; r <= limit; r += 1) {
    for (let c = 1; c <= cols; c += 1) {
      ws.getCell(r, c).border = box;
    }
  }
}

/** 估算显示宽度:CJK 与全角字符占两格,其余占一格。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

export function registerMakeXlsxTool(
  registry: DocsToolRegistry,
  sessionCtx: DocsMcpSessionCtx,
  writeDocsOutput: WriteDocsOutputFn,
): void {
  registry.register({
    name: 'make_xlsx',
    category: 'author',
    description: DESCRIPTION,
    inputShape: {
      sheets: SheetsSchema.describe('工作表列表,至少一张。'),
      outPath: z.string().min(1).describe('输出 .xlsx 路径,工作目录内的相对路径或绝对路径。'),
      theme: z
        .enum(['light', 'dark', 'navy'])
        .default('light')
        .describe('配色主题:light / dark / navy。影响表头色带和斑马纹。'),
      zebra: z.boolean().default(true).describe('数据行是否打斑马纹。默认 true。'),
      overwrite: z.boolean().default(false).describe('目标文件已存在时是否覆盖。默认 false。'),
    },
    handler: async ({ sheets, outPath, theme, zebra, overwrite }) => {
      try {
        assertXlsxAggregateBounds(sheets);
        const root = resolveSessionRoot(sessionCtx);
        assertOutputExtension(outPath, '.xlsx');
        const abs = await prepareOutputPath(root, outPath, overwrite);
        const palette = resolveDocsTheme((theme ?? DEFAULT_DOCS_THEME) as DocsThemeName);

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Cindy';
        workbook.created = new Date();

        // Excel 的工作表名比较大小写不敏感,但展示名仍保留用户原始大小写。
        const usedNames = new Set<string>();
        const writtenSheets: Array<{ name: string; rows: number }> = [];
        for (const sheet of sheets) {
          // Excel 的非法工作表字符会让文件直接打不开,静默换成下划线比报错更有用。
          let name = sheet.name.replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
          if (name.trim().length === 0) name = 'Sheet';
          let unique = name;
          let n = 2;
          while (usedNames.has(unique.toLowerCase())) {
            const suffix = `_${n}`;
            unique = `${name.slice(0, 31 - suffix.length)}${suffix}`;
            n += 1;
          }
          usedNames.add(unique.toLowerCase());

          const ws = workbook.addWorksheet(unique);
          writtenSheets.push({ name: unique, rows: sheet.rows.length });
          const columnCount = Math.max(
            sheet.header?.length ?? 0,
            ...sheet.rows.map((row) => row.length),
            1,
          );
          if (sheet.header && sheet.header.length > 0) {
            const headerRow = ws.addRow(sheet.header);
            headerRow.font = {
              bold: true,
              color: { argb: themeToArgb(palette.accentOn) },
            };
            paintRow(
              headerRow,
              themeToArgb(palette.accent),
              { bold: true, color: { argb: themeToArgb(palette.accentOn) } },
              columnCount,
            );
            headerRow.alignment = { vertical: 'middle' };
            ws.views = [{ state: 'frozen', ySplit: 1 }];
          }
          // 最后一行是不是汇总行,决定它不打斑马纹、而是单独强调(见 isSummaryRow)。
          const lastIndex = sheet.rows.length - 1;
          const summaryIndex =
            lastIndex >= 0 && isSummaryRow(sheet.rows[lastIndex]!) ? lastIndex : -1;

          for (const [rowIndex, row] of sheet.rows.entries()) {
            const excelRow = ws.addRow(row.map(toExcelValue));
            // 先给每个正文格落完整主题底色和前景色，再叠斑马/汇总样式。
            // 不能只给 dark 的斑马行涂深底：那会形成白底黑字/深底黑字交替。
            paintRow(
              excelRow,
              themeToArgb(palette.background),
              { color: { argb: themeToArgb(palette.body) } },
              columnCount,
            );
            if (rowIndex === summaryIndex) {
              /*
                汇总行必须一眼能和数据行分开。原来它混在斑马纹里,和普通一行长得
                一模一样 —— 一张表最重要的那一行反而最不显眼。给的是加粗 + 一条
                上边框(会计里表示「以上求和」的那条线)+ 一层浅底,不换字色,
                免得在三套主题下有一套对比度翻车。
              */
              paintRow(excelRow, themeToArgb(palette.surface), { bold: true }, columnCount);
              excelRow.eachCell({ includeEmpty: true }, (cell) => {
                cell.border = {
                  ...(cell.border ?? {}),
                  top: {
                    style: 'thin',
                    color: { argb: themeToArgb(palette.accent) },
                  },
                };
              });
            } else if (zebra && rowIndex % 2 === 1) {
              paintRow(excelRow, themeToArgb(palette.zebra), undefined, columnCount);
            }
          }
          for (let col = 0; col < columnCount; col += 1) {
            // 先定数字格式,再按**格式化后的样子**量宽 —— 反过来会让千分位金额列
            // 偏窄,用户打开看到一整格 `#####`(见 formattedWidthSample)。
            const numFmt = inferNumberFormat(
              sheet.header?.[col],
              sheet.rows.map((row) => row[col]),
            );
            let width = displayWidth(cellText(sheet.header?.[col]));
            const sampled = sheet.rows.slice(0, WIDTH_SAMPLE_ROWS);
            for (const row of sampled) {
              width = Math.max(
                width,
                displayWidth(formattedWidthSample(cellText(row[col]), numFmt)),
              );
            }
            const column = ws.getColumn(col + 1);
            column.width = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, width + 2));
            if (numFmt) {
              column.numFmt = numFmt;
              column.alignment = { horizontal: 'right' };
            }
          }
          if (sheet.header && sheet.header.length > 0) {
            ws.autoFilter = {
              from: { row: 1, column: 1 },
              to: { row: ws.rowCount, column: columnCount },
            };
          }
          applyThinBorder(ws, palette, ws.rowCount, columnCount);
        }

        const arrayBuffer = await workbook.xlsx.writeBuffer();
        await writeDocsOutput({
          root,
          path: abs,
          data: Buffer.from(arrayBuffer as ArrayBuffer),
          overwrite,
        });
        return okPayload({
          ...describeOutput(root, abs, arrayBuffer.byteLength),
          format: 'xlsx',
          theme,
          zebra,
          sheets: writtenSheets,
          artifact: artifactMetadata({
            format: 'xlsx',
            ...(sheets[0]?.name ? { title: sheets[0].name } : {}),
            theme,
            summary: { kind: 'sheets', value: sheets.length },
          }),
        });
      } catch (err) {
        if (err instanceof DocsPathError) {
          return errorPayload(err.code, err.hint, { message: err.message });
        }
        const message = err instanceof Error ? err.message : String(err);
        return errorPayload('XLSX_BUILD_FAILED', `生成 Excel 失败:${message}`, {
          message,
        });
      }
    },
  });
}
