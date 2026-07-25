import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

export interface HeadlessPaths {
  configDir: string;
  stateDir: string;
  runtimeDir: string;
  configFile: string;
  databaseFile: string;
  socketFile: string;
}

/**
 * Resolve only explicit per-user locations. In particular, never fall back to
 * cwd: a systemd service must not accidentally write runtime state into a
 * checkout or another user's project directory.
 */
export function resolveHeadlessPaths(env: NodeJS.ProcessEnv = process.env): HeadlessPaths {
  const home = env.HOME?.trim() || os.homedir();
  const configBase = env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config');
  const stateBase = env.XDG_STATE_HOME?.trim() || path.join(home, '.local', 'state');
  const runtimeBase = env.XDG_RUNTIME_DIR?.trim() || path.join(stateBase, 'run');
  const configDir = path.join(configBase, 'cindy-headless');
  const stateDir = path.join(stateBase, 'cindy-headless');
  const runtimeDir = path.join(runtimeBase, 'cindy-headless');
  return {
    configDir,
    stateDir,
    runtimeDir,
    configFile: path.join(configDir, 'config.json'),
    databaseFile: path.join(stateDir, 'sessions.db'),
    socketFile: path.join(runtimeDir, 'control.sock'),
  };
}

export async function ensureHeadlessDirectories(paths: HeadlessPaths): Promise<void> {
  await Promise.all([
    fs.mkdir(paths.configDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(paths.stateDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    fs.chmod(paths.configDir, 0o700),
    fs.chmod(paths.stateDir, 0o700),
    fs.chmod(paths.runtimeDir, 0o700),
  ]);
}
