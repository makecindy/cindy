/**
 * claude-long-lived-token —— 把官方 `claude setup-token` 生成的长期令牌放进该账号自己的
 * Claude 配置目录,或从那里拿掉。只有官方 CLI 读它:
 *
 *   - macOS / Linux:账号目录下的 `cindy-long-lived-token`(仅本人可读)。拉起 CLI 时把这个
 *     文件的句柄交给它(maker-core claudeLongLivedTokenFile),所有任务类型都拿得到,终端里的
 *     `claude` 不受影响。
 *   - Windows:CLI 读不了继承来的句柄(它走 /dev/fd),令牌写进该账号用户设置文件的 `env`,
 *     由 CLI 加载用户设置时自己读;不加载用户设置的任务(设备托管、隔离伙伴)读不到它。
 *
 * 写入方只在生成令牌那一次经手它(claude-setup-token.ts),这里不提供读取令牌的入口。
 */

import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import { CLAUDE_LONG_LIVED_TOKEN_FILE, claudeConfigDirectory } from '@cindy/maker-core/claude-cli-login-status';

const TOKEN_ENV_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

export interface PendingClaudeLongLivedToken {
  /** Confirm the written token and remove any temporary backup of the previous one. */
  commit(): Promise<void>;
  /** Restore the previous token (or remove the newly written one if none existed). */
  rollback(): Promise<void>;
}

async function writePrivateFile(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** The account's user settings as an object; a file that is not a JSON object is left alone. */
async function readUserSettingsWithPresence(file: string): Promise<{ existed: boolean; settings: Record<string, unknown> }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false, settings: {} };
    throw error;
  }
  if (!raw.trim()) return { existed: true, settings: {} };
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Claude settings file is not an object');
  return { existed: true, settings: parsed as Record<string, unknown> };
}

function settingsEnv(settings: Record<string, unknown>): Record<string, unknown> {
  const env = settings.env;
  return env && typeof env === 'object' && !Array.isArray(env) ? { ...(env as Record<string, unknown>) } : {};
}

async function backupExistingFile(file: string, backup: string): Promise<boolean> {
  try {
    await fs.link(file, backup);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EACCES') throw error;
    try {
      await fs.copyFile(file, backup, fsConstants.COPYFILE_EXCL);
      await fs.chmod(backup, 0o600);
      return true;
    } catch (copyError) {
      await fs.rm(backup, { force: true }).catch(() => {});
      throw copyError;
    }
  }
}

/**
 * Write a new long-lived token while keeping a rollback path to any existing token until the
 * official CLI confirms the replacement. On POSIX the previous file is preserved via link/copy
 * without reading token bytes into memory.
 */
export async function replaceClaudeLongLivedToken(
  configDir: string | undefined,
  token: string,
  platform: NodeJS.Platform = process.platform,
): Promise<PendingClaudeLongLivedToken> {
  const directory = claudeConfigDirectory(configDir);
  if (platform !== 'win32') {
    const file = path.join(directory, CLAUDE_LONG_LIVED_TOKEN_FILE);
    const backup = `${file}.${randomBytes(6).toString('hex')}.bak`;
    const hasBackup = await backupExistingFile(file, backup);
    try {
      await writePrivateFile(file, `${token}\n`);
    } catch (error) {
      if (hasBackup) await fs.rm(backup, { force: true }).catch(() => {});
      throw error;
    }
    let settled = false;
    return {
      async commit() {
        if (settled) return;
        settled = true;
        if (hasBackup) await fs.rm(backup, { force: true }).catch(() => {});
      },
      async rollback() {
        if (settled) return;
        settled = true;
        if (hasBackup) {
          await fs.rename(backup, file);
          return;
        }
        await removeClaudeLongLivedToken(configDir, platform);
      },
    };
  }
  const file = path.join(directory, 'settings.json');
  const { existed, settings } = await readUserSettingsWithPresence(file);
  const previousEnv = settingsEnv(settings);
  const hadPreviousToken = Object.hasOwn(previousEnv, TOKEN_ENV_KEY);
  const previousToken = previousEnv[TOKEN_ENV_KEY];
  await writePrivateFile(file, `${JSON.stringify({ ...settings, env: { ...previousEnv, [TOKEN_ENV_KEY]: token } }, null, 2)}\n`);
  let settled = false;
  return {
    async commit() {
      settled = true;
    },
    async rollback() {
      if (settled) return;
      settled = true;
      const { settings: current } = await readUserSettingsWithPresence(file);
      const env = settingsEnv(current);
      if (hadPreviousToken) {
        env[TOKEN_ENV_KEY] = previousToken;
        await writePrivateFile(file, `${JSON.stringify({ ...current, env }, null, 2)}\n`);
        return;
      }
      delete env[TOKEN_ENV_KEY];
      const next = { ...current };
      if (Object.keys(env).length > 0) next.env = env;
      else delete next.env;
      if (!existed && Object.keys(next).length === 0) {
        await fs.rm(file, { force: true });
        return;
      }
      await writePrivateFile(file, `${JSON.stringify(next, null, 2)}\n`);
    },
  };
}

export async function saveClaudeLongLivedToken(
  configDir: string | undefined,
  token: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const directory = claudeConfigDirectory(configDir);
  if (platform !== 'win32') {
    await writePrivateFile(path.join(directory, CLAUDE_LONG_LIVED_TOKEN_FILE), `${token}\n`);
    return;
  }
  const file = path.join(directory, 'settings.json');
  const { settings } = await readUserSettingsWithPresence(file);
  await writePrivateFile(file, `${JSON.stringify({ ...settings, env: { ...settingsEnv(settings), [TOKEN_ENV_KEY]: token } }, null, 2)}\n`);
}

/** Returns whether a token was there to remove. The token stays valid at Anthropic until it expires. */
export async function removeClaudeLongLivedToken(
  configDir: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const directory = claudeConfigDirectory(configDir);
  if (platform !== 'win32') {
    try {
      await fs.unlink(path.join(directory, CLAUDE_LONG_LIVED_TOKEN_FILE));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  const file = path.join(directory, 'settings.json');
  const { settings } = await readUserSettingsWithPresence(file);
  const env = settingsEnv(settings);
  if (!(TOKEN_ENV_KEY in env)) return false;
  delete env[TOKEN_ENV_KEY];
  const next = { ...settings };
  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;
  await writePrivateFile(file, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}
