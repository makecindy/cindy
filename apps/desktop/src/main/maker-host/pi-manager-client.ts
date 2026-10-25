import {app} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {setPendingPiUpgrade,clearPendingUpgrade} from '../remote-ssh/cc-manager-install.js';
import {createPiManagerClient} from '@cindy/app-runtime/pi-manager-client';
export type * from '@cindy/app-runtime/pi-manager-client';


/** 本地打包的 pi-manager.mjs 路径(dev 源码 dist 或 packaged resources)。 */
export function resolvePiManagerBundlePath(): string {
  const appPath = app.getAppPath();
  const candidates = [
    path.join(appPath, '..', '..', 'packages', 'maker-pi-manager', 'dist', 'pi-manager.mjs'),
    // 轮 7 LOW-3:resourcesPath undefined(dev 模式)时 ?? '' 会拼出相对路径
    // 以 CWD 为基准查找, 永不命中还误导 —— 只在有值时加入。
    ...(process.resourcesPath
      ? [path.join(process.resourcesPath, 'pi-manager', 'pi-manager.mjs')]
      : []),
    path.join(`${appPath}.unpacked`, 'packages', 'maker-pi-manager', 'dist', 'pi-manager.mjs'),
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
    `pi-manager.mjs bundle not found in any of: ${candidates.join(' | ')} — ` +
      'packaging needs to ship packages/maker-pi-manager/dist/pi-manager.mjs as extraResource',
  );
}
export const {ensurePiManagerInstalled,resetPiManagerInstallInFlight,runPiManagerUpgrade,withPiManagerRpc,piManagerEnsure,checkPiManagerDaemonAlive,piManagerKill,piManagerList,killRemotePiManagerDaemon}=createPiManagerClient({resolvePiManagerBundlePath,setPendingPiUpgrade,clearPendingUpgrade});
