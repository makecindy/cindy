import type { GeneratedFileRef } from '@/lib/generatedFiles';

const PRIMARY_EXTENSIONS = new Set([
  // 本地媒体协议支持直接预览的视觉成果。
  'avif',
  'bmp',
  'gif',
  'heic',
  'heif',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'tif',
  'tiff',
  'webp',
  // 办公与媒体成果。即使不能在卡内渲染，它们仍是用户可直接使用的文件。
  'csv',
  'doc',
  'docx',
  'epub',
  'glb',
  'gltf',
  'key',
  'm4a',
  'mov',
  'mp3',
  'mp4',
  'numbers',
  'ods',
  'odp',
  'odt',
  'pages',
  'pdf',
  'ppt',
  'pptx',
  'rtf',
  'stl',
  'tsv',
  'wav',
  'webm',
  'xls',
  'xlsx',
  'zip',
]);

const HTML_EXTENSIONS = new Set(['htm', 'html', 'xhtml']);
const GENERIC_HTML_NAMES = new Set(['index.htm', 'index.html', 'index.xhtml', 'preview.html']);

const SUPPORTING_DIRECTORY_NAMES = new Set([
  '.preview',
  '.previews',
  '.tmp',
  '_preview',
  '_previews',
  'preview',
  'previews',
  'temp',
  'tmp',
]);

function normalizedPathSegments(filePath: string): string[] {
  return filePath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

export function generatedFileExtension(file: GeneratedFileRef): string {
  const name = file.name || normalizedPathSegments(file.path).at(-1) || '';
  const match = /\.([^.]+)$/.exec(name);
  return match?.[1]?.toLowerCase() ?? '';
}

/**
 * 伙伴工作目录里的预览截图与临时文件仍然可取，但不能和真正成果并列。
 * 这里只收敛有明确产品语义的辅助目录，不用文件名猜测用户意图。
 */
export function isBotSupportingGeneratedFile(file: GeneratedFileRef, workingDir?: string): boolean {
  const segments = normalizedPathSegments(file.path);
  const root = workingDir ? normalizedPathSegments(workingDir) : [];
  const isWithinRoot = root.length > 0 && root.every((part, index) => segments[index] === part);
  // A workspace itself may be under the OS temp directory. Only its descendants
  // describe supporting material; an explicit document artifact also wins below.
  const relative = isWithinRoot ? segments.slice(root.length) : segments;
  return relative.slice(0, -1).some((segment) =>
    SUPPORTING_DIRECTORY_NAMES.has(segment),
  );
}

/**
 * 没有结构化 artifact manifest 时的保守兜底：只把办公文件、媒体、网页等
 * 用户可直接消费的格式提到首层；CSS / JS / JSON / 源码等留在「相关文件」。
 */
export function isBotPrimaryGeneratedFile(file: GeneratedFileRef, workingDir?: string): boolean {
  if (file.artifact) return true;
  if (isBotSupportingGeneratedFile(file, workingDir)) return false;
  const extension = generatedFileExtension(file);
  if (HTML_EXTENSIONS.has(extension)) {
    // 「index.html」常常只是把多份方案拼起来的内部预览页。真正的网页
    // 成品应该有能表达内容的名字，才会进入首层。
    return !GENERIC_HTML_NAMES.has(file.name.toLowerCase());
  }
  return PRIMARY_EXTENSIONS.has(extension);
}

export function partitionBotGeneratedFiles(files: readonly GeneratedFileRef[], workingDir?: string): {
  primary: GeneratedFileRef[];
  related: GeneratedFileRef[];
} {
  const primary: GeneratedFileRef[] = [];
  const related: GeneratedFileRef[] = [];
  for (const file of files) {
    (isBotPrimaryGeneratedFile(file, workingDir) ? primary : related).push(file);
  }
  return { primary, related };
}
