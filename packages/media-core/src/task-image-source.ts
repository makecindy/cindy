import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sniffMediaMime } from './sniff.js';
import { isPathWithin } from './task-image-markdown.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function claudeScratchpadTempBase(platform: NodeJS.Platform = process.platform): string {
  // Claude uses /tmp on Unix, including macOS where os.tmpdir() differs.
  return process.env.CLAUDE_CODE_TMPDIR || (platform === 'win32' ? os.tmpdir() : '/tmp');
}
export interface SessionImageScope { id: string; workingDir: string | null; sdkSessionId: string | null; agentKind: string; remoteHostId: string | null; status: string; clearedAt: number | null }

/** CC 2.1.280's scratchpad layout. Identity comes from the Host session, never the URL.
 * Long project keys use a native hash; do not guess that hash or scan other tasks.
 */
export function claudeScratchpadPath(
  session: Pick<SessionImageScope, 'workingDir' | 'sdkSessionId' | 'agentKind'>,
  tempBase = claudeScratchpadTempBase(),
  uid = process.getuid?.() ?? 0,
): string | null {
  if (
    session.agentKind !== 'cc' ||
    !session.workingDir ||
    session.workingDir.length > 200 ||
    !session.sdkSessionId ||
    !/^[a-f0-9-]{36}$/i.test(session.sdkSessionId)
  )
    return null;
  return path.join(
    tempBase,
    `claude-${uid}`,
    session.workingDir.replace(/[^a-zA-Z0-9]/g, '-'),
    session.sdkSessionId,
    'scratchpad',
  );
}

export async function taskImageRoots(session: SessionImageScope): Promise<string[]> {
  if (session.remoteHostId || session.status === 'deleted' || !session.workingDir) return [];
  const roots: string[] = [];
  try {
    roots.push(await fs.realpath(session.workingDir));
  } catch {
    /* missing workdir */
  }
  const configuredTempBase = claudeScratchpadTempBase();
  const scratchpad = claudeScratchpadPath(session, configuredTempBase);
  if (scratchpad) {
    try {
      // /tmp may itself alias /private/tmp. No task-owned path component may redirect elsewhere.
      const tempBase = await fs.realpath(configuredTempBase);
      const expected = path.join(tempBase, path.relative(configuredTempBase, scratchpad));
      const actual = await fs.realpath(scratchpad);
      if (actual === expected) roots.push(actual);
    } catch {
      /* native scratchpad has not been created (or was cleaned) */
    }
  }
  return roots;
}

/** Read through one handle, rejecting escapes and replacement during validation. */
export async function readTaskImage(
  source: string,
  roots: readonly string[],
): Promise<{ buffer: Buffer; mimeType: string }> {
  // Reject Windows UNC / WebDAV / device namespaces before realpath can contact
  // a remote server. Apply to decoded paths too, independent of the host OS.
  if (/^[\\/]{2}|^[\\/]\?\?[\\/]/.test(source))
    throw new Error('task-image: network or device path');
  const real = await fs.realpath(source);
  if (!roots.some((root) => isPathWithin(root, real))) throw new Error('task-image: outside task');
  const handle = await fs.open(
    real,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_IMAGE_BYTES)
      throw new Error('task-image: invalid file');
    const checked = await fs.realpath(source);
    const named = await fs.stat(checked);
    if (
      checked !== real ||
      named.ino !== before.ino ||
      named.dev !== before.dev ||
      !roots.some((root) => isPathWithin(root, checked))
    )
      throw new Error('task-image: changed source');
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error('task-image: truncated');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error('task-image: changed source');
    const mimeType = sniffMediaMime(buffer);
    if (!mimeType?.startsWith('image/')) throw new Error('task-image: not an image');
    return { buffer, mimeType };
  } finally {
    await handle.close();
  }
}

