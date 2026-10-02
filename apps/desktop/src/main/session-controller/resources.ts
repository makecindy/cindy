import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isSessionResourceLocalTo, type SessionResourceRef } from '@cindy/maker-shared/session-controller';
import type { AgentInputSerializedFile } from '../../shared/agentInputQueue.js';
import { getSensitiveMediaBlocklist, isPathAllowedAgainst } from '../filePathPolicy.js';
import { SessionAdmissionError } from './controller.js';

/** Resolve only the declared namespace. Transfers remain the responsibility of
 * the existing authorized attachment/file services; this never searches locally
 * for a missing remote file or creates a second attachment store. */
export async function resolveSessionInputFiles(resources: readonly SessionResourceRef[], location: {
  deviceId: string; remoteHostId: string | null;
}): Promise<AgentInputSerializedFile[]> {
  // Check the whole batch before touching the filesystem.
  for (const ref of resources) {
    if (!isSessionResourceLocalTo(ref, location) || ref.kind === 'directory' || ref.remoteHostId) {
      throw new SessionAdmissionError('RESOURCE_UNREACHABLE', '附件不在当前可读取的设备命名空间，请使用已有的授权传输入口。');
    }
  }
  return Promise.all(resources.map(async ref => {
    let locator = ref.locator;
    let mimeType = 'application/octet-stream';
    if (ref.kind === 'attachment') {
      const { resolveSafe } = await import('../cindy-media/blobStore.js');
      let resolved: ReturnType<typeof resolveSafe>;
      try { resolved = resolveSafe(locator); } catch { throw new SessionAdmissionError('RESOURCE_UNREACHABLE', '托管附件当前不可用。'); }
      locator = resolved.absPath; mimeType = resolved.mimeType;
    } else if (!path.isAbsolute(locator) || !isPathAllowedAgainst(locator, getSensitiveMediaBlocklist())) {
      throw new SessionAdmissionError('NOT_AUTHORIZED', '附件路径不在允许读取的范围内。');
    }
    let canonical: string, info: Awaited<ReturnType<typeof stat>>;
    try { canonical = await realpath(locator); info = await stat(canonical); }
    catch { throw new SessionAdmissionError('RESOURCE_UNREACHABLE', '目标附件当前不可用。'); }
    if (!info.isFile()) throw new SessionAdmissionError('RESOURCE_UNREACHABLE', '附件必须是普通文件。');
    if (ref.kind === 'file' && !isPathAllowedAgainst(canonical, getSensitiveMediaBlocklist())) {
      throw new SessionAdmissionError('NOT_AUTHORIZED', '附件真实路径不在允许读取的范围内。');
    }
    const version = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    if (ref.version !== undefined && ref.version !== version) throw new SessionAdmissionError('CONFLICT', '附件版本已变化，请重新选择。');
    const name = path.basename(canonical);
    return { id: randomUUID(), name, path: canonical, ext: path.extname(name), size: Number(info.size),
      mimeType, category: mimeType.startsWith('image/') ? 'image' as const : 'file' as const,
      ...(ref.kind === 'attachment' ? { url: ref.locator } : {}),
      sessionResource: { ...ref, version },
    };
  }));
}
