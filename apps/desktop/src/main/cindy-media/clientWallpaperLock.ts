import { app } from 'electron';
import path from 'node:path';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';

/** Only publication/recycling hold this client-wide lock, never native pickers. */
export async function withClientWallpaperLock<T>(action: () => Promise<T>): Promise<T> {
  return withCrossProcessLock(
    path.join(app.getPath('userData'), 'client-wallpaper-operation.lock'),
    { label: 'client-wallpaper', waitMs: 12_000 },
    async (status) => {
      if (!status.held) throw new Error('Client wallpaper is being changed in another process');
      return action();
    },
  );
}
