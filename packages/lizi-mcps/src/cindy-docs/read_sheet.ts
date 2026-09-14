/**
 * cindy-docs/read_sheet.ts —— 读取本地表格文件(xlsx / csv / tsv)成结构化行。
 *
 * 只读工具,进 READ_ONLY_MCP_TOOLS 免审批 —— 路径已被钳制在会话工作目录内,
 * 不外发内容、无副作用。
 *
 * 截断口径:超出 maxRows 时**明确标注** truncated / totalRows,不静默截断。
 * 模型据此决定是分批再读还是换个思路(例如让 Excel 自己算而不是把全表读进上下文)。
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { z } from 'zod';

import type { DocsToolRegistry } from '../cindy_docsToolRegistry.js';
import {
  DocsPathError,
  prepareInputPath,
  readInputFileWithinLimit,
  resolveSessionRoot,
} from './_paths.js';
import { errorPayload, okPayload } from './_payload.js';
import { decodeUnicodeText } from './_textEncoding.js';
import { delimiterForExtension, parseDelimitedWindow } from './csv.js';
import { READ_SHEET_RUNTIME_PACKAGES } from './readSheetRuntimeDeps.js';
import type { DocsMcpSessionCtx } from './types.js';

const DEFAULT_MAX_ROWS = 200;
const HARD_MAX_ROWS = 5000;
const DEFAULT_MAX_COLUMNS = 64;
const HARD_MAX_COLUMNS = 256;
/** 文本表格的读入上限(字节)。超过就拒读,避免把几百 MB 日志当 csv 塞进内存。 */
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
/** xlsx 在 ExcelJS 中会展开 ZIP,压缩包与展开后都设硬上限。 */
const MAX_XLSX_BYTES = 32 * 1024 * 1024;
export const MAX_XLSX_ZIP_ENTRIES = 4096;
const XLSX_READ_TIMEOUT_MS = 15_000;

const DESCRIPTION = [
  '读取工作目录内的表格文件(.xlsx / .csv / .tsv),返回结构化的二维数据。',
  '',
  '【何时用】用户让你分析、汇总、核对一份表格;或者你刚用 make_xlsx 生成了文件,',
  '要回读确认内容真的写进去了(产出自检)。',
  '',
  '【参数】sheet 只对 xlsx 有效,可传工作表名或 1 起的序号;不传取第一张。',
  'startRow 是 1 起的起始行,默认 1;maxRows 默认 200,最大 5000。',
  `startColumn 是 1 起的起始列,默认 1;maxColumns 默认 ${DEFAULT_MAX_COLUMNS},最大 ${HARD_MAX_COLUMNS}。`,
  '返回里 truncated=true 表示后面还有更多行,nextStartRow 可直接用于下一次读取;',
  'totalRows 是实际总行数 —— 别把截断当成「表就这么大」。',
  '',
  '【返回】rows 是二维数组(每格为字符串、数字、布尔或 null);',
  'xlsx 的公式格返回其缓存的计算结果,日期返回 ISO 字符串。',
  'csv / tsv 支持 UTF-8，以及带 BOM 的 UTF-16LE / UTF-16BE 导出文件。',
  'xlsx 会先检查文件大小与 ZIP 解压比,再在受限 worker 中解析(15 秒超时);超限会返回 FILE_TOO_LARGE/READ_TIMEOUT。',
  '',
  '【读不到时】文件不在工作目录内会返回 PATH_NOT_ALLOWED,不存在返回 NOT_A_FILE。',
  '.xls(老二进制格式)不支持,先让用户另存为 .xlsx。',
].join('\n');

type SheetCell = string | number | boolean | null;

interface SheetRead {
  rows: SheetCell[][];
  totalRows: number;
  totalColumns: number;
  startColumn: number;
  endColumn: number;
  sheetName?: string;
  sheetNames?: string[];
}

function xlsxTooLarge(bytes: number): DocsPathError {
  return new DocsPathError(
    'FILE_TOO_LARGE',
    `工作簿过大: ${bytes} 字节`,
    `这个 .xlsx 文件有 ${(bytes / 1024 / 1024).toFixed(1)} MB,超出单次读取上限(32 MB)。请先拆分工作簿,或改用命令行工具处理。`,
  );
}

const XLSX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const JSZip = require(workerData.jszipPath);
const ExcelJS = require(workerData.exceljsPath);

const MAX_XLSX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_XLSX_COMPRESSION_RATIO = 100;
const MAX_XLSX_ZIP_ENTRIES = 4096;

function findSignature(bytes, signature, start, end) {
  for (let i = end - 4; i >= start; i -= 1) {
    if (
      bytes[i] === (signature & 0xff) &&
      bytes[i + 1] === ((signature >>> 8) & 0xff) &&
      bytes[i + 2] === ((signature >>> 16) & 0xff) &&
      bytes[i + 3] === ((signature >>> 24) & 0xff)
    ) return i;
  }
  return -1;
}

function centralDirectoryEntryCount(archive) {
  const bytes = new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findSignature(bytes, 0x06054b50, Math.max(0, bytes.length - 0xffff - 22), bytes.length);
  if (eocd < 0) return null;
  const declared = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (declared === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    return MAX_XLSX_ZIP_ENTRIES + 1;
  }
  if (declared > MAX_XLSX_ZIP_ENTRIES) return declared;
  const end = directoryOffset + directorySize;
  if (!Number.isSafeInteger(end) || end > bytes.length) return null;
  let offset = directoryOffset;
  let count = 0;
  while (offset < end) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) return null;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + nameLength + extraLength + commentLength;
    count += 1;
    if (count > MAX_XLSX_ZIP_ENTRIES) return count;
  }
  return offset === end ? count : null;
}

async function assertSafeXlsxArchive(archive) {
  const entryCount = centralDirectoryEntryCount(archive);
  if (entryCount !== null && entryCount > MAX_XLSX_ZIP_ENTRIES) {
    const error = new Error('工作簿 ZIP 条目过多');
    error.code = 'FILE_TOO_LARGE';
    error.hint = '这个工作簿包含过多 ZIP 条目,为保护 Cindy 已拒绝读取。请拆分工作簿或重新保存为普通 .xlsx。';
    throw error;
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(archive, { createFolders: false });
  } catch {
    // 让 ExcelJS 给出原本的格式错误信息,这里仅负责资源边界。
    return;
  }
  let compressed = 0;
  let uncompressed = 0;
  for (const entry of Object.values(zip.files)) {
    const data = entry._data;
    if (!data) continue;
    compressed += data.compressedSize || 0;
    uncompressed += data.uncompressedSize || 0;
    if (uncompressed > MAX_XLSX_UNCOMPRESSED_BYTES) {
      const error = new Error('工作簿解压后过大');
      error.code = 'FILE_TOO_LARGE';
      error.hint = '这个工作簿的解压体积超过 128 MB,为保护 Cindy 已拒绝读取。请先拆分或重新保存文件。';
      throw error;
    }
  }
  const ratio = compressed > 0 ? uncompressed / compressed : Number.POSITIVE_INFINITY;
  if (ratio > MAX_XLSX_COMPRESSION_RATIO) {
    const error = new Error('工作簿压缩比异常');
    error.code = 'FILE_TOO_LARGE';
    error.hint = '这个工作簿疑似是异常压缩包,为保护 Cindy 已拒绝读取。请用 Excel/WPS 重新另存为 .xlsx 后再试。';
    throw error;
  }
}

function normalizeCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('result' in value) return normalizeCell(value.result);
    if ('formula' in value) return '=' + String(value.formula);
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('hyperlink' in value && typeof value.hyperlink === 'string') return value.hyperlink;
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
    if ('error' in value) return String(value.error);
  }
  return String(value);
}

(async () => {
  await assertSafeXlsxArchive(workerData.archive);
  const workbook = new ExcelJS.Workbook();
  // 主线程通过受限文件句柄只读取一次；worker 解析同一份已经过大小与 ZIP
  // 边界校验的字节，不能再按路径重开一个可能已被替换的文件。
  await workbook.xlsx.load(Buffer.from(workerData.archive));
  const sheetNames = workbook.worksheets.map((ws) => ws.name);
  if (sheetNames.length === 0) {
    return parentPort.postMessage({
      rows: [],
      totalRows: 0,
      totalColumns: 0,
      startColumn: workerData.startColumn,
      endColumn: workerData.startColumn - 1,
      sheetNames,
    });
  }
  let worksheet = workbook.worksheets[0];
  if (typeof workerData.sheetSelector === 'number') worksheet = workbook.worksheets[workerData.sheetSelector - 1];
  else if (typeof workerData.sheetSelector === 'string' && workerData.sheetSelector.length > 0) {
    worksheet = workbook.worksheets.find((ws) => ws.name === workerData.sheetSelector);
  }
  if (!worksheet) {
    const error = new Error('SHEET_NOT_FOUND');
    error.code = 'SHEET_NOT_FOUND';
    error.available = sheetNames;
    throw error;
  }
  const totalRows = Math.max(worksheet.rowCount || 0, worksheet.actualRowCount || 0);
  const totalColumns = Math.max(worksheet.columnCount || 0, worksheet.actualColumnCount || 0);
  const rows = [];
  const firstRow = workerData.startRow;
  const lastRow = Math.min(totalRows, firstRow + workerData.maxRows - 1);
  const firstColumn = workerData.startColumn;
  const lastColumn = Math.min(totalColumns, firstColumn + workerData.maxColumns - 1);
  for (let r = firstRow; r <= lastRow; r += 1) {
    const row = worksheet.getRow(r);
    const cells = [];
    for (let c = firstColumn; c <= lastColumn; c += 1) cells.push(normalizeCell(row.getCell(c).value));
    rows.push(cells);
  }
  parentPort.postMessage({
    rows,
    totalRows,
    totalColumns,
    startColumn: firstColumn,
    endColumn: Math.max(firstColumn - 1, lastColumn),
    sheetName: worksheet.name,
    sheetNames,
  });
})().catch((error) => parentPort.postMessage({ error: {
  code: error.code,
  message: String(error.message || error),
  hint: error.hint,
  available: error.available,
} }));
`;

function readXlsxInWorker(
  archive: Buffer,
  sheetSelector: string | number | undefined,
  startRow: number,
  maxRows: number,
  startColumn: number,
  maxColumns: number,
): Promise<SheetRead> {
  return new Promise((resolve, reject) => {
    // readInputFileWithinLimit 使用独占 ArrayBuffer；转移所有权可避免在主进程
    // 与 worker 间再复制一份最多 32 MB 的工作簿。
    const archiveBuffer = archive.buffer as ArrayBuffer;
    const archiveView = new Uint8Array(
      archiveBuffer,
      archive.byteOffset,
      archive.byteLength,
    );
    const worker = new Worker(XLSX_WORKER_SOURCE, {
      eval: true,
      workerData: {
        archive: archiveView,
        sheetSelector,
        startRow,
        maxRows,
        startColumn,
        maxColumns,
        jszipPath: createRequire(import.meta.url).resolve(READ_SHEET_RUNTIME_PACKAGES[0]),
        exceljsPath: createRequire(import.meta.url).resolve(READ_SHEET_RUNTIME_PACKAGES[1]),
      },
      transferList: [archiveBuffer],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    timer = setTimeout(() => {
      finish(() => reject(new DocsPathError(
        'READ_TIMEOUT',
        `读取工作簿超时(${XLSX_READ_TIMEOUT_MS}ms)`,
        '这个工作簿解析时间过长,为保护 Cindy 已终止读取。请先拆分或重新保存文件。',
      )));
    }, XLSX_READ_TIMEOUT_MS);
    worker.once('message', (message: { error?: { code?: string; message?: string; hint?: string; available?: string[] } } & SheetRead) => {
      if (message.error) {
        if (message.error.code === 'SHEET_NOT_FOUND') {
          finish(() => reject(new DocsPathError(
            'SHEET_NOT_FOUND',
            `找不到工作表: ${String(sheetSelector)}`,
            `这个文件里的工作表是:${message.error?.available?.join(' / ') || '未知'}。请换一个名称或序号。`,
          )));
        } else if (message.error.code === 'FILE_TOO_LARGE') {
          finish(() => reject(new DocsPathError(
            'FILE_TOO_LARGE',
            message.error?.message || '工作簿资源边界超限',
            message.error?.hint || '这个工作簿触发了安全边界,请拆分或重新保存为普通 .xlsx 后再试。',
          )));
        } else {
          finish(() => reject(Object.assign(new Error(message.error?.message || '读取工作簿失败'), { code: message.error?.code })));
        }
        return;
      }
      finish(() => resolve(message));
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`工作簿解析进程退出(${code})`)));
    });
  });
}

async function readXlsx(
  root: string,
  absPath: string,
  sheetSelector: string | number | undefined,
  startRow: number,
  maxRows: number,
  startColumn: number,
  maxColumns: number,
): Promise<SheetRead> {
  const archive = await readInputFileWithinLimit(root, absPath, MAX_XLSX_BYTES, xlsxTooLarge);
  return readXlsxInWorker(archive, sheetSelector, startRow, maxRows, startColumn, maxColumns);
}

async function readTextTable(
  root: string,
  absPath: string,
  ext: string,
  startRow: number,
  maxRows: number,
  startColumn: number,
  maxColumns: number,
): Promise<SheetRead> {
  const bytes = await readInputFileWithinLimit(
    root,
    absPath,
    MAX_TEXT_BYTES,
    (size) =>
      new DocsPathError(
        'FILE_TOO_LARGE',
        `文本表格过大: ${size} 字节`,
        `这个文件有 ${(size / 1024 / 1024).toFixed(1)} MB,超出单次读取上限(32 MB)。请先让用户拆分文件,或改用命令行工具处理。`,
      ),
  );
  const text = decodeUnicodeText(bytes, '文本表格');
  const parsed = parseDelimitedWindow(text, {
    delimiter: delimiterForExtension(ext),
    startRow,
    maxRows,
    includeTotalColumns: true,
  });
  const totalColumns = parsed.totalColumns ?? 0;
  const endColumn = Math.min(totalColumns, startColumn + maxColumns - 1);
  return {
    rows: parsed.rows.map((row) => row.slice(startColumn - 1, endColumn)),
    totalRows: parsed.totalRows,
    totalColumns,
    startColumn,
    endColumn: Math.max(startColumn - 1, endColumn),
  };
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
      startRow: z
        .number()
        .int()
        .min(1)
        .max(Number.MAX_SAFE_INTEGER - HARD_MAX_ROWS)
        .default(1)
        .describe('从第几行开始返回,1 起。默认 1;配合 nextStartRow 分批继续读取。'),
      maxRows: z
        .number()
        .int()
        .min(1)
        .max(HARD_MAX_ROWS)
        .default(DEFAULT_MAX_ROWS)
        .describe(`最多返回多少行,默认 ${DEFAULT_MAX_ROWS},上限 ${HARD_MAX_ROWS}。`),
      startColumn: z
        .number()
        .int()
        .min(1)
        .max(Number.MAX_SAFE_INTEGER - HARD_MAX_COLUMNS)
        .default(1)
        .describe('从第几列开始返回,1 起。默认 1;配合 nextStartColumn 分批读取宽表。'),
      maxColumns: z
        .number()
        .int()
        .min(1)
        .max(HARD_MAX_COLUMNS)
        .default(DEFAULT_MAX_COLUMNS)
        .describe(`最多返回多少列,默认 ${DEFAULT_MAX_COLUMNS},上限 ${HARD_MAX_COLUMNS}。`),
    },
    handler: async ({ path: inputPath, sheet, startRow, maxRows, startColumn, maxColumns }) => {
      try {
        const root = resolveSessionRoot(sessionCtx);
        const abs = await prepareInputPath(root, inputPath);
        const ext = path.extname(abs).toLowerCase();

        let result: SheetRead;
        if (ext === '.xlsx' || ext === '.xlsm') {
          result = await readXlsx(root, abs, sheet, startRow, maxRows, startColumn, maxColumns);
        } else if (ext === '.csv' || ext === '.tsv' || ext === '.tab' || ext === '.txt') {
          result = await readTextTable(root, abs, ext, startRow, maxRows, startColumn, maxColumns);
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

        const endRow = result.rows.length > 0 ? startRow + result.rows.length - 1 : startRow - 1;
        const truncated = endRow < result.totalRows;
        return okPayload({
          path: abs,
          format: ext.replace('.', ''),
          ...(result.sheetName !== undefined ? { sheet: result.sheetName } : {}),
          ...(result.sheetNames !== undefined ? { sheetNames: result.sheetNames } : {}),
          rows: result.rows,
          startRow,
          endRow,
          returnedRows: result.rows.length,
          totalRows: result.totalRows,
          startColumn: result.startColumn,
          endColumn: result.endColumn,
          totalColumns: result.totalColumns,
          truncated,
          ...(truncated
            ? {
                nextStartRow: endRow + 1,
                truncationNote: `返回了第 ${startRow}–${endRow} 行,总共 ${result.totalRows} 行。需要更多请用 startRow=${endRow + 1} 继续读取(单次上限 ${HARD_MAX_ROWS}),不要把这一页当作全表。`,
              }
            : {}),
          ...(result.endColumn < result.totalColumns
            ? {
                nextStartColumn: result.endColumn + 1,
                columnTruncationNote: `返回了第 ${result.startColumn}–${result.endColumn} 列,总共 ${result.totalColumns} 列。需要更多请用 startColumn=${result.endColumn + 1} 继续读取(单次上限 ${HARD_MAX_COLUMNS})。`,
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
