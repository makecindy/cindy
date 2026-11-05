/**
 * officePreview — Word(.docx)/Excel(.xlsx/.xls) 内嵌预览解析层。
 * ---------------------------------------------------------------------------
 * FileBodyView 负责类型分派,FileLightbox 保留统一预览外壳;
 * 这里只负责「字节 → 可渲染数据」:
 *   - .docx       → mammoth 浏览器构建转 HTML,禁用外部文件读取。
 *   - .xlsx/.xls  → SheetJS 逐表 sheet_to_html。
 * 两类输出均视为不可信 HTML,经 DOMPurify 白名单净化后才能进入宿主 DOM。
 * 仅保留阅读排版与内嵌位图;链接显示文字,不触发导航或网络请求。
 *
 * 两个解析库都按需动态 import(Vite 异步 chunk):不预览 office 文件就完全不
 * 加载这部分代码。字节经既有 readFileBytes IPC(路径策略 + 大小上限 + realpath
 * 防交换,见 main/fileReadBytes.ts),上限用 OFFICE_PREVIEW_LIMIT。
 */

import DOMPurify from 'dompurify';

export const OFFICE_PREVIEW_LIMIT_MB = 10;
export const OFFICE_PREVIEW_LIMIT = OFFICE_PREVIEW_LIMIT_MB * 1024 * 1024;
// XLSX 的压缩体积不能约束工作表声明范围;在生成 HTML 前限制迭代量。
const MAX_PREVIEW_CELLS = 100_000;
const MAX_PREVIEW_SHEETS = 100;
const MAX_PREVIEW_MERGE_CHECKS = 5_000_000;
const MAX_EXPANDED_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_CHARACTERS = 2_000_000;

// Stream in small chunks so a forged ZIP size cannot allocate an unbounded inflate
// buffer. Rebuild from the checked entries: parsers must not reinterpret a different
// central directory (or duplicate filename) from the untrusted original archive.
async function boundedOfficeBytes(bytes: Uint8Array, requireZip: boolean): Promise<Uint8Array> {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    // Mammoth's JSZip accepts leading bytes before a ZIP. DOCX/XLSX must never
    // reach a tolerant parser without bounded decompression and normalization.
    if (requireZip) throw new Error('Invalid Office archive');
    return bytes;
  }
  const { Unzip, UnzipInflate, zipSync } = await import('fflate');
  const entries: Record<string, Uint8Array> = Object.create(null);
  let total = 0;
  let count = 0;
  let pending = 0;
  const unzip = new Unzip((file) => {
    if (
      ++count > 2048 ||
      Object.hasOwn(entries, file.name) ||
      (file.originalSize ?? 0) > MAX_EXPANDED_BYTES
    ) {
      throw new Error('Office archive exceeds preview capacity');
    }
    entries[file.name] = new Uint8Array();
    pending++;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, data, final) => {
      if (error) throw error;
      total += data.length;
      if (total > MAX_EXPANDED_BYTES) throw new Error('Office archive exceeds preview capacity');
      chunks.push(data);
      if (final) {
        const entry = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          entry.set(chunk, offset);
          offset += chunk.length;
        }
        entries[file.name] = entry;
        pending--;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
  }
  if (!count || pending) throw new Error('Invalid Office archive');
  return zipSync(entries, { level: 0 });
}

export type OfficePreviewKind = 'word' | 'sheet';

const WORD_PREVIEW_EXTS = new Set(['.docx']);
const SHEET_PREVIEW_EXTS = new Set(['.xlsx', '.xls']);

/** 文件该按哪个 office 分支预览('word' / 'sheet');不支持内嵌时 null。 */
export function officePreviewKind(filePath: string): OfficePreviewKind | null {
  const name = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot).toLowerCase();
  if (WORD_PREVIEW_EXTS.has(ext)) return 'word';
  if (SHEET_PREVIEW_EXTS.has(ext)) return 'sheet';
  return null;
}

export function isOfficePreviewSupported(filePath: string): boolean {
  return officePreviewKind(filePath) !== null;
}

export interface OfficeSheet {
  name: string;
  html: string;
}

export type ParsedOfficeDocument =
  | { kind: 'word'; html: string; size: number }
  | { kind: 'sheet'; sheets: OfficeSheet[]; size: number };

/** Office 解析器不是净化器:链接、富文本 HTML、图片类型均来自不可信文档。 */
export function sanitizeOfficeHtml(html: string): string {
  if (html.length > MAX_OUTPUT_CHARACTERS)
    throw new Error('Office output exceeds preview capacity');
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p',
      'div',
      'span',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'sub',
      'sup',
      'br',
      'hr',
      'ul',
      'ol',
      'li',
      'blockquote',
      'pre',
      'code',
      'table',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'th',
      'td',
      'caption',
      'img',
    ],
    ALLOWED_ATTR: ['colspan', 'rowspan', 'src', 'alt'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const image of fragment.querySelectorAll('img')) {
    // 禁止远端跟踪图片、本机协议与 SVG 主动内容;只保留文档内嵌位图。
    if (
      !/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(
        image.getAttribute('src') ?? '',
      )
    ) {
      image.remove();
    }
  }
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}

/** Read an authorized local copy; formatPath preserves the remote original's extension. */
export async function parseOfficeDocument(
  filePath: string,
  formatPath = filePath,
): Promise<ParsedOfficeDocument> {
  const kind = officePreviewKind(formatPath);
  if (!kind) throw new Error('unsupported office file: ' + filePath);
  const read = await window.electronAPI.readFileBytes({ filePath, maxSize: OFFICE_PREVIEW_LIMIT });
  if (read.bytes.length > OFFICE_PREVIEW_LIMIT)
    throw new Error('Office file exceeds preview capacity');
  const bytes = await boundedOfficeBytes(read.bytes, kind === 'word' || /\.xlsx$/i.test(formatPath));
  if (kind === 'word') {
    const mammoth = (await import('mammoth/mammoth.browser')).default;
    let imageCharacters = 0;
    const { value } = await mammoth.convertToHtml(
      { arrayBuffer: bytes.slice().buffer as ArrayBuffer },
      {
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(async (image) => {
          const data = await image.read('base64');
          imageCharacters += data.length;
          if (imageCharacters > MAX_OUTPUT_CHARACTERS)
            throw new Error('Office output exceeds preview capacity');
          return { src: `data:${image.contentType};base64,${data}` };
        }),
      },
    );
    if (imageCharacters > MAX_OUTPUT_CHARACTERS)
      throw new Error('Office output exceeds preview capacity');
    return { kind, html: sanitizeOfficeHtml(value), size: read.size };
  }
  const XLSX = await import('xlsx');
  const wb = XLSX.read(bytes, { type: 'array', cellHTML: false });
  if (wb.SheetNames.length > MAX_PREVIEW_SHEETS) {
    throw new Error('Office workbook exceeds preview capacity');
  }
  let totalCells = 0;
  let mergeChecks = 0;
  let outputBudget = 0;
  for (const name of wb.SheetNames) {
    const ref = wb.Sheets[name]['!ref'];
    if (!ref) continue;
    const range = XLSX.utils.decode_range(ref);
    const rows = range.e.r - range.s.r + 1;
    const columns = range.e.c - range.s.c + 1;
    totalCells += rows * columns;
    mergeChecks += rows * columns * Math.max(1, wb.Sheets[name]['!merges']?.length ?? 0);
    if (
      rows < 1 ||
      columns < 1 ||
      !Number.isSafeInteger(totalCells) ||
      totalCells > MAX_PREVIEW_CELLS
    ) {
      throw new Error('Office worksheet exceeds preview capacity');
    }
    if (!Number.isSafeInteger(mergeChecks) || mergeChecks > MAX_PREVIEW_MERGE_CHECKS) {
      throw new Error('Office worksheet merge complexity exceeds preview capacity');
    }
    for (let row = range.s.r; row <= range.e.r; row++) {
      for (let column = range.s.c; column <= range.e.c; column++) {
        const cell = wb.Sheets[name][XLSX.utils.encode_cell({ r: row, c: column })];
        // Escape expansion plus markup overhead; count repeated shared strings for
        // every displayed cell before sheet_to_html can multiply them in memory.
        if (cell) delete cell.l;
        outputBudget +=
          128 +
          6 *
            (String(cell ? XLSX.utils.format_cell(cell) : '').length +
              String(cell?.v ?? '').length +
              String(cell?.z ?? '').length);
        if (outputBudget > MAX_OUTPUT_CHARACTERS)
          throw new Error('Office output exceeds preview capacity');
      }
    }
  }
  return {
    kind,
    sheets: wb.SheetNames.map((name) => ({
      name,
      html: sanitizeOfficeHtml(
        XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' }),
      ),
    })),
    size: read.size,
  };
}
