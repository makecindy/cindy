import { existsSync } from 'node:fs';

export function resolvePosixShell(
  shellName: string,
  options?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    existsSync?: typeof existsSync;
  },
): string | null;
