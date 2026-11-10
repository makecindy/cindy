/**
 * textPreview — shared rules for previewing text/code/markdown files.
 *
 * Two consumers:
 *   - components/chat/TextLightbox.tsx (full-screen file lightbox)
 *   - features/skillhub/SkillhubDetailView.tsx (sibling files in skill folders)
 *
 * Keeping the extension → language map and fence builder here means adding a
 * new language or markdown alias only requires editing one file, and the
 * behaviour stays in lockstep across surfaces.
 */

import { categorizeByFilename, categorizeFile, extractExt } from './fileTypes';
import { basename } from './utils';

/**
 * Extension → highlight.js language alias.
 *
 * Drives the body renderer: anything in this map is wrapped in a fenced code
 * block and handed to MarkdownRenderer (which runs rehype-highlight). Anything
 * NOT in the map and NOT a markdown extension falls through to the plain
 * `<pre>` path — the safe default for .log/.csv/.txt/unknown files.
 *
 * Aliases (typescript/javascript, xml for html, etc.) are chosen to match the
 * languages registered by rehypeHighlightShared and codemirrorLanguages.
 */
export const EXT_TO_LANG: Record<string, string> = {
  json: 'json',
  jsonc: 'json',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  sol: 'solidity',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  scala: 'scala',
  sc: 'scala',
  groovy: 'groovy',
  gradle: 'groovy',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  hs: 'haskell',
  proto: 'protobuf',
  php: 'php',
  dart: 'dart',
  lua: 'lua',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  xml: 'xml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  vue: 'xml',
  svelte: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  mk: 'makefile',
};

export const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx']);

const COMMON_EXTENSIONLESS_TEXT_FILENAMES = new Set([
  'license',
  'copying',
  'notice',
  'readme',
  'changelog',
  'authors',
  'contributors',
  'todo',
]);

export type Renderable =
  | { kind: 'markdown' }
  | { kind: 'code'; lang: string }
  | { kind: 'text' };

/**
 * Decide how to render the file body based on its name. Filename-only matches
 * (Dockerfile, Makefile — no extension) are checked first so the user gets
 * highlighting on the conventional names.
 */
export function detectRenderable(filePath: string): Renderable {
  const name = basename(filePath).toLowerCase();
  if (name === 'dockerfile') return { kind: 'code', lang: 'dockerfile' };
  if (name === 'makefile') return { kind: 'code', lang: 'makefile' };

  const dotIdx = name.lastIndexOf('.');
  if (dotIdx <= 0) return { kind: 'text' };
  const ext = name.slice(dotIdx + 1);

  if (MARKDOWN_EXTS.has(ext)) return { kind: 'markdown' };
  const lang = EXT_TO_LANG[ext];
  if (lang) return { kind: 'code', lang };
  return { kind: 'text' };
}

/**
 * TextLightbox is intentionally a text/code/markdown previewer. Attachments
 * such as PDF/images are supported by the app, but not by this preview path.
 */
export function isTextPreviewSupported(filePath: string): boolean {
  const name = basename(filePath).trim();
  if (!name) return false;

  const ext = extractExt(name);
  if (ext) {
    return categorizeFile(ext) === 'text';
  }

  return (
    categorizeByFilename(name) === 'text' ||
    COMMON_EXTENSIONLESS_TEXT_FILENAMES.has(name.toLowerCase())
  );
}

/**
 * Wrap raw source in a fenced code block whose backtick run is guaranteed
 * longer than any backtick run inside the source — otherwise a file that
 * itself contains ```...``` (e.g. a Markdown sample committed as `.txt`) would
 * truncate the highlighted block. CommonMark allows any ≥3-backtick fence.
 */
export function buildFence(content: string, lang: string): string {
  let max = 2;
  const re = /`+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[0].length > max) max = m[0].length;
  }
  const fence = '`'.repeat(max + 1);
  return `${fence}${lang}\n${content}\n${fence}`;
}
