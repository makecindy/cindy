import { stripTrailingPathSeparators } from '@cindy/maker-shared/path-text';
import { i18n } from '@/i18n';
import type { RemoteFileRef, RemoteImageRef, RemoteSerializedAttachment } from '@/session/types';
import { buildLegacyAttachmentOssRef } from '@/session/attachmentOssRef';

export type MobileAttachmentCategory = RemoteSerializedAttachment['category'];

export const MOBILE_MAX_ATTACHMENTS = 20;
export const MOBILE_MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;

const SUPPORTED_IMAGE_EXTS = new Set(['.jpeg', '.jpg', '.png', '.gif', '.webp']);
const SUPPORTED_DOC_EXTS = new Set(['.pdf']);
const SUPPORTED_OFFICE_EXTS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);

// Mirrors desktop shared/textFileExts.ts for the mobile remote-path attachment path.
const SUPPORTED_TEXT_EXTS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.cs', '.rb', '.php',
  '.swift', '.kt', '.kts', '.scala', '.groovy', '.coffee',
  '.lua', '.dart', '.r', '.pl', '.pm', '.ex', '.exs', '.elm',
  '.clj', '.cljs', '.cljc', '.fs', '.fsi', '.fsx', '.ml', '.mli',
  '.hs', '.erl', '.hrl', '.zig', '.nim', '.vim', '.applescript',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd',
  '.html', '.htm', '.xhtml', '.css', '.scss', '.sass', '.less', '.styl',
  '.vue', '.svelte', '.astro', '.svg',
  '.json', '.json5', '.jsonc', '.jsonl', '.ndjson', '.geojson',
  '.yaml', '.yml', '.xml', '.toml', '.ini', '.conf', '.cfg', '.properties',
  '.plist', '.tf', '.tfvars', '.hcl', '.gradle', '.cmake', '.mk', '.mak',
  '.lock', '.csv', '.tsv',
  '.md', '.markdown', '.mdx', '.rst', '.tex', '.bib', '.cls', '.sty',
  '.adoc', '.asciidoc', '.org', '.txt', '.text',
  '.log', '.diff', '.patch',
  '.srt', '.vtt',
  '.po', '.pot',
  '.sln', '.csproj', '.vbproj', '.fsproj', '.gemspec', '.podspec', '.cabal',
  '.sql', '.graphql', '.proto', '.dockerfile',
  '.rss', '.atom',
  '.gitignore', '.gitattributes', '.gitconfig', '.gitmodules', '.gitkeep',
  '.dockerignore', '.eslintignore', '.prettierignore', '.npmignore',
  '.editorconfig', '.env', '.env.local', '.env.development', '.env.production', '.env.example',
  '.prettierrc', '.eslintrc', '.babelrc', '.npmrc', '.yarnrc',
  '.stylelintrc', '.huskyrc', '.lintstagedrc', '.browserslistrc',
  '.nvmrc', '.node-version', '.python-version', '.ruby-version', '.tool-versions',
]);

const COMPOUND_EXTS = ['.env.example', '.env.local', '.env.development', '.env.production'];
const KNOWN_TEXT_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'gemfile',
  'rakefile',
  'procfile',
  'vagrantfile',
  'jenkinsfile',
  'cmakelists',
]);

/** 本机文件附件的体积校验(乐观上传后台任务里执行,超限 throw 由失败回调呈现)。 */
export function assertMobileDocumentSize(size: number): void {
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(i18n.t('composer.upload.emptyFile'));
  }
  if (size > MOBILE_MAX_ATTACHMENT_BYTES) {
    throw new Error(i18n.t('composer.upload.fileTooLarge', { size: Math.round(MOBILE_MAX_ATTACHMENT_BYTES / 1024 / 1024) }));
  }
}

export function normalizeAttachmentDraftInput(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function basenameRemotePath(remotePath: string): string {
  const normalized = stripTrailingPathSeparators(remotePath);
  const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

export function extractRemoteFileExt(name: string): string {
  const lower = name.toLowerCase();
  for (const compound of COMPOUND_EXTS) {
    if (lower.endsWith(compound)) return compound;
  }
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx < 0) return '';
  if (dotIdx === 0) return lower;
  return lower.slice(dotIdx);
}

export function categorizeMobileAttachment(name: string): MobileAttachmentCategory | null {
  const ext = extractRemoteFileExt(name);
  if (SUPPORTED_IMAGE_EXTS.has(ext)) return 'image';
  if (SUPPORTED_DOC_EXTS.has(ext)) return 'pdf';
  if (SUPPORTED_OFFICE_EXTS.has(ext)) return 'office';
  if (SUPPORTED_TEXT_EXTS.has(ext)) return 'text';
  if (!ext && KNOWN_TEXT_FILENAMES.has(name.toLowerCase())) return 'text';
  return null;
}

export function mimeTypeForMobileAttachment(
  ext: string,
  category: MobileAttachmentCategory,
): string {
  if (category === 'pdf') return 'application/pdf';
  if (category === 'text') return 'text/plain';
  if (category === 'office') {
    const lower = ext.toLowerCase();
    if (lower === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (lower === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (lower === '.pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (lower === '.doc') return 'application/msword';
    if (lower === '.xls') return 'application/vnd.ms-excel';
    if (lower === '.ppt') return 'application/vnd.ms-powerpoint';
    return 'application/octet-stream';
  }
  const lower = ext.toLowerCase();
  if (lower === '.jpeg' || lower === '.jpg') return 'image/jpeg';
  if (lower === '.png') return 'image/png';
  if (lower === '.gif') return 'image/gif';
  if (lower === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

export function buildMobileRemoteFileAttachment(
  remotePath: string,
  opts: { id?: string; size?: number } = {},
): RemoteSerializedAttachment | null {
  const path = normalizeAttachmentDraftInput(remotePath);
  if (!path) return null;
  const name = basenameRemotePath(path);
  if (!name) return null;
  const category = categorizeMobileAttachment(name);
  if (!category) return null;
  const ext = extractRemoteFileExt(name);
  return {
    id: opts.id ?? `mobile-remote-file:${path}`,
    name,
    path,
    ext,
    size: opts.size ?? 0,
    category,
    mimeType: mimeTypeForMobileAttachment(ext, category),
  };
}

export function buildMobileUploadedAttachment(input: {
  ossKey: string;
  name: string;
  size: number;
  sha256: string;
  mimeType?: string;
  id?: string;
}): RemoteSerializedAttachment | null {
  if (!input.ossKey.trim()) return null;
  if (!Number.isFinite(input.size) || input.size <= 0 || input.size > MOBILE_MAX_ATTACHMENT_BYTES) return null;
  const name = basenameRemotePath(input.name).trim();
  if (!name) return null;
  const category = categorizeMobileAttachment(name);
  if (!category) return null;
  const ext = extractRemoteFileExt(name);
  const mimeType = input.mimeType?.trim() || mimeTypeForMobileAttachment(ext, category);
  const ref = buildLegacyAttachmentOssRef({
    ossKey: input.ossKey,
    mimeType,
    originalName: name,
    size: input.size,
    sha256: input.sha256,
  });
  return {
    id: input.id ?? `mobile-upload:${input.ossKey}`,
    name,
    path: ref,
    ext,
    size: input.size,
    sha256: input.sha256,
    category,
    mimeType,
    ...(category === 'image' ? { url: ref } : {}),
    originalName: name,
  };
}

export function buildAttachmentPersistFileRefs(
  attachments: readonly RemoteSerializedAttachment[],
): RemoteFileRef[] {
  return attachments
    .filter((item) => item.category !== 'image')
    .map((item) => ({
      name: item.name,
      path: item.path,
      ...(item.sha256 ? { size: item.size, sha256: item.sha256 } : {}),
    }));
}

export function buildAttachmentPersistImageRefs(
  attachments: readonly RemoteSerializedAttachment[],
): RemoteImageRef[] {
  // 字段名必须是 originalName:桌面 renderer 的 isValidImageRef 按 desktop
  // ImageRef schema 校验 persisted content,历史上这里写 `name` 导致手机贴图
  // 在桌面版被静默过滤不渲染。
  return attachments
    .filter((item) => item.category === 'image')
    .map((item) => ({
      url: item.url || item.path,
      originalName: item.originalName ?? item.name,
      mimeType: item.mimeType,
      ...(item.sha256 ? { size: item.size, sha256: item.sha256 } : {}),
    }));
}

export function attachmentDisplayLabel(attachment: RemoteSerializedAttachment): string {
  return attachment.size > 0 ? `${attachment.name} · ${formatBytes(attachment.size)}` : attachment.name;
}

/** 乐观上传中的 pending 卡文案(与 attachmentDisplayLabel 同格式)。 */
export function pendingUploadDisplayLabel(pending: { name: string; size: number }): string {
  return pending.size > 0 ? `${pending.name} · ${formatBytes(pending.size)}` : pending.name;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
