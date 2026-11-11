/**
 * vendor/devFallback.ts
 *
 * 共享 dev-mode 本地二进制查找。约定路径：apps/<vendorBinDir>/<platform>/<binaryName>
 * dev 模式跳过 SHA256/解压/manifest，直接用 bundled binary；prod 永远不读这里。
 */
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import { getPlatformKey } from '../manifestService.js';

export interface DevBinaryConfig {
  /** monorepo apps/ 下的子目录名，例如 'claude-code-bin' / 'codex-package-bin' */
  vendorBinDir: string;
  /** 平台目录下的入口相对路径，例如 'claude.exe' / 'bin/codex.exe' */
  binaryName: string;
}

/**
 * 在两个候选位置依次查找：
 *   1. <appPath>/../../apps/<vendorBinDir>/<platform>/<binary>   (forge dev: appPath = apps/desktop)
 *   2. <cwd>/apps/<vendorBinDir>/<platform>/<binary>             (monorepo 根 pnpm 调起时)
 * 命中后做 chmod 0o755（unix），返回路径；都未命中返回 null。
 */
export function findDevBinary(config: DevBinaryConfig): string | null {
  const platformKey = getPlatformKey();
  const candidates = [
    path.join(app.getAppPath(), '..', '..', 'apps', config.vendorBinDir, platformKey, config.binaryName),
    path.join(process.cwd(), 'apps', config.vendorBinDir, platformKey, config.binaryName),
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p);
      if (process.platform !== 'win32') {
        try { fs.chmodSync(p, 0o755); } catch { /* ignore */ }
      }
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}
