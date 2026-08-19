/**
 * cindy-docs/read_sheet.ts —— 读取本地表格文件(xlsx / csv / tsv)成结构化行。
 *
 * 只读工具,进 READ_ONLY_MCP_TOOLS 免审批 —— 路径已被钳制在会话工作目录内,
 * 不外发内容、无副作用。
 *
 * 截断口径:超出 maxRows 时**明确标注** truncated / totalRows,不静默截断。
 * 模型据此决定是分批再读还是换个思路(例如让 Excel 自己算而不是把全表读进上下文)。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import ExcelJS from 'exceljs';
import { z } from 'zod';

import type { DocsToolRegistry } from '../cindy_docsToolRegistry.js';
import { DocsPathError, prepareInputPath, resolveSessionRoot } from './_paths.js';
import { errorPayload, okPayload } from './_payload.js';
import { delimiterForExtension, parseDelimited } from './csv.js';
import type { DocsMcpSessionCtx } from './types.js';

const DEFAULT_MAX_ROWS = 200;
const HARD_MAX_ROWS = 5000;
/** 文本表格的读入上限(字节)。超过就拒读,避免把几百 MB 日志当 csv 塞进内存。 */
const MAX_TEXT_BYTES = 32 * 1024 * 1024;

const DESCRIPTION = [
  '读取工作目录内的表格文件(.xlsx / .csv / .tsv),返回结构化的二维数据。',
  '',
  '【何时用】用户让你分析、汇总、核对一份表格;或者你刚用 make_xlsx 生成了文件,',
  '要回读确认内容真的写进去了(产出自检)。',
  '',
  '【参数】sheet 只对 xlsx 有效,可传工作表名或 1 起的序号;不传取第一张。',
  'maxRows 默认 200,最大 5000。返回里 truncated=true 表示还有更多行,',
  'totalRows 是实际总行数 —— 别把截断当成「表就这么大」。',
  '',
  '【返回】rows 是二维数组(每格为字符串、数字、布尔或 null);',
  'xlsx 的公式格返回其缓存的计算结果,日期返回 ISO 字符串。',
  '',
  '【读不到时】文件不在工作目录内会返回 PATH_NOT_ALLOWED,不存在返回 NOT_A_FILE。',
  '.xls(老二进制格式)不支持,先让用户另存为 .xlsx。',
].join('\n');

type SheetCell = string | number | boolean | null;

/** 把 exceljs 的富值(公式/富文本/超链接/日期/错误)压成一个朴素标量。 */
function normalizeCell(value: unknown): SheetCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // 公式格:优先用缓存结果,没有结果就回落公式文本,让模型知道这是算出来的。
    if ('result' in obj) return normalizeCell(obj.result);
    if ('formula' in obj) return `=${String(obj.formula)}`;
    if ('text' in obj && typeof obj.text === 'string') return obj.text;
    if ('hyperlink' in obj && typeof obj.hyperlink === 'string') return obj.hyperlink;
    if ('richText' in obj && Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>)
        .map((part) => part.text ?? '')
        .join('');
    }
    if ('error' in obj) return String(obj.error);
  }
  return String(value);
}

interface SheetRead {
  rows: SheetCell[][];
  totalRows: number;
  sheetName?: string;
  sheetNames?: string[];
}

async function readXlsx(
  absPath: string,
  sheetSelector: string | number | undefined,
  maxRows: number,
): Promise<SheetRead> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(absPath);
  const sheetNames = workbook.worksheets.map((ws) => ws.name);
  if (sheetNames.length === 0) {
    return { rows: [], totalRows: 0, sheetNames };
  }

  let worksheet = workbook.worksheets[0]!;
  if (typeof sheetSelector === 'number') {
    const found = workbook.worksheets[sheetSelector - 1];
    if (!found) {
      throw new DocsPathError(
        'SHEET_NOT_FOUND',
        `工作表序号越界: ${sheetSelector}`,
        `这个文件只有 ${sheetNames.length} 张工作表(${sheetNames.join(' / ')})。请换一个序号或直接传工作表名。`,
      );
    }
    worksheet = found;
  } else if (typeof sheetSelector === 'string' && sheetSelector.length > 0) {
    const found = workbook.worksheets.find((ws) => ws.name === sheetSelector);
    if (!found) {
      throw new DocsPathError(
        'SHEET_NOT_FOUND',
        `找不到工作表: ${sheetSelector}`,
        `这个文件里没有叫 "${sheetSelector}" 的工作表。可选的是:${sheetNames.join(' / ')}。`,
      );
    }
    worksheet = found;
  }

  const totalRows = worksheet.actualRowCount ?? worksheet.rowCount ?? 0;
  const columnCount = worksheet.actualColumnCount ?? worksheet.columnCount ?? 0;
  const rows: SheetCell[][] = [];
  // eachRow 会跳过完全空的行,而我们要保持行号语义,所以按 1..rowCount 顺序取。
  const lastRow = Math.min(worksheet.rowCount ?? 0, Math.max(totalRows, 0) + maxRows);
  for (let r = 1; r <= lastRow && rows.length < maxRows; r += 1) {
    const row = worksheet.getRow(r);
    const cells: SheetCell[] = [];
    for (let c = 1; c <= columnCount; c += 1) {
      cells.push(normalizeCell(row.getCell(c).value));
    }
    rows.push(cells);
  }
  return { rows, totalRows: Math.max(totalRows, rows.length), sheetName: worksheet.name, sheetNames };
}

async function readTextTable(
  absPath: string,
  ext: string,
  maxRows: number,
): Promise<SheetRead> {
  const stat = await fs.stat(absPath);
  if (stat.size > MAX_TEXT_BYTES) {
    throw new DocsPathError(
      'FILE_TOO_LARGE',
      `文本表格过大: ${stat.size} 字节`,
      `这个文件有 ${(stat.size / 1024 / 1024).toFixed(1)} MB,超出单次读取上限(32 MB)。请先让用户拆分文件,或改用命令行工具处理。`,
    );
  }
  const text = await fs.readFile(absPath, 'utf-8');
  const parsed = parseDelimited(text, { delimiter: delimiterForExtension(ext) });
  return { rows: parsed.slice(0, maxRows), totalRows: parsed.length };
}

export function registerReadSheetTool(
  registry: DocsToolRegistry,
  sessionCtx: DocsMcpSessionCtx,
): void {
  registry.register({
    name: 'read_sheet',
    category: 'read',
    description: DESCRIPTION,
    inputShape: {
      path: z
        .string()
        .min(1)
        .describe('表格文件路径,工作目录内的相对路径或绝对路径。'),
      sheet: z
        .union([z.string(), z.number().int().min(1)])
        .optional()
        .describe('仅 xlsx 有效:工作表名,或 1 起的序号。不传取第一张。'),
      maxRows: z
        .number()
        .int()
        .min(1)
        .max(HARD_MAX_ROWS)
        .default(DEFAULT_MAX_ROWS)
        .describe(`最多返回多少行,默认 ${DEFAULT_MAX_ROWS},上限 ${HARD_MAX_ROWS}。`),
    },
    handler: async ({ path: inputPath, sheet, maxRows }) => {
      try {
        const root = resolveSessionRoot(sessionCtx);
        const abs = await prepareInputPath(root, inputPath);
        const ext = path.extname(abs).toLowerCase();

        let result: SheetRead;
        if (ext === '.xlsx' || ext === '.xlsm') {
          result = await readXlsx(abs, sheet, maxRows);
        } else if (ext === '.csv' || ext === '.tsv' || ext === '.tab' || ext === '.txt') {
          result = await readTextTable(abs, ext, maxRows);
        } else if (ext === '.xls') {
          return errorPayload(
            'UNSUPPORTED_FORMAT',
            '这是老的 .xls 二进制格式,读不了。请让用户在 Excel / WPS 里「另存为」.xlsx 后再试。',
            { path: abs, extension: ext },
          );
        } else {
          return errorPayload(
            'UNSUPPORTED_FORMAT',
            `不支持的表格格式 "${ext}"。支持的是 .xlsx / .xlsm / .csv / .tsv。`,
            { path: abs, extension: ext },
          );
        }

        const truncated = result.totalRows > result.rows.length;
        return okPayload({
          path: abs,
          format: ext.replace('.', ''),
          ...(result.sheetName !== undefined ? { sheet: result.sheetName } : {}),
          ...(result.sheetNames !== undefined ? { sheetNames: result.sheetNames } : {}),
          rows: result.rows,
          returnedRows: result.rows.length,
          totalRows: result.totalRows,
          truncated,
          ...(truncated
            ? {
                truncationNote: `只返回了前 ${result.rows.length} 行,总共 ${result.totalRows} 行。需要更多请调大 maxRows(上限 ${HARD_MAX_ROWS}),不要把这个当作全表。`,
              }
            : {}),
        });
      } catch (err) {
        if (err instanceof DocsPathError) {
          return errorPayload(err.code, err.hint, { message: err.message });
        }
        const message = err instanceof Error ? err.message : String(err);
        return errorPayload('SHEET_READ_FAILED', `读取表格失败:${message}`, { message });
      }
    },
  });
}
