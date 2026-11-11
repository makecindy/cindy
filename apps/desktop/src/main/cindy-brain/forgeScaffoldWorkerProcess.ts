/**
 * Forge scaffold 的 cwd-bound utility worker。
 *
 * 防御策略（见 plugin-security-and-authoring.md §Review 清单 6.5a）：
 *   mkdir(atomic no-clobber gate) → pre-check（fast fail）→ per-entry 操作 →
 *   post-loop verifyParent → dev/ino-guarded cleanup（仅 catch 失败时触发）→
 *   finally 清理 staging。
 * per-entry 复验（lstat + isDir + isSymlink + dev/ino + realpath in bigint）
 * 在每次 rename 前执行，缩窄 TOCTOU 窗口到单 await 边界。
 * 最后一个 per-entry 检查与最后一个 rename 之间的间隙是 Node.js 未暴露
 * renameat 的硬边界，不可消除——dev/ino-guarded cleanup 提供补偿控制。
 * 再增加 pre-check 不能关闭此间隙；安全方向是保持当前的 post-loop
 * verifyParent + identity-guarded cleanup，而不是叠加更多路径检查。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  sameForgeScaffoldParentIdentity,
  type ForgeScaffoldParentIdentity,
} from './forgeScaffoldIdentity.js';

interface Request {
  expectedParent: ForgeScaffoldParentIdentity;
  targetName: string;
  files: Array<{ path: string; base64: string }>;
}

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (!parentPort) throw new Error('Forge scaffold worker missing parentPort');

function send(message: unknown): void {
  parentPort?.postMessage(message);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

async function verifyParent(expected: Request['expectedParent']): Promise<void> {
  const stats = await fs.promises.lstat('.', { bigint: true });
  if (!sameForgeScaffoldParentIdentity(stats, expected)) {
    throw new Error('Forge scaffold parent identity changed');
  }
  const real = await fs.promises.realpath('.');
  if (!samePath(real, expected.realPath)) throw new Error('Forge scaffold parent path changed');
}

function safeRelative(relative: string): boolean {
  if (!relative || relative.includes('\0') || path.isAbsolute(relative)) return false;
  const normalized = path.normalize(relative);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
}

async function run(request: Request): Promise<void> {
  if (
    !request ||
    typeof request.targetName !== 'string' ||
    request.targetName !== path.basename(request.targetName) ||
    request.targetName === '.' ||
    request.targetName === '..' ||
    !Array.isArray(request.files) ||
    request.files.length > 32 ||
    request.files.some((file) => !file || !safeRelative(file.path) || typeof file.base64 !== 'string')
  ) {
    throw new Error('Invalid Forge scaffold worker request');
  }
  await verifyParent(request.expectedParent);

  try {
    await fs.promises.lstat(request.targetName);
    send({ ok: false, errorCode: 'TARGET_EXISTS', message: '目标已经存在，不会覆盖' });
    return;
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }

  let staging: string | null = null;
  try {
    staging = await fs.promises.mkdtemp(`.${request.targetName}-scaffold-`);
    for (const file of request.files) {
      const target = path.join(staging, file.path);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0);
      const handle = await fs.promises.open(target, flags, 0o600);
      try {
        await handle.writeFile(Buffer.from(file.base64, 'base64'));
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await verifyParent(request.expectedParent);
    const stagingStat = await fs.promises.lstat(staging);
    if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
      throw new Error('Forge scaffold staging directory changed');
    }
    // Use mkdir as an atomic no-clobber gate: mkdir on the target name
    // succeeds iff the target does not exist, and fails with EEXIST if it
    // does (cross-platform, including POSIX where rename would silently
    // replace an existing directory).  Once mkdir succeeds, the target is
    // exclusively owned by this worker; rename each entry from staging
    // into it, then rmdir the now-empty staging.
    try {
      await fs.promises.mkdir(request.targetName);
    } catch (error) {
      if (hasCode(error, 'EEXIST')) {
        send({ ok: false, errorCode: 'TARGET_EXISTS', message: '目标已经存在，不会覆盖' });
        return;
      }
      throw error;
    }
    let targetDev: bigint = 0n;
    let targetIno: bigint = 0n;
    try {
      await verifyParent(request.expectedParent);
      // Validate that the just-created target is still a real directory
      // owned by this worker before moving entries into it.  A concurrent
      // process could delete the empty directory and replace it with a
      // symlink/junction between mkdir and the rename loop.
      const targetStat = await fs.promises.lstat(request.targetName, { bigint: true });
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        throw new Error('Forge scaffold target replaced after mkdir');
      }
      const targetRealPath = await fs.promises.realpath(request.targetName);
      targetDev = targetStat.dev;
      targetIno = targetStat.ino;
      for (const entry of await fs.promises.readdir(staging, { withFileTypes: true })) {
        // Per-entry revalidation: a concurrent swap between the single-shot
        // lstat check above and each rename would let path.join follow the
        // swapped link. Re-check the target identity (dev/ino + realpath)
        // before every file move.
        const currentStat = await fs.promises.lstat(request.targetName, { bigint: true });
        if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
          throw new Error('Forge scaffold target identity changed during publish');
        }
        if (currentStat.dev !== targetDev || currentStat.ino !== targetIno) {
          throw new Error('Forge scaffold target replaced by a different directory during publish');
        }
        const currentReal = await fs.promises.realpath(request.targetName);
        if (!samePath(currentReal, targetRealPath)) {
          throw new Error('Forge scaffold target path changed during publish');
        }
        await fs.promises.rename(
          path.join(staging, entry.name),
          path.join(request.targetName, entry.name),
        );
      }
      await fs.promises.rmdir(staging);
      staging = null;
    } catch (error) {
      // Publish failed after mkdir: the partially-populated target must be
      // cleaned up so it doesn't block the next scaffold attempt.
      // Only remove the directory that we created — if the target was
      // replaced by a concurrent process (different dev/ino), leave it
      // alone rather than destroying another process's directory.
      try {
        const cleanupStat = await fs.promises.lstat(request.targetName, { bigint: true });
        if (
          cleanupStat.isDirectory() &&
          !cleanupStat.isSymbolicLink() &&
          cleanupStat.dev === targetDev &&
          cleanupStat.ino === targetIno
        ) {
          await fs.promises.rm(request.targetName, { recursive: true, force: true });
        }
      } catch {
        // Cleanup is best-effort; the next scaffold attempt will also
        // reject the TARGET_EXISTS state.
      }
      throw error;
    }
    await verifyParent(request.expectedParent);
    send({ ok: true });
  } finally {
    if (staging) {
      try {
        const stat = await fs.promises.lstat(staging);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          await fs.promises.rm(staging, { recursive: true, force: true });
        }
      } catch {
        // Keep the boundary fail-closed; never retry cleanup through an unknown path.
      }
    }
  }
}

let handled = false;
send({ type: 'ready' });
parentPort.on('message', (event) => {
  const message = event.data as { type?: unknown; request?: Request };
  if (handled || message?.type !== 'scaffold' || !message.request) return;
  handled = true;
  run(message.request).catch((error) => {
    send({ ok: false, errorCode: 'INTERNAL', message: error instanceof Error ? error.message : String(error) });
  });
});
