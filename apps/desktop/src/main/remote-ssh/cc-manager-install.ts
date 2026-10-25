import {app,BrowserWindow} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import {createLogger} from '../logger.js';
import {createCcManagerInstall} from '@cindy/app-runtime/cc-manager-install';
export type * from '@cindy/app-runtime/cc-manager-install';


const CC_MGR_UPGRADE_AVAILABLE_CHANNEL = 'maker:remote-ssh:cc-mgr-upgrade-available';

const SILENT_INSTALL_STATUS_CHANNEL = 'maker:remote-ssh:silent-install-status';

function broadcastCcMgrUpgradeAvailable(payload: {
  hostId: string;
  available: { currentVersion: string; availableVersion: string } | null;
  agent: 'cc' | 'pi';
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(CC_MGR_UPGRADE_AVAILABLE_CHANNEL, payload);
  }
}

function broadcastSilentInstallStatus(payload: {
  hostId: string;
  agentKind: string;
  phase: 'started' | 'progress' | 'done' | 'failed';
  eventKind?: string;
  message?: string;
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(SILENT_INSTALL_STATUS_CHANNEL, payload);
  }
}


/**
 * Locate the local `cc-mgr.mjs` bundle. Search order:
 *   1. Dev/source checkout: `<monorepo>/packages/maker-cc-manager/dist/cc-mgr.mjs`.
 *      Resolved from `app.getAppPath()` which in dev points at `apps/desktop`.
 *   2. Electron Forge packaged build with `extraResource`: under `process.resourcesPath`.
 *   3. Electron Forge packaged with asar.unpacked layout: alongside `app.asar`.
 *
 * Throws if none found — packaging config needs to ship the bundle. Bundle is
 * NOT in git (gitignore'd); produced + staged by
 * `apps/desktop/scripts/build-remote-bundles.mjs`, hooked at predev / prepackage
 * / prebuild in `package.json`, and explicitly called from `release-{win,mac}.mjs`
 * before `electron-forge make`. Dev path candidate #1 reads from the source
 * dist (rebuilt by the pre-hook); packaged paths #2/#3 read from staged copy.
 */
export function resolveCcManagerBundlePath(): string {
  const appPath = app.getAppPath();
  const candidates = [
    path.join(appPath, '..', '..', 'packages', 'maker-cc-manager', 'dist', 'cc-mgr.mjs'),
    path.join(process.resourcesPath ?? '', 'cc-manager', 'cc-mgr.mjs'),
    path.join(`${appPath}.unpacked`, 'packages', 'maker-cc-manager', 'dist', 'cc-mgr.mjs'),
  ];
  for (const candidate of candidates) {
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && st.size > 0) return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    `cc-mgr.mjs bundle not found in any of: ${candidates.join(' | ')} — ` +
      'packaging needs to ship packages/maker-cc-manager/dist/cc-mgr.mjs as extraResource',
  );
}


/**
 * Optional companion proxy bundle. Phase 6 wires this in when host pref
 * `compatProxyMode='on'` (not yet implemented in Settings UI). Returns null
 * if the bundle isn't shipped.
 */
export function resolveProxyBundlePath(): string | null {
  const appPath = app.getAppPath();
  // candidate #2 路径跟 forge.config.ts 的 extraResource 一一对应:
  // 'resources/anthropic-compat-proxy' → packaged 后落在 process.resourcesPath/
  // anthropic-compat-proxy/。先前用过 cc-manager/ 共享目录是历史遗留, 现在 cc-mgr
  // 跟 proxy 各占独立 extraResource 目录, 路径与目录名 1:1, 易读且未来加新 bundle
  // 自然扩展。详见 scripts/build-remote-bundles.mjs。
  const candidates = [
    path.join(appPath, '..', '..', 'packages', 'anthropic-compat-proxy', 'dist', 'proxy.mjs'),
    path.join(process.resourcesPath ?? '', 'anthropic-compat-proxy', 'proxy.mjs'),
    path.join(`${appPath}.unpacked`, 'packages', 'anthropic-compat-proxy', 'dist', 'proxy.mjs'),
  ];
  for (const candidate of candidates) {
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && st.size > 0) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}
export const {getLocalCcMgrBundleVersion,listPendingCcMgrUpgrades,getPendingCcMgrUpgrade,dismissPendingCcMgrUpgrade,clearPendingUpgrade,setPendingPiUpgrade,ensureCcManagerInstalledOrInstall,clearCcManagerInstallCache,getRemoteClaudeBinaryPath,runCcMgrUpgrade}=createCcManagerInstall({logger:createLogger("remote-ssh/cc-manager-install"),resolveCcManagerBundlePath,resolveProxyBundlePath,broadcastCcMgrUpgradeAvailable,broadcastSilentInstallStatus});
