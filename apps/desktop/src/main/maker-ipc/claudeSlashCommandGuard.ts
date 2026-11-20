/**
 * Claude Code 用户可手动调用的 slash command 识别。
 *
 * 为什么需要这个判断：环境说明（`[客户端说明]`、`[消息来源]`、handoff 等）按设计排在用户
 * 消息前面，但引擎的原生命令必须留在消息**最开头**。说明一旦插到前面，`/<command>` 就不再
 * 被引擎当命令解析，整段变成普通文本发给模型。用户自己装的 Skill 尤其吃亏：带
 * `disable-model-invocation: true` 的 Skill 只禁模型调用、不禁用户手输，模型看不到它，
 * 就完全不执行（#11637）。
 *
 * 名单怎么来（这决定了会不会误伤）：
 *  - 用 Claude Code 本地 customization 的**全集**：commands + skills 都算。`/` 菜单是渲染
 *    视图（只含 enabled 的、且经过扁平化），模型可用技能列表是另一份子集 —— 两者都不能当
 *    "用户能手动敲出来的命令全名"。
 *  - 名字取目录名 / 文件名（Claude Code 的 slash 命名空间按这个建），同时把 frontmatter 里
 *    的 `name` 也收进来：两者不一致时，真实命令名是哪个都能命中。
 *  - `enabled === false` 的条目不算 —— 装了但没启用的 Skill，引擎那边也不认。
 *
 * 不做的事：不把所有 `/` 开头的文本都放行。宽匹配会把 `/compactness`、`/Users/x` 这类
 * 普通输入误判成命令（#7907 已经在这条路上翻过车）。判定必须落在"确实存在这个名字的
 * 命令"上。
 */

import path from 'node:path';

import { scanClaudeRuntimeSkills } from '@cindy/maker-core/customization-scanner';

import { singleTextContent } from './mobileClientPromptNote';

/** 命令名提取：只认消息**最开头**的 `/<name>`。 */
export function extractSlashCommandName(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const match = /^\/(\S+)/.exec(text);
  if (!match) return null;
  const token = match[1];
  // `/Users/name` 这类路径不是命令。
  if (token.includes('/')) return null;
  return token.toLowerCase();
}

const EMPTY_NAMES: ReadonlySet<string> = new Set<string>();

/**
 * 扫描结果的短缓存。工作目录没变时不必每轮重扫盘，但新装 / 新启用的 Skill 最多
 * 延迟一个 TTL 才被认出来。
 */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; names: Set<string> }>();

/**
 * 解析当前工作目录下的 Claude Code 用户可调用命令名集合（小写）。
 *
 * `messageText` 是这一轮用户消息的正文：不是命令开头就直接返回空集合，不扫盘。
 * 扫不动（目录不存在 / 读失败）同样按"没有可调用命令"处理 —— 保持旧行为，而不是
 * 猜一个名字放行。
 */
export async function resolveClaudeUserInvocableCommandNames(
  workingDir: string | undefined,
  messageText: string | null,
): Promise<ReadonlySet<string>> {
  if (!workingDir || !path.isAbsolute(workingDir)) return EMPTY_NAMES;
  if (!messageText || !extractSlashCommandName(messageText)) return EMPTY_NAMES;

  const cached = cache.get(workingDir);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.names;

  const names = new Set<string>();
  try {
    const result = await scanClaudeRuntimeSkills(workingDir);
    for (const item of result.items) {
      if (item.kind !== 'skill' && item.kind !== 'command') continue;
      if (item.enabled === false) continue;
      names.add(item.name.toLowerCase());
      const frontmatterName = item.frontmatter?.name;
      if (typeof frontmatterName === 'string' && frontmatterName.trim()) {
        names.add(frontmatterName.trim().toLowerCase());
      }
    }
  } catch {
    // 工作目录不存在或读不动：按"没有可调用命令"处理，保持旧行为。
  }
  cache.set(workingDir, { at: Date.now(), names });
  return names;
}

export function resetClaudeUserInvocableCommandCache(): void {
  cache.clear();
}

/**
 * 这一轮的用户消息是不是"当前会话可手动调用的 Claude Code 命令"。
 *
 * 供发送链在补环境说明前判断：命中就不补说明，让命令原样留在消息最前面。
 *
 * 远端（SSH）会话的技能装在远端机上，本机扫不到 → 按"不是命令"处理，保持旧行为，
 * 不猜名字放行。
 */
export async function isUserInvocableClaudeCommand(
  message: unknown,
  session: { agentKind?: string | null; workDir?: string | null; remoteHostId?: string | null },
): Promise<boolean> {
  if (session.agentKind !== 'claude-code') return false;
  if (session.remoteHostId) return false;
  const text = singleTextContent(message);
  if (!text) return false;
  const names = await resolveClaudeUserInvocableCommandNames(session.workDir ?? undefined, text);
  if (names.size === 0) return false;
  const name = extractSlashCommandName(text);
  return name !== null && names.has(name);
}
