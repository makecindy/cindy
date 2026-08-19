/**
 * cindy-docs/make_xlsx.ts —— 结构化数据 → Excel 工作簿(.xlsx)。
 *
 * 表头处理是刻意的:加粗 + 浅底 + 冻结首行 + 按内容估宽。用户拿到的第一屏就
 * 应该是能直接看的表,而不是一片等宽未冻结的裸数据。
 */

import { promises as fs } from 'node:fs';

import ExcelJS from 'exceljs';
import { z } from 'zod';

import type { DocsToolRegistry } from '../cindy_docsToolRegistry.js';
import { describeOutput, DocsPathError, prepareOutputPath, resolveSessionRoot } from './_paths.js';
import { errorPayload, okPayload } from './_payload.js';
import type { DocsMcpSessionCtx } from './types.js';

/** 列宽估算上下限:太窄看不全,太宽一屏放不下几列。 */
const MIN_COL_WIDTH = 8;
const MAX_COL_WIDTH = 60;
/** 只用前若干行估宽 —— 万行表逐格量宽既慢又没必要。 */
const WIDTH_SAMPLE_ROWS = 200;
const HEADER_FILL = 'FFF2F3F5';

const DESCRIPTION = [
  '把结构化数据生成为 Excel 工作簿(.xlsx),支持多个工作表。',
  '',
  '【何时用】用户要 Excel / 表格文件 / 对账表 / 可以自己排序筛选的数据。',
  '数据本身要是二维的(行 × 列);一段叙述性文字应该用 make_docx 而不是本工具。',
  '',
  '【格式】每张表的 header 会加粗 + 浅色底 + 冻结首行,列宽按内容自适应。',
  'rows 里的每个单元格可以是字符串、数字、布尔或 null(留空)。',
  '数字请传数字类型而不是字符串,否则 Excel 里不能参与求和。',
  '',
  '【输出】outPath 必须在本任务的工作目录内。目录不存在会自动创建;',
  '同名文件默认不覆盖,确要覆盖再传 overwrite: true。',
].join('\n');

const CellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
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
): void {
  registry.register({
    name: 'make_xlsx',
    category: 'author',
    description: DESCRIPTION,
    inputShape: {
      sheets: z
        .array(
          z.object({
            name: z
              .string()
              .min(1)
              .max(31)
              .describe('工作表名。Excel 限 31 字符,且不能含 : \\ / ? * [ ]。'),
            header: z
              .array(z.string())
              .optional()
              .describe('可选表头行。给了就会加粗 + 冻结首行。'),
            rows: z
              .array(z.array(CellSchema))
              .describe('数据行,每行是一个单元格数组。数字请用数字类型。'),
          }),
        )
        .min(1)
        .describe('工作表列表,至少一张。'),
      outPath: z
        .string()
        .min(1)
        .describe('输出 .xlsx 路径,工作目录内的相对路径或绝对路径。'),
      overwrite: z
        .boolean()
        .default(false)
        .describe('目标文件已存在时是否覆盖。默认 false。'),
    },
    handler: async ({ sheets, outPath, overwrite }) => {
      try {
        const root = resolveSessionRoot(sessionCtx);
        const abs = await prepareOutputPath(root, outPath, overwrite);

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Cindy';
        workbook.created = new Date();

        const usedNames = new Set<string>();
        for (const sheet of sheets) {
          // Excel 的非法工作表字符会让文件直接打不开,静默换成下划线比报错更有用。
          let name = sheet.name.replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
          if (name.trim().length === 0) name = 'Sheet';
          let unique = name;
          let n = 2;
          while (usedNames.has(unique)) {
            const suffix = `_${n}`;
            unique = `${name.slice(0, 31 - suffix.length)}${suffix}`;
            n += 1;
          }
          usedNames.add(unique);

          const ws = workbook.addWorksheet(unique);
          if (sheet.header && sheet.header.length > 0) {
            const headerRow = ws.addRow(sheet.header);
            headerRow.font = { bold: true };
            headerRow.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: HEADER_FILL },
            };
            ws.views = [{ state: 'frozen', ySplit: 1 }];
          }
          for (const row of sheet.rows) {
            ws.addRow(row.map((cell) => (cell === null ? null : cell)));
          }

          const columnCount = Math.max(
            sheet.header?.length ?? 0,
            ...sheet.rows.map((row) => row.length),
            1,
          );
          for (let col = 0; col < columnCount; col += 1) {
            let width = displayWidth(cellText(sheet.header?.[col]));
            const sampled = sheet.rows.slice(0, WIDTH_SAMPLE_ROWS);
            for (const row of sampled) {
              width = Math.max(width, displayWidth(cellText(row[col])));
            }
            ws.getColumn(col + 1).width = Math.min(
              MAX_COL_WIDTH,
              Math.max(MIN_COL_WIDTH, width + 2),
            );
          }
        }

        const arrayBuffer = await workbook.xlsx.writeBuffer();
        await fs.writeFile(abs, Buffer.from(arrayBuffer as ArrayBuffer));
        return okPayload({
          ...(await describeOutput(root, abs)),
          format: 'xlsx',
          sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.length })),
        });
      } catch (err) {
        if (err instanceof DocsPathError) {
          return errorPayload(err.code, err.hint, { message: err.message });
        }
        const message = err instanceof Error ? err.message : String(err);
        return errorPayload('XLSX_BUILD_FAILED', `生成 Excel 失败:${message}`, { message });
      }
    },
  });
}
