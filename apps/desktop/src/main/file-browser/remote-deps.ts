/**
 * remote-deps — RemoteFileBrowserManager 的生产依赖装配。
 *
 * 单独成文件的原因:remote.ts 保持纯逻辑(注入依赖,单测内存 fake 可驱动),
 * 这里才 import 真实的 SSH pool / 安装器 / Electron app 路径。IPC 层通过
 * `getRemoteFileBrowser()` 拿单例。
 */

import * as fsSync from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
  installFileServiceBundle,
  probeFileService,
} from '@cindy/maker-remote-ssh';

import { createLogger } from '../logger.js';
import {
  ensureRemoteHostReady,
  getRemoteSshPool,
  setRemoteFileBrowserEndpointInvalidator,
} from '../remote-ssh/index.js';
import { RemoteFileBrowserManager } from './remote.js';

const log = createLogger('file-browser/remote-deps');

/**
 * 定位本地 file-service.mjs bundle。搜索顺序与 resolveCcManagerBundlePath
 * 完全一致(dev 源码 dist → forge extraResource → asar.unpacked)。
 */
export function resolveFileServiceBundlePath(): string {
  const appPath = app.getAppPath();
  const candidates = [
    path.join(appPath, '..', '..', 'packages', 'remote-file-service', 'dist', 'file-service.mjs'),
    path.join(process.resourcesPath ?? '', 'remote-file-service', 'file-service.mjs'),
    path.join(`${appPath}.unpacked`, 'packages', 'remote-file-service', 'dist', 'file-service.mjs'),
  ];
  for (const candidate of candidates) {
    try {
      const st = fsSync.statSync(candidate);
      if (st.isFile() && st.size > 0) return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    `file-service.mjs bundle not found in any of: ${candidates.join(' | ')} — ` +
      'packaging needs to ship packages/remote-file-service/dist/file-service.mjs as extraResource',
  );
}

let manager: RemoteFileBrowserManager | null = null;

setRemoteFileBrowserEndpointInvalidator(async (hostId) => {
  if (manager) await manager.disposeHost(hostId);
});

/** 生产单例。首次调用装配真实依赖。 */
export function getRemoteFileBrowser(): RemoteFileBrowserManager {
  if (manager) return manager;
  manager = new RemoteFileBrowserManager({
    ensureHostReady: (hostId) => ensureRemoteHostReady(hostId),
    getHost: (hostId) => {
      const host = getRemoteSshPool().get(hostId);
      if (!host) throw new Error(`remote host not found in pool: ${hostId}`);
      return host;
    },
    probe: async (hostId) => {
      const host = getRemoteSshPool().get(hostId);
      if (!host) throw new Error(`remote host not found in pool: ${hostId}`);
      return probeFileService(host);
    },
    install: async (hostId) => {
      const host = getRemoteSshPool().get(hostId);
      if (!host) throw new Error(`remote host not found in pool: ${hostId}`);
      const bundlePath = resolveFileServiceBundlePath();
      log.info('installing file-service bundle', { hostId, bundlePath });
      return installFileServiceBundle(host, { bundlePath });
    },
  });
  return manager;
}

/** 应用退出清理(bootstrap 的 will-quit 钩子调用)。 */
export async function disposeRemoteFileBrowser(): Promise<void> {
  if (!manager) return;
  await manager.disposeAll();
  manager = null;
}
