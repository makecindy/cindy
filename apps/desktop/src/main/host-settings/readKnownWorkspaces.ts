import path from 'node:path';
import { getMakerIfReady } from '../maker-host/index.js';
import type { CollectionInspectionOptions } from './readers/collections.js';

export interface KnownWorkspacesInspection {
  knownWorkspaces: NonNullable<CollectionInspectionOptions['knownWorkspaces']>;
  knownWorkspacesComplete: false;
}

/** 只观察已存在的本机会话，不构造 Maker、不读数据库、不解析或扫描目录。 */
export function readKnownWorkspaces(): KnownWorkspacesInspection {
  try {
    const sessions = getMakerIfReady()?.listActiveSessions() ?? [];
    const knownWorkspaces = new Set<string>();
    for (const session of sessions) {
      // 远端路径和归属未知的路径不能交给本机文件读取器；相对路径也不补全。
      if (session.remoteHostId !== null || typeof session.workDir !== 'string'
        || !path.isAbsolute(session.workDir) || session.workDir.includes('\0')) continue;
      knownWorkspaces.add(session.workDir);
    }
    // 内存活跃会话永远不能证明已覆盖全部工作区，空集合也一样。
    return { knownWorkspaces: [...knownWorkspaces], knownWorkspacesComplete: false };
  } catch {
    return { knownWorkspaces: [], knownWorkspacesComplete: false };
  }
}
