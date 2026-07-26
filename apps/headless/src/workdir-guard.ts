import { realpath } from 'node:fs/promises';
import type { HeadlessConfigStore } from './config.js';

/** Resolve both sides before comparing, so symlinks cannot escape a permitted root. */
export async function isRemoteWorkdirAllowed(config: HeadlessConfigStore, requested: string): Promise<boolean> {
  if (!requested || !requested.startsWith('/')) return false;
  let actual: string;
  try {
    actual = await realpath(requested);
  } catch {
    return false;
  }
  for (const configuredRoot of (await config.read()).workdirRoots ?? []) {
    try {
      const root = await realpath(configuredRoot);
      if (actual === root || actual.startsWith(`${root}/`)) return true;
    } catch {
      // A removed root grants no access; keeping it in config makes recovery
      // explicit instead of silently widening the allowlist.
    }
  }
  return false;
}
