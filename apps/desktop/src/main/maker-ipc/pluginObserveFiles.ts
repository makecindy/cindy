import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { normalizeSandboxHref, splitLocalLineSuffix } from '../../shared/markdownLocalHref.js';
import { extractMediaPathQuery } from '../../shared/remoteMediaUrl.js';
import type { PluginObserveFile, PluginObserveFiles as ObserveFilesResult } from '../../shared/pluginObserve.js';
import { detectSensitivePath } from '../security/sensitivePath.js';
import { visibleMessageText } from '../localDb/conversationSearch.pure.js';

export interface ObserveFileSource {
  /** Actual task execution directory; null means its worktree binding is unavailable. */
  root: string | null;
  identity: string;
  rows: Array<{ id: string; content: string; agentMeta: string | null; createdAt: number }>;
  partial: boolean;
  assertCurrent(): Promise<void>;
}

const MAX_FILES = 100;
const MAX_MESSAGE_CHARS = 128_000;
const MAX_LINK_LENGTH = 4096;
const fail = (code: string): never => { throw new Error(code); };

function isFinalAnswer(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const meta = JSON.parse(raw);
    return meta?.turnCompleted === true && meta?.assistantPhase !== 'commentary' &&
      !meta?.reviewRun && !meta?.parentUuid && !meta?.botPrivateReply;
  } catch { return false; }
}

/** Markdown's parser excludes code fences/inline code and resolves explicit reference links. */
function fileLinks(content: string): string[] {
  const links: string[] = [];
  marked.walkTokens(marked.lexer(visibleMessageText('assistant', content)), (token) => {
    if ((token.type !== 'link' && token.type !== 'image') || !/^!?\[/.test(token.raw)) return;
    const href = token.href;
    if (!href || href.startsWith('#')) return;
    // Normalize source locations before scheme detection (report.md:10:2 is a file).
    const target = splitLocalLineSuffix(normalizeSandboxHref(href)).href;
    // Web links (including Issue/PR links) are not local file references.
    if (/^[a-z][a-z\d+.-]*:/i.test(target) &&
        !/^(?:file|xdt-file|cindy-media|sandbox):/i.test(target) && !/^[a-z]:[\/\\]/i.test(target)) return;
    if (!links.includes(href)) links.push(href);
  });
  return links;
}

type Resolution = { status: PluginObserveFile['status']; name: string; relativePath?: string; root?: string };

async function resolveFile(root: string | null, href: string): Promise<Resolution> {
  let candidate = normalizeSandboxHref(href);
  if (/^(?:cindy-media|sandbox):/i.test(candidate)) return { status: 'unsupported', name: 'media' };
  try {
    if (/^xdt-file:\/\/local\//i.test(candidate)) {
      const url = new URL(candidate);
      if (url.username || url.password || url.port) return { status: 'not-local', name: 'file' };
      const local = extractMediaPathQuery(candidate);
      if (!local) return { status: 'blocked', name: 'file' };
      candidate = local;
    } else if (/^(?:file|xdt-file):/i.test(candidate)) {
      const url = new URL(candidate.replace(/^xdt-file:/i, 'file:'));
      if (url.hostname || url.username || url.password) return { status: 'not-local', name: 'file' };
      candidate = fileURLToPath(url);
    } else {
      candidate = decodeURIComponent(candidate.split(/[?#]/, 1)[0]!);
    }
  } catch { return { status: 'blocked', name: 'file' }; }
  // Cindy's Markdown file links may carry a source line suffix.
  candidate = splitLocalLineSuffix(candidate).href;
  const name = path.win32.basename(candidate).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'file';
  const result = (status: Resolution['status']): Resolution => ({ name, status });
  if (/^[\/\\]{2}|^[\/\\]\?\?[\/\\]/.test(candidate) ||
      (process.platform !== 'win32' && /^[a-z]:[\/\\]/i.test(candidate))) return result('not-local');
  if (!candidate || candidate.length > MAX_LINK_LENGTH || candidate.includes('\0') ||
      candidate.split(/[\/\\]/).includes('..')) return result('blocked');
  if (!root) return result('missing');
  try {
    const realRoot = await fs.realpath(root);
    const absolute = path.resolve(root, candidate);
    const relative = path.relative(path.resolve(root), absolute);
    if (!relative || path.isAbsolute(relative) || relative.startsWith('..') ||
        relative.split(/[\/\\]/).some(part => part.startsWith('.')) ||
        detectSensitivePath(relative, { allowEnvTemplates: false, excludeCredentialConfigDirs: true })) return result('blocked');
    // Do not follow symlinks/junctions, including intermediate directories. Hard links
    // are refused too: being named inside a project does not establish file ownership.
    let current = realRoot;
    const parts = relative.split(path.sep);
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]!);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) return result('blocked');
    }
    const real = await fs.realpath(current);
    if (real !== current) return result('blocked');
    return { name, status: 'available', root: realRoot, relativePath: relative };
  } catch (error) {
    return result((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'blocked');
  }
}

/** IDs are process-local MACs, scoped to the exact plugin approval and source facts. */
export class PluginObserveFiles {
  private readonly secret = randomBytes(32);
  constructor(private readonly deps: {
    read(project: string, taskId: string): Promise<ObserveFileSource>;
    open(taskId: string, relativePath: string, guard: () => void): void;
  }) {}

  private async collect(project: string, taskId: string, scope: string, guard: () => void) {
    guard();
    const source = await this.deps.read(project, taskId);
    guard();
    const entries: Array<{ file: PluginObserveFile; href: string; resolution: Resolution }> = [];
    let partial = source.partial;
    rows: for (const row of source.rows) {
      if (entries.length === MAX_FILES) { partial = true; break; }
      if (!isFinalAnswer(row.agentMeta)) continue;
      if (row.content.length > MAX_MESSAGE_CHARS) { partial = true; continue; }
      for (const href of fileLinks(row.content)) {
        if (entries.length === MAX_FILES) { partial = true; break rows; }
        if (href.length > MAX_LINK_LENGTH) { partial = true; continue; }
        const resolution = await resolveFile(source.root, href);
        guard();
        const fileId = createHmac('sha256', this.secret).update(JSON.stringify([
          scope, project, taskId, source.identity, source.root, row.id, row.content, href,
          // Root retargeting cannot reuse an available file ID.
          resolution.root ?? null,
        ])).digest('hex');
        entries.push({ href, resolution, file: { fileId, name: resolution.name, referencedAt: row.createdAt,
          source: 'final-answer-link', status: resolution.status } });
      }
    }
    await source.assertCurrent();
    guard();
    return { entries, partial, source };
  }

  async list(project: string, taskId: string, scope: string, guard: () => void): Promise<ObserveFilesResult> {
    const result = await this.collect(project, taskId, scope, guard);
    return { files: result.entries.map(entry => entry.file), partial: result.partial };
  }

  async open(project: string, taskId: string, fileId: string, scope: string, guard: () => void): Promise<void> {
    const result = await this.collect(project, taskId, scope, guard);
    const entry = result.entries.find(item => item.file.fileId === fileId);
    if (!entry) return fail('TARGET_UNAVAILABLE');
    const current = await resolveFile(result.source.root, entry.href);
    if (current.status !== 'available' || current.root !== entry.resolution.root || !current.relativePath) return fail('FILE_UNAVAILABLE');
    await result.source.assertCurrent();
    guard();
    this.deps.open(taskId, current.relativePath, guard);
  }
}
