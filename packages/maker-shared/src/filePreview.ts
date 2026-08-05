import { stripTrailingPathSeparators } from './pathText.js';

export type RemoteFilePreviewKind = 'text' | 'pdf' | 'drawio' | 'office' | 'binary' | 'unknown';

export interface RemoteTextFilePreviewResultLike {
  success: boolean;
  error?: string;
  reason?: 'oversize' | 'not_found' | 'forbidden' | 'read_failed';
  data?: string;
  size: number;
  limitMb?: number;
}

export type TextFilePreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: string; size: number; limitMb?: number }
  | { status: 'unavailable'; message: string; size: number; limitMb?: number };

const SUPPORTED_DOC_EXTS = new Set(['.pdf']);
const SUPPORTED_OFFICE_EXTS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);

// Mirrors desktop shared/textFileExts.ts for remote read-only previews.
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

export function remoteFilePreviewKind(pathOrName: string): RemoteFilePreviewKind {
  const name = basenameRemotePath(pathOrName.split(/[?#]/)[0] ?? '').trim();
  if (!name) return 'unknown';

  const lowerName = name.toLowerCase();
  if (lowerName.endsWith('.drawio') || lowerName.endsWith('.drawio.svg') || lowerName.endsWith('.dio')) {
    return 'drawio';
  }

  const ext = extractRemoteFileExt(name);
  if (SUPPORTED_TEXT_EXTS.has(ext) || (!ext && KNOWN_TEXT_FILENAMES.has(lowerName))) return 'text';
  if (SUPPORTED_DOC_EXTS.has(ext)) return 'pdf';
  if (SUPPORTED_OFFICE_EXTS.has(ext)) return 'office';
  return lowerName.includes('.') ? 'binary' : 'unknown';
}

export function isTextFilePreviewCandidate(pathOrName: string): boolean {
  return remoteFilePreviewKind(pathOrName) === 'text';
}

export function nonTextFilePreviewStatusText(kind: RemoteFilePreviewKind): string {
  if (kind === 'pdf') {
    return 'PDF 文件暂不在手机版内嵌预览;请复制路径,在桌面端或系统 PDF 阅读器中打开。';
  }
  if (kind === 'drawio') {
    return 'Draw.io 文件暂不在手机版内嵌预览;请复制路径,在桌面端继续查看或编辑。';
  }
  if (kind === 'office') {
    return 'Office 文件暂不在手机版内嵌预览;请复制路径,在桌面端或系统应用中打开。';
  }
  if (kind === 'binary') {
    return '当前文件不是文本格式,手机版暂不读取内容;可先复制路径到桌面端打开。';
  }
  return '当前文件类型无法确认,手机版暂不读取内容;可先复制路径到桌面端打开。';
}

export function textPreviewStatusText(
  state: TextFilePreviewState,
  canPreview: boolean,
  kind: RemoteFilePreviewKind = 'text',
): string {
  if (kind !== 'text') return nonTextFilePreviewStatusText(kind);
  if (!canPreview) return '当前文件只有路径信息,无法从远程电脑读取预览。';
  if (state.status === 'loading') return '正在从远程电脑读取文本预览';
  if (state.status === 'ready') {
    const size = formatByteSize(state.size);
    return ['已加载文本预览', size].filter(Boolean).join(' · ');
  }
  if (state.status === 'unavailable') return state.message;
  return '按需读取远程文本预览,不会在消息列表里批量拉取文件内容。';
}

export function describeTextPreviewFailure(result: RemoteTextFilePreviewResultLike): string {
  const size = formatByteSize(result.size);
  if (result.reason === 'oversize') {
    return [
      '文件超过远程预览上限',
      result.limitMb ? `${result.limitMb} MB` : null,
      size ? `当前 ${size}` : null,
    ].filter(Boolean).join(' · ');
  }
  if (result.reason === 'forbidden') return '被控电脑拒绝读取这个路径。';
  if (result.reason === 'not_found') return '被控电脑上没有找到这个文件。';
  if (result.reason === 'read_failed') return result.error ? `读取失败: ${result.error}` : '读取失败。';
  return result.error || '当前文件无法预览。';
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
