import type { GeneratedFileRef } from '@/lib/generatedFiles';

const PRIMARY_EXTENSIONS = new Set([
  // 可直接预览的视觉与网页成果。
  'avif',
  'bmp',
  'gif',
  'heic',
  'heif',
  'htm',
  'html',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'tif',
  'tiff',
  'webp',
  'xhtml',
  // 办公与媒体成果。即使不能在卡内渲染，它们仍是用户可直接使用的文件。
  'csv',
  'doc',
  'docx',
  'epub',
  'glb',
  'gltf',
  'key',
  'm4a',
  'md',
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
  'txt',
  'wav',
  'webm',
  'xls',
  'xlsx',
  'zip',
]);

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
export function isBotSupportingGeneratedFile(file: GeneratedFileRef): boolean {
  return normalizedPathSegments(file.path).some((segment) =>
    SUPPORTING_DIRECTORY_NAMES.has(segment),
  );
}

/**
 * 没有结构化 artifact manifest 时的保守兜底：只把办公文件、媒体、网页等
 * 用户可直接消费的格式提到首层；CSS / JS / JSON / 源码等留在「相关文件」。
 */
export function isBotPrimaryGeneratedFile(file: GeneratedFileRef): boolean {
  if (isBotSupportingGeneratedFile(file)) return false;
  if (file.artifact) return true;
  return PRIMARY_EXTENSIONS.has(generatedFileExtension(file));
}

export function partitionBotGeneratedFiles(files: readonly GeneratedFileRef[]): {
  primary: GeneratedFileRef[];
  related: GeneratedFileRef[];
} {
  const primary: GeneratedFileRef[] = [];
  const related: GeneratedFileRef[] = [];
  for (const file of files) {
    (isBotPrimaryGeneratedFile(file) ? primary : related).push(file);
  }
  return { primary, related };
}
