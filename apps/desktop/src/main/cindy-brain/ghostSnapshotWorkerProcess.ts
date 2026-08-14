/**
 * Skill snapshot 的 cwd-bound utility worker。
 *
 * 防御策略（见 plugin-security-and-authoring.md §Review 清单 6.5a）：
 *   verifyParent → mkdir temp → classifyGhostDirEntry(temp) →
 *   从 sourceDir 复制内容到 temp → matches(temp) 内容哈希 → 多层 pre-rename 复验
 *   (verifyParent + verifyDirectory + classifyGhostDirEntry + lstat absence) →
 *   原子 rename → post-rename classifyGhostDirEntry → matches(target)
 *   → classifyGhostDirEntry(target)（终判——matches 本身不校验 root）→ cleanup。
 *
 * pre-check（classifyGhostDirEntry / verifyParent / matches）只缩窄 TOCTOU
 * 窗口；post-rename classifyGhostDirEntry + matches() 才是真正的安全判定
 * （matches() 自身不校验 baseDir，见 ghostContentTree.ts:68）。
 * pre-rename classifyGhostDirEntry 与 rename 之间的单 await 间隙是 Node.js
 * 未暴露 renameat 的硬边界，不可消除——安全判定必须在操作之后做，不能靠
 * 叠加更多 pre-check。
 * cleanup 按 verifyParent + verifyDirectory 做身份守卫，不按 pathname 删。
 */
import fs from 'node:fs';
import path from 'node:path';

import { GHOST_SKILL_MD_MAX_BYTES } from '../../shared/ghost.js';
import {
  classifyGhostDirEntry,
  collectGhostContentFiles,
  hashGhostContentFiles,
  isRegularGhostDirEntry,
  resolveGhostContentPath,
} from './ghostContentTree.js';
import {
  sameGhostSnapshotParentIdentity,
  type GhostSnapshotParentIdentity,
} from './ghostSnapshotIdentity.js';
import { checkSkillMdConsistency } from './skillSlot.js';

export interface GhostSnapshotWorkerRequest {
  expectedParent: GhostSnapshotParentIdentity;
  operation: 'ensure' | 'remove';
  targetName: string;
  sourceDir?: string;
  receipt?: {
    manifest: import('../../shared/ghost.js').GhostManifest;
    skillContentSha256: Record<string, string>;
  };
}
interface Port {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}
const port = (process as unknown as { parentPort?: Port }).parentPort;
const send = (message: unknown): void => port?.postMessage(message);
const hasCode = (error: unknown, code: string): boolean =>
  Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code);
function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}
function targetParts(request: GhostSnapshotWorkerRequest): string[] {
  const parts = request.targetName.split('/');
  if (request.operation === 'ensure') {
    if (parts.length !== 2 || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(parts[0]) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parts[1])) {
      throw new Error('invalid snapshot request');
    }
  } else if (parts.length !== 1 || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(parts[0])) {
    throw new Error('invalid snapshot request');
  }
  return parts;
}
async function verifyParent(expected: GhostSnapshotParentIdentity, workingDir: string): Promise<void> {
  const stats = await fs.promises.lstat(workingDir, { bigint: true });
  if (!sameGhostSnapshotParentIdentity(stats, expected)) throw new Error('snapshot parent identity changed');
  if (!samePath(await fs.promises.realpath(workingDir), expected.realPath)) throw new Error('snapshot parent path changed');
}
async function verifyDirectory(workingDir: string, name: string): Promise<void> {
  const target = path.join(workingDir, name);
  const kind = await classifyGhostDirEntry(target);
  if (kind !== 'directory') throw new Error('snapshot id parent changed');
}
async function removeVerifiedDirectory(
  expectedParent: GhostSnapshotParentIdentity,
  workingDir: string,
  targetPath: string,
  parentName: string,
  expectedTarget?: { realPath: string; dev: bigint; ino: bigint },
): Promise<void> {
  const targetStat = await fs.promises.lstat(targetPath, { bigint: true });
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error('snapshot target is not a real directory');
  }
  const targetRealPath = await fs.promises.realpath(targetPath);
  if (expectedTarget && (
    targetStat.dev !== expectedTarget.dev ||
    targetStat.ino !== expectedTarget.ino ||
    !samePath(targetRealPath, expectedTarget.realPath)
  )) {
    throw new Error('snapshot target identity changed before removal');
  }
  const quarantinePath = `${targetPath}.remove-${process.pid}-${Date.now()}`;
  await fs.promises.rename(targetPath, quarantinePath);
  const movedStat = await fs.promises.lstat(quarantinePath, { bigint: true });
  if (
    !movedStat.isDirectory()
    || movedStat.isSymbolicLink()
    || movedStat.dev !== targetStat.dev
    || movedStat.ino !== targetStat.ino
    || !samePath(await fs.promises.realpath(quarantinePath), targetRealPath)
  ) {
    // Never recursively delete an unverified path. Leave the quarantined
    // directory for a later owner-checked cleanup pass.
    throw new Error('snapshot target identity changed during removal');
  }
  // The pathname was renamed through a mutable parent. Revalidate the
  // owner-bound parent before recursive deletion; on failure the isolated
  // directory is intentionally left for a later guarded cleanup pass.
  await verifyParent(expectedParent, workingDir);
  await verifyDirectory(workingDir, parentName);
  await fs.promises.rm(quarantinePath, { recursive: true, force: true });
}
async function copyDirectory(source: string, target: string): Promise<void> {
  if ((await classifyGhostDirEntry(source)) !== 'directory') throw new Error(`skill source is not a directory: ${source}`);
  await fs.promises.mkdir(target, { recursive: true });
  for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const kind = await classifyGhostDirEntry(from);
    if (!isRegularGhostDirEntry(kind)) throw new Error(`skill snapshot rejects non-regular entry: ${from}`);
    if (kind === 'directory') await copyDirectory(from, to);
    else await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  }
}
async function hashes(receipt: NonNullable<GhostSnapshotWorkerRequest['receipt']>, root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of receipt.manifest.skill?.items ?? []) {
    const itemRoot = await resolveGhostContentPath(root, item.dir, { expect: 'directory', label: 'approved skill' });
    const tree = await collectGhostContentFiles(itemRoot, { dotEntries: 'include', nonRegular: 'throw', label: `approved skill ${item.dir}` });
    result[item.dir] = await hashGhostContentFiles(itemRoot, tree.files, tree.rootIdentity);
  }
  return result;
}
async function matches(receipt: NonNullable<GhostSnapshotWorkerRequest['receipt']>, root: string): Promise<boolean> {
  const actual = await hashes(receipt, root).catch(() => null);
  return Boolean(actual && (receipt.manifest.skill?.items ?? []).every(
    (item) => actual[item.dir] === receipt.skillContentSha256[item.dir],
  ));
}
export async function runGhostSnapshotWorkerRequest(
  request: GhostSnapshotWorkerRequest,
  workingDir = process.cwd(),
): Promise<void> {
  if (!request || !request.expectedParent) {
    throw new Error('invalid snapshot request');
  }
  const parts = targetParts(request);
  const relativeWorkerPaths = path.resolve(workingDir) === path.resolve(process.cwd());
  const workPath = (name: string): string =>
    relativeWorkerPaths ? name : path.join(workingDir, name);
  const targetPath = workPath(path.join(...parts));
  await verifyParent(request.expectedParent, workingDir);
  if (request.operation === 'remove') {
    await verifyParent(request.expectedParent, workingDir);
    if (parts.length !== 1) throw new Error('invalid snapshot removal target');
    await verifyDirectory(workingDir, parts[0]);
    const targetStat = await fs.promises.lstat(targetPath, { bigint: true });
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error('snapshot target is not a real directory');
    }
    const targetIdentity = {
      realPath: await fs.promises.realpath(targetPath),
      dev: targetStat.dev,
      ino: targetStat.ino,
    };
    await removeVerifiedDirectory(
      request.expectedParent,
      workingDir,
      targetPath,
      parts[0],
      targetIdentity,
    );
    send({ ok: true }); return;
  }
  if (!request.receipt || !request.sourceDir) throw new Error('approved skill snapshot is missing');
  let exists = false;
  let existingTargetIdentity: { realPath: string; dev: bigint; ino: bigint } | undefined;
  try {
    const stat = await fs.promises.lstat(targetPath, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('snapshot target is not a real directory');
    exists = true;
    existingTargetIdentity = {
      realPath: await fs.promises.realpath(targetPath),
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  if (exists) {
    await verifyDirectory(workingDir, parts[0]);
    if (await matches(request.receipt, targetPath)) {
      // matches() reads through pathnames and does not validate the
      // baseDir itself (ghostContentTree.ts:68).  Recheck the target
      // identity with lstat (no-follow) before accepting the fast path,
      // so a concurrent process that swapped <id>/<revision> for a
      // symlink after the initial lstat can't publish a linked external
      // tree as the approved snapshot (P1, PRRT_kwDOTgdRUs6Yb404).
      const targetKind = await classifyGhostDirEntry(targetPath);
      if (targetKind !== 'directory') throw new Error('snapshot target is not a real directory on fast path');
      send({ ok: true }); return;
    }
  }
  try {
    const parentKind = await classifyGhostDirEntry(workPath(parts[0]));
    if (parentKind !== 'directory') throw new Error('snapshot parent identity changed');
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    await fs.promises.mkdir(workPath(parts[0]), { recursive: false });
  }
  const temp = `.${parts[1]}-${process.pid}-${Date.now()}.tmp`;
  try {
    await verifyParent(request.expectedParent, workingDir);
    await verifyDirectory(workingDir, parts[0]);
    const tempPath = workPath(temp);
    await fs.promises.mkdir(tempPath);
    const tempKind = await classifyGhostDirEntry(tempPath);
    if (tempKind !== 'directory') throw new Error('snapshot temp directory was replaced before copy');
    const copiedRoots: string[] = [];
    for (const item of [...(request.receipt.manifest.skill?.items ?? [])].sort(
      (left, right) => left.dir.split('/').length - right.dir.split('/').length,
    )) {
      const folded = item.dir.toLowerCase();
      if (copiedRoots.some((root) => folded === root || folded.startsWith(`${root}/`))) continue;
      const source = await resolveGhostContentPath(request.sourceDir, item.dir, { expect: 'directory', label: 'approved skill' });
      await copyDirectory(source, path.join(tempPath, ...item.dir.split('/')));
      copiedRoots.push(folded);
    }
    for (const item of request.receipt.manifest.skill?.items ?? []) {
      const skillMd = path.join(tempPath, ...item.dir.split('/'), 'SKILL.md');
      const stat = await fs.promises.lstat(skillMd);
      if (!stat.isFile()) throw new Error(`approved skill ${item.dir}/SKILL.md is not a regular file`);
      if (stat.size > GHOST_SKILL_MD_MAX_BYTES) {
        throw new Error(`approved skill ${item.dir}/SKILL.md exceeds ${GHOST_SKILL_MD_MAX_BYTES} bytes`);
      }
      const error = checkSkillMdConsistency(await fs.promises.readFile(skillMd, 'utf8'), item);
      if (error) throw new Error(`approved skill ${item.dir} is inconsistent: ${error}`);
    }
    if (!await matches(request.receipt, tempPath)) throw new Error('approved skill content no longer matches receipt');
    const tempBeforePublish = await classifyGhostDirEntry(tempPath);
    if (tempBeforePublish !== 'directory') throw new Error('snapshot temp directory was replaced before publish');
    await verifyParent(request.expectedParent, workingDir);
    await verifyDirectory(workingDir, parts[0]);
    if (exists) {
      await removeVerifiedDirectory(
        request.expectedParent,
        workingDir,
        targetPath,
        parts[0],
        existingTargetIdentity,
      );
    }
    await verifyParent(request.expectedParent, workingDir);
    await verifyDirectory(workingDir, parts[0]);
    try {
      await fs.promises.lstat(targetPath);
      throw new Error('snapshot target recreated before publish');
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    const tempBeforeRename = await classifyGhostDirEntry(tempPath);
    if (tempBeforeRename !== 'directory') throw new Error('snapshot temp directory was replaced before rename');
    await fs.promises.rename(tempPath, targetPath);
    const targetEntryKind = await classifyGhostDirEntry(targetPath);
    if (targetEntryKind !== 'directory') {
      if (await verifyParent(request.expectedParent, workingDir).then(() => true, () => false) &&
        await verifyDirectory(workingDir, parts[0]).then(() => true, () => false)) {
        await fs.promises.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw new Error('snapshot target is not a real directory after publish');
    }
    await verifyParent(request.expectedParent, workingDir);
    await verifyDirectory(workingDir, parts[0]);
    if (!await matches(request.receipt, targetPath)) {
      if (await verifyParent(request.expectedParent, workingDir).then(() => true, () => false) &&
        await verifyDirectory(workingDir, parts[0]).then(() => true, () => false)) {
        await fs.promises.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw new Error('approved skill snapshot changed while being published');
    }
    // matches() follows symlinks through resolveGhostContentPath and does
    // not validate the root itself (ghostContentTree.ts:68).  Recheck
    // after matches() so a concurrent swap to a symlink with identical
    // bytes is caught before we send ok (same P1 as PRRT_kwDOTgdRUs6Yb404).
    const targetKindAfterMatch = await classifyGhostDirEntry(targetPath);
    if (targetKindAfterMatch !== 'directory') throw new Error('snapshot target no longer a real directory after match');
    send({ ok: true });
  } finally {
    if (await verifyParent(request.expectedParent, workingDir).then(() => true, () => false) &&
      await verifyDirectory(workingDir, parts[0]).then(() => true, () => false)) {
      await fs.promises.rm(workPath(temp), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
if (port) {
  let handled = false;
  send({ type: 'ready' });
  port.on('message', (event) => {
    const message = event.data as { type?: unknown; request?: GhostSnapshotWorkerRequest };
    if (handled || message?.type !== 'mutate' || !message.request) return;
    handled = true;
    runGhostSnapshotWorkerRequest(message.request).catch((error) => send({ ok: false, message: error instanceof Error ? error.message : String(error) }));
  });
}
