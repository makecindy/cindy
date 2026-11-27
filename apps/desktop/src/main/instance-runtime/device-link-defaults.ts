import fs from 'node:fs';
import path from 'node:path';

/** Only called for a validated cloud runtime, before relay initialization. Never overwrites user preferences. */
export function initializeCloudDeviceLinkDefaults(userData: string): void {
  const file = path.join(userData, 'device-link-settings.json');
  let fd: number;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
  try {
    fs.writeFileSync(fd, JSON.stringify({remoteControlEnabled:true,remoteDesktopEnabled:true,
      keepAwake:false,revokedControllers:[],disabledControlDeviceIds:[],lastKnownDeviceNames:{}}) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
