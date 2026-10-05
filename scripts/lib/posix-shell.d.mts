import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export function resolvePosixShell(
  shellName: string,
  options?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    spawnSyncImpl?: typeof spawnSync;
    existsSync?: typeof existsSync;
  },
): string | null;
