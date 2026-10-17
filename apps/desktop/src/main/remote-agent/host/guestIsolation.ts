/**
 * 其他账号的控制端(供应商分享的受邀者)在本机运行 Agent 时的隔离。
 *
 * 同账号控制端由控制端自己按白名单收集项目文件(`controller/projectFiles.ts`)，本机照单
 * 落到影子目录。受邀者的载荷不可信：本机按同一份白名单复核，并去掉会让本机执行命令、改写
 * 本机 Agent 环境或读取本机文件的内容：
 *  - 只接受白名单内的说明文件、Skill / 子代理 / 命令 / 提示词模板，以及 Claude Code 项目设置；
 *  - 项目设置只保留 allow / deny / ask 权限规则(hooks、env、apiKeyHelper、状态栏命令等一律丢弃)；
 *  - frontmatter 声明了 hooks 的 Markdown 整个丢弃；`!` 预执行命令的语法被断开；
 *  - 说明文件里 `@` 导入的文件只接受 Markdown / 纯文本，按同样规则处理；
 *  - 所有 Markdown(说明、规则、命令、子代理、Skill 与导入的文件)里指向会话目录之外的 `@` 引用改成
 *    代码样式，不再被当作导入(落地时处理，见 runHost)；
 *  - 任务中途的 setVendorOptions 只留白名单内的键，附加 / 可写目录只能落在虚拟工作区内。
 * 只对受邀者生效，同账号控制端的行为不变。
 */
import os from 'node:os';
import path from 'node:path';

import type { RemoteAgentKind } from '@cindy/device-link';
import { SCHEDULER_RUN_ID_VENDOR_OPTION } from '@cindy/maker-scheduler';

import {
  PROJECT_INSTRUCTION_DIRECTORIES,
  PROJECT_INSTRUCTION_FILES,
  PROJECT_SETTINGS_FILES,
  type RemoteAgentOpenPayload,
  type RemoteAgentWireFile,
  type RemoteAgentWireImportFile,
} from '../wire';

/** owner = 本机同账号的设备；guest = 其他账号(供应商分享的受邀者)。 */
export type RemoteAgentControllerTrust = 'owner' | 'guest';

/**
 * 受邀者能在本机启动的 Agent。三者都已隔离本机用户的配置(maker-core 的 deviceHosted.guest)：
 *  - Claude Code：不执行 hooks，不加载会话目录之外的 CLAUDE.md、本机托管技能与插件清单；
 *  - Codex：独立的 CODEX_HOME(受邀者目录，登录经 token 桥只读取得)，逐项关闭本机的插件、技能、
 *    MCP、hooks、connectors、记忆与在本机执行代码的工具；
 *  - Pi：不加载本机的 Pi 包、扩展、托管技能与全局说明，不执行受邀者的项目扩展，会话文件放在
 *    受邀者目录，也不能经 Agent 在本机装 Pi 包。
 * 三者都只经分享的那一个供应商出站：启动与换模型时核对，按请求的路由由本机 proxy 守门
 * (maker-host/guest-provider-route-store)，子代理也不能改道到本机的其它供应商。
 */
export const GUEST_SUPPORTED_AGENTS: ReadonlySet<RemoteAgentKind> = new Set<RemoteAgentKind>(['claude-code', 'codex', 'pi']);

/**
 * 受邀者能经 setVendorOptions 改的键：只有同账号控制端实际会发的协同(Orca Lead 身份)与定时任务
 * 运行标记。其余键(例如影响恢复、分叉或本机 MCP 身份的)一律丢弃。
 */
export const GUEST_VENDOR_OPTION_KEYS: ReadonlySet<string> = new Set([
  'orcaRole',
  'orcaWorkflowId',
  'orcaLeadSessionId',
  'initialWorker',
  SCHEDULER_RUN_ID_VENDOR_OPTION,
]);

/** 受邀者的 setVendorOptions 补丁：只留白名单内的键。 */
export function sanitizeGuestVendorOptions(patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  return Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([key]) => GUEST_VENDOR_OPTION_KEYS.has(key)));
}

/**
 * 受邀者的附加 / 可写目录只能落在本次任务的虚拟工作区内(控制端把真实目录映射到这里)。
 * 越界的路径会让本机 Agent 把本机目录当成工作区的一部分(例如读取其中的说明文件与技能)，丢弃。
 */
export function confineGuestDirs(dirs: unknown, virtualRoot: string | undefined): string[] {
  if (!virtualRoot || !Array.isArray(dirs)) return [];
  return dirs.filter((dir): dir is string => typeof dir === 'string' && isInside(path.resolve(dir), path.resolve(virtualRoot)));
}

const PERMISSION_KEYS = ['allow', 'deny', 'ask'] as const;
const MAX_RULES_PER_KEY = 512;
const MAX_RULE_LENGTH = 4096;

function decodeText(data: string): string {
  return Buffer.from(data, 'base64').toString('utf8');
}

function encodeText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Claude Code 项目设置只留下 allow / deny / ask 规则；没有可用规则时返回 null(整个文件不落地)。 */
export function sanitizeGuestClaudeSettings(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const permissions = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).permissions
    : undefined;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return null;
  const kept: Record<string, string[]> = {};
  for (const key of PERMISSION_KEYS) {
    const value = (permissions as Record<string, unknown>)[key];
    if (!Array.isArray(value)) continue;
    const rules = value
      .filter((rule): rule is string => typeof rule === 'string' && rule.length > 0 && rule.length <= MAX_RULE_LENGTH)
      .slice(0, MAX_RULES_PER_KEY);
    if (rules.length) kept[key] = rules;
  }
  return Object.keys(kept).length ? JSON.stringify({ permissions: kept }, null, 2) : null;
}

/** Markdown frontmatter 里声明了 hooks(Skill / 子代理的 hooks 会在本机执行命令)。 */
export function declaresFrontmatterHooks(text: string): boolean {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  return !!match && /^hooks\s*:/m.test(match[1]);
}

/** 断开 Skill / 命令里 `!`命令`` 预执行语法：插入空格后只是普通文字，不会在本机先跑命令。 */
export function neutralizeShellInjection(text: string): string {
  return text.split('!`').join('! `');
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveImport(candidate: string, fileDir: string, home: string): string {
  if (candidate === '~' || candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    return path.join(home, candidate.slice(1));
  }
  if (path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) return path.resolve(candidate);
  return path.resolve(fileDir, candidate);
}

const IMPORT_TOKEN = /(^|[\s(])@([^\s`'"()<>[\]{}]+)/g;

function neutralizeImportsInText(text: string, fileDir: string, allowedRoot: string, home: string): string {
  return text.replace(IMPORT_TOKEN, (whole, prefix: string, candidate: string) => {
    const resolved = resolveImport(candidate, fileDir, home);
    return isInside(resolved, allowedRoot) ? whole : `${prefix}\`@${candidate}\``;
  });
}

/**
 * Claude Code 说明文件里的 `@路径` 会在本机读取文件拼进上下文。指向 allowedRoot(本次会话目录)
 * 之外的引用改成代码样式：代码里的 `@` 不会被当作导入。代码块与行内代码保持原样。
 */
export function neutralizeExternalImports(
  text: string,
  fileDir: string,
  allowedRoot: string,
  home: string = os.homedir(),
): string {
  let fence: string | null = null;
  return text.split(/(\r?\n)/).map((line) => {
    if (line === '\n' || line === '\r\n') return line;
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (fence) {
      if (marker === fence) fence = null;
      return line;
    }
    if (marker) {
      fence = marker;
      return line;
    }
    // 奇数段是行内代码(`...`)，原样保留。
    return line.split(/(`+[^`]*`+)/).map((part, index) => (
      index % 2 === 1 ? part : neutralizeImportsInText(part, fileDir, allowedRoot, home)
    )).join('');
  }).join('');
}

function guestInstructionAsset(file: RemoteAgentWireFile): RemoteAgentWireFile[] {
  if (!/\.md$/i.test(file.path)) return [file];
  const text = decodeText(file.data);
  if (declaresFrontmatterHooks(text)) return [];
  const neutral = neutralizeShellInjection(text);
  return [neutral === text ? file : { path: file.path, data: encodeText(neutral) }];
}

function guestProjectFile(file: RemoteAgentWireFile): RemoteAgentWireFile[] {
  if ((PROJECT_INSTRUCTION_FILES as readonly string[]).includes(file.path)) return [file];
  if ((PROJECT_SETTINGS_FILES as readonly string[]).includes(file.path)) {
    const sanitized = sanitizeGuestClaudeSettings(decodeText(file.data));
    return sanitized ? [{ path: file.path, data: encodeText(sanitized) }] : [];
  }
  if (PROJECT_INSTRUCTION_DIRECTORIES.some((dir) => file.path.startsWith(`${dir}/`))) return guestInstructionAsset(file);
  return [];
}

/** 导入的文件：只接受 Markdown 与纯文本(其它类型可能是本机 Agent 会执行或加载的配置)。 */
function guestImportFile(file: RemoteAgentWireImportFile): RemoteAgentWireImportFile[] {
  if (!/\.(?:md|markdown|txt)$/i.test(file.path)) return [];
  return guestInstructionAsset(file).map((asset) => ({ ...file, data: asset.data }));
}

/** 受邀者的打开载荷：按白名单复核项目文件与个人配置。`@` 引用在落地时按实际目录处理。 */
export function sanitizeGuestOpenPayload(payload: RemoteAgentOpenPayload): RemoteAgentOpenPayload {
  const { importFiles: received, ...rest } = payload;
  const importFiles = (received ?? []).flatMap(guestImportFile);
  return {
    ...rest,
    projectFiles: payload.projectFiles.flatMap(guestProjectFile),
    ...(importFiles.length ? { importFiles } : {}),
    personal: {
      ...payload.personal,
      files: payload.personal.files.flatMap(guestInstructionAsset),
    },
  };
}
