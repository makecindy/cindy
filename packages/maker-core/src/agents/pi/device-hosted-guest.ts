/**
 * 受邀者(供应商分享的另一个账号)在本机运行的 Pi 托管会话。
 *
 * 文件、命令与 Cindy 工具经隧道回到受邀者电脑；本机只出 Pi 与供应商。本机用户自己的 Pi 包、
 * 扩展、托管技能、全局说明与技能偏好不进入会话；受邀者随会话带来的项目扩展也不在本机执行。
 * 受邀者带来的 `.pi/skills`、`.agents/skills`、`.pi/prompts` 与说明文件照常生效。
 *
 * 说明文件：Pi 从工作目录一路向上读到磁盘根目录，会话目录之上是本机用户的目录(例如家目录
 * 里的 AGENTS.md / CLAUDE.md)，Pi 没有只排除其中几级的开关。受邀者会话用
 * `--no-context-files` 关掉发现，再由本文件的扩展把会话目录内的说明文件按 Pi 原生顺序与
 * 格式放回系统提示(before_agent_start 的 systemPromptOptions.contextFiles)。
 *
 * 供应商：受邀者只能用分享给它的那一个供应商。models.json、子代理可选的模型路由与本机 proxy
 * 令牌都只保留它；分享的不是 Cindy 网关(xd)时不写网关模型。
 *
 * 只对受邀者生效；同账号托管会话与本机任务的启动参数、配置与扩展完全不变。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { PiNativeProvidersResult } from '../base-agent.js';
import { isInsideDeviceHostedRoot } from '../shared/device-hosted.js';
import { PI_GLOBAL_CONTEXT_FILE_NAMES } from './global-context.js';
import type { PiProjectResourceCliPaths } from './project-resource-cli.js';

/** 关掉 Pi 的隐式发现(本机 `~/.agents/skills`、配置里的技能 / 模板、向上查找的说明文件)。 */
export const PI_DEVICE_HOSTED_GUEST_FLAGS = ['--no-skills', '--no-prompt-templates', '--no-context-files'] as const;

/** 分享的供应商是 Cindy 网关(xd)：受邀者会话只用网关模型，不用任何 Pi 原生 provider。 */
export function piGuestUsesGateway(providerId: string): boolean {
  return providerId === 'xd';
}

const ENV_REFERENCE = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** 一个 provider 用到的 env：api key 变量，以及 models.json 里 `$VAR` 引用的(自定义请求头等)。 */
function referencedEnvNames(provider: PiNativeProvidersResult['providers'][number]): string[] {
  const names = provider.apiKeyEnvVar ? [provider.apiKeyEnvVar] : [];
  for (const match of JSON.stringify(provider).matchAll(ENV_REFERENCE)) names.push(match[1]!);
  return names;
}

/**
 * 只保留分享的那个供应商的 Pi 原生 provider；env 只留它用到的(api key 与请求头引用)，
 * 其余一律去掉：本机用户其它供应商的路由与密钥(含请求头里的凭证)不进入受邀者的 Pi 进程。
 */
export function restrictPiGuestNativeProviders<T extends PiNativeProvidersResult | null | undefined>(
  result: T,
  providerId: string,
): T {
  if (!result) return result;
  const shared = piGuestUsesGateway(providerId) ? [] : result.providers.filter(
    (provider) => (provider.sourceProviderId ?? provider.id) === providerId,
  );
  const keptKeys = new Set(shared.flatMap(referencedEnvNames));
  return {
    ...result,
    providers: shared,
    env: Object.fromEntries(Object.entries(result.env).filter(([key]) => keptKeys.has(key))),
  };
}

/** 只保留会话目录内的项目技能与提示词模板；项目扩展一律不加载(会在本机执行)。 */
export function restrictPiGuestProjectResources(
  resources: PiProjectResourceCliPaths,
  guestRoot: string,
): PiProjectResourceCliPaths {
  const inside = (target: string) => isInsideDeviceHostedRoot(target, guestRoot);
  return Object.freeze({
    skills: Object.freeze(resources.skills.filter(inside)),
    promptTemplates: Object.freeze(resources.promptTemplates.filter(inside)),
    extensions: Object.freeze([]),
  });
}

export interface PiGuestContextFile {
  path: string;
  content: string;
}

/**
 * 与 Pi 原生发现相同的规则，只在会话目录内：每一级取第一个存在的说明文件
 * (AGENTS.override.md → AGENTS.md → AGENTS.MD → CLAUDE.md → CLAUDE.MD)，顺序从上级到工作目录。
 * 工作目录不在会话目录内时只看工作目录本身。
 */
export async function collectPiGuestContextFiles(workingDir: string, guestRoot: string): Promise<PiGuestContextFile[]> {
  const cwd = path.resolve(workingDir);
  const root = path.resolve(guestRoot);
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (!isInsideDeviceHostedRoot(dir, root)) break;
    dirs.unshift(dir);
    // 到达会话目录本身就停(按真实路径比较，避免符号链接下越过会话目录)。
    if (isInsideDeviceHostedRoot(root, dir) || path.dirname(dir) === dir) break;
  }
  if (dirs.length === 0) dirs.push(cwd);
  const files: PiGuestContextFile[] = [];
  for (const dir of dirs) {
    for (const name of PI_GLOBAL_CONTEXT_FILE_NAMES) {
      const filePath = path.join(dir, name);
      try {
        if (!(await fs.stat(filePath)).isFile()) continue;
        const content = await fs.readFile(filePath, 'utf8');
        files.push({ path: filePath, content: content.charCodeAt(0) === 0xfeff ? content.slice(1) : content });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        throw error;
      }
    }
  }
  return files;
}

export const CINDY_GUEST_CONTEXT_EXTENSION_FILENAME = 'cindy-guest-context.ts';
export const CINDY_GUEST_CONTEXT_DATA_FILENAME = 'cindy-guest-context.json';

/**
 * 写进 configHome/internal-extensions 的扩展源码(跑在 Pi 进程里，不能 import Cindy 模块)。
 * 必须排在 cindy-bridge 之前加载：托管时 bridge 在 before_agent_start 里按当前选项渲染整段
 * 系统提示，说明文件要先放进去。模板里不得出现反引号与 `${`(外层 String.raw 会插值)。
 */
export const CINDY_GUEST_CONTEXT_EXTENSION_SOURCE = String.raw`/**
 * cindy-guest-context: project instructions of a shared-user task, restricted to its session directory.
 * Pi runs with --no-context-files so files above the session directory (this computer's user) never load.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type GuestContextFile = { path: string; content: string };

function loadGuestContextFiles(): GuestContextFile[] {
  const home = process.env.PI_CODING_AGENT_DIR;
  if (!home) return [];
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'internal-extensions', '${CINDY_GUEST_CONTEXT_DATA_FILENAME}'), 'utf8'));
    const files = Array.isArray(parsed && parsed.files) ? parsed.files : [];
    return files.filter((file: any) => file && typeof file.path === 'string' && typeof file.content === 'string')
      .map((file: any) => ({ path: file.path, content: file.content }));
  } catch {
    return [];
  }
}

export default function cindyGuestContext(pi: any) {
  const files = loadGuestContextFiles();
  if (files.length === 0) return;
  pi.on('before_agent_start', (event: any) => {
    const options = event && event.systemPromptOptions;
    if (!options || typeof options !== 'object') return;
    const current = Array.isArray(options.contextFiles) ? options.contextFiles : [];
    const seen = new Set(current.map((file: any) => file && file.path));
    const missing = files.filter((file) => !seen.has(file.path)).map((file) => ({ path: file.path, content: file.content }));
    if (missing.length > 0) options.contextFiles = [...missing, ...current];
  });
}
`;
