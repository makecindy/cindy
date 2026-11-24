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
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { CLAUDE_LONG_LIVED_TOKEN_FILE, claudeConfigDirectory } from '@cindy/maker-core/claude-cli-login-status';

const TOKEN_ENV_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

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
async function readUserSettings(file: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Claude settings file is not an object');
  return parsed as Record<string, unknown>;
}

function settingsEnv(settings: Record<string, unknown>): Record<string, unknown> {
  const env = settings.env;
  return env && typeof env === 'object' && !Array.isArray(env) ? { ...(env as Record<string, unknown>) } : {};
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
  const settings = await readUserSettings(file);
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
  const settings = await readUserSettings(file);
  const env = settingsEnv(settings);
  if (!(TOKEN_ENV_KEY in env)) return false;
  delete env[TOKEN_ENV_KEY];
  const next = { ...settings };
  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;
  await writePrivateFile(file, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}
