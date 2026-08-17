import { promises as fs } from 'node:fs';
import path from 'node:path';

import { extractReviewPdfTextInChild } from './reviewPdfProcess.js';

export type ReviewArtifactExcerptFormat = 'text' | 'pdf-text';

export interface ReviewArtifactExcerpt {
  label: string;
  format: ReviewArtifactExcerptFormat;
  content: string;
  coverage: string;
}

export interface ReviewArtifactWarning {
  label: string;
  message: string;
}

export interface ReviewArtifactContentResult {
  excerpt: ReviewArtifactExcerpt | null;
  warnings: ReviewArtifactWarning[];
}

export interface ReviewArtifactContentInput {
  label: string;
  category?: 'image' | 'pdf' | 'text' | 'office' | 'file';
  mimeType?: string;
  filePath?: string;
  data?: Uint8Array;
  maxChars: number;
}

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES = 40;
const PDF_EXTRACTION_TIMEOUT_MS = 5_000;

class ReviewArtifactTooLargeError extends Error {}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const OFFICE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
]);

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.hpp',
  '.htm',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsonl',
  '.jsx',
  '.kt',
  '.log',
  '.lua',
  '.md',
  '.markdown',
  '.mjs',
  '.mts',
  '.py',
  '.rb',
  '.rs',
  '.rtf',
  '.sh',
  '.sql',
  '.svg',
  '.swift',
  '.tex',
  '.toml',
  '.ts',
  '.tsv',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

function artifactExtension(input: Pick<ReviewArtifactContentInput, 'filePath' | 'label'>): string {
  return input.filePath
    ? path.extname(input.filePath).toLowerCase()
    : path.extname(input.label).toLowerCase();
}

export function classifyReviewArtifact(
  input: Pick<ReviewArtifactContentInput, 'label' | 'category' | 'mimeType' | 'filePath'>,
): 'image' | 'pdf' | 'text' | 'office' | 'other' {
  const extension = artifactExtension(input);
  const mimeType = input.mimeType?.toLowerCase() ?? '';
  if (
    input.category === 'image' ||
    IMAGE_EXTENSIONS.has(extension) ||
    (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml')
  ) {
    return 'image';
  }
  if (input.category === 'pdf' || mimeType === 'application/pdf' || extension === '.pdf') {
    return 'pdf';
  }
  if (
    input.category === 'office' ||
    OFFICE_EXTENSIONS.has(extension) ||
    mimeType.includes('officedocument') ||
    mimeType.startsWith('application/vnd.ms-') ||
    mimeType.startsWith('application/vnd.oasis.opendocument')
  ) {
    return 'office';
  }
  if (input.category === 'text' || mimeType.startsWith('text/') || TEXT_EXTENSIONS.has(extension)) {
    return 'text';
  }
  return 'other';
}

function warning(label: string, message: string): ReviewArtifactWarning {
  return { label, message };
}

async function readPathBounded(
  filePath: string,
  limit: number,
  options: { rejectOversize?: boolean } = {},
): Promise<{ data: Uint8Array; truncated: boolean }> {
  const handle = await fs.open(filePath, 'r');
  try {
    // Open first, then inspect and read the same file descriptor. A separate
    // stat(path) + readFile(path) pair lets another process replace or grow the
    // path between the size check and the unbounded read.
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.nlink > 1) throw new Error('multiply linked artifact file');
    if (options.rejectOversize && stat.size > limit) {
      throw new ReviewArtifactTooLargeError(`artifact exceeds ${limit} bytes`);
    }
    const bytesToRead = Math.min(stat.size, limit + (options.rejectOversize ? 0 : 1));
    const buffer = Buffer.alloc(bytesToRead);
    let bytesRead = 0;
    while (bytesRead < bytesToRead) {
      const chunk = await handle.read(buffer, bytesRead, bytesToRead - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    const finalStat = await handle.stat();
    if (
      finalStat.nlink > 1 ||
      finalStat.size !== stat.size ||
      finalStat.mtimeMs !== stat.mtimeMs
    ) {
      throw new Error('file changed while it was being read');
    }
    return {
      data: buffer.subarray(0, Math.min(bytesRead, limit)),
      truncated: stat.size > limit || bytesRead > limit,
    };
  } finally {
    await handle.close();
  }
}

function decodeText(data: Uint8Array): string | null {
  if (data.byteLength === 0) return '';
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let text: string;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    text = buffer.subarray(2).toString('utf16le');
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      const first = swapped[index];
      swapped[index] = swapped[index + 1] ?? 0;
      swapped[index + 1] = first ?? 0;
    }
    text = swapped.toString('utf16le');
  } else {
    if (buffer.includes(0)) return null;
    text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  }

  if (!text) return '';
  const replacements = [...text].filter((char) => char === '\uFFFD').length;
  const controls = [...text].filter((char) => {
    const code = char.charCodeAt(0);
    return code < 32 && char !== '\n' && char !== '\r' && char !== '\t';
  }).length;
  if (replacements / text.length > 0.02 || controls / text.length > 0.02) return null;
  return text.replace(/\r\n?/g, '\n');
}

function clipText(value: string, maxChars: number): { content: string; clipped: boolean } {
  if (value.length <= maxChars) return { content: value, clipped: false };
  const marker = '\n…（内容已截断）';
  if (maxChars <= marker.length) {
    return { content: marker.slice(0, maxChars), clipped: true };
  }
  return {
    content: `${value.slice(0, maxChars - marker.length)}${marker}`,
    clipped: true,
  };
}

async function extractText(
  input: ReviewArtifactContentInput,
): Promise<ReviewArtifactContentResult> {
  let source: { data: Uint8Array; truncated: boolean };
  try {
    source = input.filePath
      ? await readPathBounded(input.filePath, MAX_TEXT_BYTES)
      : {
          data: (input.data ?? new Uint8Array()).subarray(0, MAX_TEXT_BYTES),
          truncated: (input.data?.byteLength ?? 0) > MAX_TEXT_BYTES,
        };
  } catch (error) {
    return {
      excerpt: null,
      warnings: [
        warning(
          input.label,
          `无法读取文本成果：${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }

  const decoded = decodeText(source.data);
  if (decoded === null) {
    return {
      excerpt: null,
      warnings: [
        warning(input.label, '文件不像可安全提取的文本；内容读取仍取决于当前 reviewer harness。'),
      ],
    };
  }
  if (!decoded.trim()) {
    return {
      excerpt: null,
      warnings: [warning(input.label, '文本成果为空，没有可供审查的正文。')],
    };
  }

  const clipped = clipText(decoded, input.maxChars);
  const incomplete = source.truncated || clipped.clipped;
  return {
    excerpt: {
      label: input.label,
      format: 'text',
      content: clipped.content,
      coverage: incomplete ? '只提取了文件开头的有界文本，后续内容未覆盖' : '已提取完整文本',
    },
    warnings: incomplete
      ? [warning(input.label, '文本超过本地审查上限，只向 reviewer 提供了开头部分。')]
      : [],
  };
}

async function extractPdf(input: ReviewArtifactContentInput): Promise<ReviewArtifactContentResult> {
  let data: Uint8Array;
  try {
    if (input.filePath) {
      data = (await readPathBounded(input.filePath, MAX_PDF_BYTES, { rejectOversize: true })).data;
    } else {
      const source = input.data ?? new Uint8Array();
      if (source.byteLength > MAX_PDF_BYTES) {
        return {
          excerpt: null,
          warnings: [
            warning(
              input.label,
              `PDF 大于 ${MAX_PDF_BYTES / (1024 * 1024)} MB，本地 reviewer 未解析正文。`,
            ),
          ],
        };
      }
      data = new Uint8Array(source);
    }
  } catch (error) {
    if (error instanceof ReviewArtifactTooLargeError) {
      return {
        excerpt: null,
        warnings: [
          warning(
            input.label,
            `PDF 大于 ${MAX_PDF_BYTES / (1024 * 1024)} MB，本地 reviewer 未解析正文。`,
          ),
        ],
      };
    }
    return {
      excerpt: null,
      warnings: [
        warning(
          input.label,
          `无法读取 PDF：${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }

  if (data.byteLength === 0) {
    return { excerpt: null, warnings: [warning(input.label, 'PDF 为空，没有可供审查的内容。')] };
  }

  try {
    const extracted = await extractReviewPdfTextInChild(data, input.maxChars, {
      timeoutMs: PDF_EXTRACTION_TIMEOUT_MS,
      maxPages: MAX_PDF_PAGES,
      maxInputBytes: MAX_PDF_BYTES,
    });
    const pagesLimited = extracted.numPages > extracted.pagesInspected;
    const visualWarning = warning(
      input.label,
      '本地已提供 PDF 可提取文字，但复杂多栏的阅读顺序可能失真，页面排版、图片、表单、签名和扫描页没有可靠的跨 harness 视觉覆盖。',
    );
    if (extracted.sections.length === 0) {
      return {
        excerpt: null,
        warnings: [
          warning(input.label, 'PDF 没有可提取文字，可能是扫描件或纯图片；不得声称已审查正文。'),
          visualWarning,
        ],
      };
    }
    const incomplete = pagesLimited || extracted.clipped;
    return {
      excerpt: {
        label: input.label,
        format: 'pdf-text',
        content: extracted.sections.join('\n\n'),
        coverage: incomplete
          ? `已提取前 ${extracted.pagesInspected} 页范围内的有界文字，PDF 共 ${extracted.numPages} 页，后续或超长内容未覆盖`
          : `已提取全部 ${extracted.numPages} 页中的可提取文字`,
      },
      warnings: [
        visualWarning,
        ...(incomplete
          ? [warning(input.label, 'PDF 文字超过页数或长度上限，只提供了有界摘录。')]
          : []),
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const passwordProtected = /password/i.test(message);
    return {
      excerpt: null,
      warnings: [
        warning(
          input.label,
          passwordProtected
            ? 'PDF 受密码保护，本地 reviewer 无法读取正文。'
            : `PDF 文字提取失败：${message}`,
        ),
        warning(input.label, '页面视觉未被可靠覆盖；不得把文件路径已传给模型当作已完成审查。'),
      ],
    };
  }
}

export async function extractReviewArtifactContent(
  input: ReviewArtifactContentInput,
): Promise<ReviewArtifactContentResult> {
  if (input.maxChars <= 0) {
    return {
      excerpt: null,
      warnings: [warning(input.label, '成果正文超过本轮统一摘录预算，未直接放入 reviewer 提示。')],
    };
  }
  const artifactKind = classifyReviewArtifact(input);
  if (artifactKind === 'pdf') return extractPdf(input);
  if (artifactKind === 'text') return extractText(input);
  if (artifactKind === 'office') {
    return {
      excerpt: null,
      warnings: [
        warning(
          input.label,
          'Office 文档尚未做统一的本地正文转换，读取效果取决于当前 reviewer harness；结论必须声明覆盖缺口。',
        ),
      ],
    };
  }
  return { excerpt: null, warnings: [] };
}
