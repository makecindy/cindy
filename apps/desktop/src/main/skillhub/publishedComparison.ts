import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SkillhubContentChange, SkillhubPublishComparison } from '../../shared/skillhubPublishComparison';
import type { Skill } from './scanner';
import type { SkillhubMarketService } from './marketService';
import { isIgnoredSkillPackagePath } from './packageIgnore';
import { activePublishedReviewVersion } from '../../shared/skillhubPublishedStatus';

const MAX_FILES = 2_000;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_REMOTE_PREVIEWS = 16;
const HASH_RE = /^[a-f0-9]{64}$/;
interface ContentFile { path: string; size: number; sha256: string; text?: string }

function safeRelativePath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\\\x00-\x1f]/.test(value)
    && !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Uses the exact local packaging exclusions, including on archives uploaded by other clients. */
export function publishedManifest(value: unknown): ContentFile[] {
  if (!Array.isArray(value)) throw new Error('Incomplete published manifest');
  const files: ContentFile[] = [];
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of value) {
    if (!file || typeof file.path !== 'string' || !safeRelativePath(file.path) || paths.has(file.path)) {
      throw new Error('Invalid published path');
    }
    paths.add(file.path);
    if (isIgnoredSkillPackagePath(file.path)) continue;
    if (files.length >= MAX_FILES) throw new Error('Skill exceeds comparison limit');
    if (typeof file.sha256 !== 'string' || !HASH_RE.test(file.sha256)
      || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Missing file digest');
    bytes += file.size;
    if (bytes > MAX_BYTES) throw new Error('Skill exceeds comparison limit');
    files.push({ path: file.path, size: file.size, sha256: file.sha256 });
  }
  if (!files.some((file) => file.path === 'SKILL.md')) throw new Error('Missing Skill manifest');
  return files;
}

function textContent(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return undefined; }
}

/** Fail on unreadable/changing files instead of silently treating a partial scan as clean. */
export async function localComparisonFiles(root: string, includeText: boolean): Promise<ContentFile[]> {
  const canonical = await fs.promises.realpath(root);
  const files: ContentFile[] = [];
  let bytes = 0;
  let retainedText = 0;
  async function assertInside(file: string) {
    const real = await fs.promises.realpath(file);
    const rel = path.relative(canonical, real);
    if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) throw new Error('Skill path changed');
    return real;
  }
  async function walk(dir: string): Promise<void> {
    const dirBefore = await fs.promises.stat(await assertInside(dir));
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const relative = path.relative(canonical, file).split(path.sep).join('/');
      if (isIgnoredSkillPackagePath(relative)) continue;
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) continue;
      // Match the package manifest: directories and symlinks are not published files.
      if (files.length >= MAX_FILES) throw new Error('Skill exceeds comparison limit');
      if (!safeRelativePath(relative)) throw new Error('Invalid local package path');
      const real = await assertInside(file);
      const handle = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size + bytes > MAX_BYTES) throw new Error('Skill exceeds comparison limit');
        const hash = crypto.createHash('sha256');
        const keepText = includeText && before.size <= MAX_TEXT_BYTES && retainedText + before.size <= MAX_DIFF_BYTES;
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          size += chunk.length;
          if (bytes + size > MAX_BYTES) throw new Error('Skill exceeds comparison limit');
          hash.update(chunk);
          if (keepText && size <= MAX_TEXT_BYTES) chunks.push(chunk);
        }
        const after = await handle.stat();
        const current = await fs.promises.stat(await assertInside(file));
        if (before.ino !== current.ino || before.dev !== current.dev || before.mtimeMs !== after.mtimeMs
          || before.ctimeMs !== after.ctimeMs || before.size !== size || after.mtimeMs !== current.mtimeMs
          || after.ctimeMs !== current.ctimeMs || after.size !== current.size) throw new Error('Skill changed during comparison');
        bytes += size;
        const text = keepText ? textContent(Buffer.concat(chunks)) : undefined;
        if (text !== undefined) retainedText += size;
        files.push({ path: relative, size, sha256: hash.digest('hex'), ...(text !== undefined ? { text } : {}) });
      } finally { await handle.close(); }
    }
    const dirAfter = await fs.promises.stat(await assertInside(dir));
    if (dirBefore.ino !== dirAfter.ino || dirBefore.dev !== dirAfter.dev
      || dirBefore.mtimeMs !== dirAfter.mtimeMs || dirBefore.ctimeMs !== dirAfter.ctimeMs) {
      throw new Error('Skill changed during comparison');
    }
  }
  await walk(canonical);
  return files;
}

export async function comparePublishedSkill(
  skill: Pick<Skill, 'name' | 'registrySkillName' | 'registryEntry' | 'absolutePath'>,
  market: Pick<SkillhubMarketService, 'info' | 'getPublishedFiles' | 'readPublishedFile'>,
  includeDiff = false,
): Promise<SkillhubPublishComparison> {
  const name = skill.registrySkillName ?? skill.name;
  const scope = skill.registryEntry?.catalogScope;
  const source = await market.info(name, scope);
  if (!source.info) return { status: 'not-owner' };
  if (typeof source.info.isCreator !== 'boolean') return { status: 'unavailable' };
  if (source.info.isCreator !== true || !source.info.canManage) return { status: 'not-owner' };
  // Publication always targets native management reads. Never cross same-slug catalog identities.
  const native = scope ? await market.info(name) : source;
  if (!native.info || native.info.isCreator !== true || !native.info.canManage
    || native.info.authorId !== source.info.authorId || native.info.ownerType !== source.info.ownerType) {
    return { status: 'not-owner' };
  }
  const info = native.info;
  const reviewVersion = activePublishedReviewVersion(info);
  const pending = reviewVersion !== null;
  const version = reviewVersion ?? info.latestVersion;
  const remote = await market.getPublishedFiles({ name, version, includeHashes: true });
  if (remote.version !== version) throw new Error('Published version changed');
  const published = publishedManifest(remote.files);
  const local = await localComparisonFiles(skill.absolutePath, includeDiff);
  const oldByPath = new Map(published.map((file) => [file.path, file]));
  const newByPath = new Map(local.map((file) => [file.path, file]));
  const changedPaths = [...new Set([...oldByPath.keys(), ...newByPath.keys()])].sort()
    .filter((file) => oldByPath.get(file)?.sha256 !== newByPath.get(file)?.sha256);
  const installedVersion = skill.registryEntry?.version;
  let localChanges: 'modified' | 'unchanged' | 'unknown' | undefined;
  const installedOrigin = skill.registryEntry?.origin;
  if (changedPaths.length && installedVersion && installedVersion !== version
    && installedOrigin !== 'learned' && installedOrigin !== 'imported') {
    // A difference from the latest release may just be an older, unedited copy.
    // Compare with the immutable installed release, never a ZIP hash or guessed author.
    try {
      const baseline = await market.getPublishedFiles({ name, version: installedVersion, includeHashes: true });
      if (baseline.version !== installedVersion) throw new Error('Installed version changed');
      const original = publishedManifest(baseline.files);
      localChanges = original.length === local.length
        && original.every((file) => newByPath.get(file.path)?.sha256 === file.sha256)
        ? 'unchanged' : 'modified';
    } catch {
      localChanges = 'unknown';
    }
  }
  const result = {
    status: changedPaths.length ? 'different' as const : 'same' as const, version, pending,
    ...(localChanges ? { localChanges } : {}),
  };
  if (!includeDiff) return result;
  const changes: SkillhubContentChange[] = [];
  let previewBytes = 0;
  let previewRequests = 0;
  for (const file of changedPaths) {
    const oldFile = oldByPath.get(file);
    const newFile = newByPath.get(file);
    let oldContent = oldFile ? undefined : '';
    const newContent = newFile ? newFile.text : '';
    if (oldFile && oldFile.size <= MAX_TEXT_BYTES && newContent !== undefined
      && previewRequests < MAX_REMOTE_PREVIEWS
      && previewBytes + oldFile.size + (newFile?.size ?? 0) <= MAX_DIFF_BYTES) {
      previewRequests++;
      const response = await market.readPublishedFile({ name, version, path: file });
      const preview = response.file;
      if (!preview.truncated && typeof preview.content === 'string' && Buffer.byteLength(preview.content) === oldFile.size
        && crypto.createHash('sha256').update(preview.content).digest('hex') === oldFile.sha256) {
        oldContent = textContent(Buffer.from(preview.content));
      }
    }
    const isBinary = oldContent === undefined || newContent === undefined
      || previewBytes + (oldFile?.size ?? 0) + (newFile?.size ?? 0) > MAX_DIFF_BYTES;
    if (!isBinary) previewBytes += (oldFile?.size ?? 0) + (newFile?.size ?? 0);
    changes.push({ path: file, kind: !oldFile ? 'added' : !newFile ? 'removed' : 'modified', isBinary,
      oldContent: isBinary ? '' : oldContent ?? '', newContent: isBinary ? '' : newContent ?? '',
      oldSize: oldFile?.size ?? 0, newSize: newFile?.size ?? 0 });
  }
  return { ...result, changes };
}
