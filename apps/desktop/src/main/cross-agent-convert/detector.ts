/**
 * cross-agent-convert / detector
 *
 * 4 项独立判断（双向）。每一项"对面端有内容 ∧ 本端缺失" → 推入 items。
 *
 * 关键：用 codex 同款 `is_missing_or_empty_text_file` 语义 ——
 *   目标"不存在 OR trim 后为空" 才视为缺失。
 *
 * 集合类（agents/hooks）按子项粒度枚举：subItems 列出每个待转换的具体单位。
 * Skill 使用同一份 SKILL.md + 双目录兼容链接，不属于跨 Agent 格式转换。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

import type {
  AgentKind,
  DetectResult,
  MigrationDirection,
  MigrationItem,
} from './types.js';

export interface DetectInput {
  workingDir: string;
  agentKind: AgentKind;
}

/** 文件不存在 OR 存在但 trim 后为空 → true。目录或非文件 → false。 */
export async function isMissingOrEmptyTextFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return false;
    const raw = await fs.readFile(p, 'utf8');
    return raw.trim().length === 0;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === 'ENOENT') return true;
    return false;
  }
}

/** 文件存在且 trim 后非空。 */
export async function isNonEmptyTextFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return false;
    const raw = await fs.readFile(p, 'utf8');
    return raw.trim().length > 0;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function listFilesByExt(p: string, ext: string): Promise<string[]> {
  try {
    const ents = await fs.readdir(p, { withFileTypes: true });
    return ents.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(ext)).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 检测阶段要求 Claude agent 文件包含可解析 YAML 中的非空字符串 `name`，
 * 避免把普通 Markdown 误报为可迁移代理。转换器对缺少或假值 `name` 的源文件
 * 会跳过，但不在这里重复执行转换。
 */
async function isConvertibleClaudeAgentFile(p: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) return false;
    const parsed = yaml.load(match[1]);
    const name =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { name?: unknown }).name
        : undefined;
    return typeof name === 'string' && name.trim().length > 0;
  } catch {
    return false;
  }
}

export async function detect(input: DetectInput): Promise<DetectResult> {
  const wd = input.workingDir;
  if (!wd) return { items: [] };

  const items: MigrationItem[] = [];
  const direction: MigrationDirection = input.agentKind === 'claude-code' ? 'to-claude' : 'to-codex';

  // ── 第 1 项：CLAUDE.md ↔ AGENTS.md ────────────────────────────────────
  await detectAgentsMd(wd, direction, items);

  // ── 第 2 项：agents/ ─────────────────────────────────────────────────
  await detectAgents(wd, direction, items);

  // ── 第 3 项：hooks/ + settings.json/hooks.json ───────────────────────
  await detectHooks(wd, direction, items);

  // ── 第 4 项：MCP ────────────────────────────────────────────────────
  await detectMcp(wd, direction, items);

  return { items };
}

async function detectAgentsMd(wd: string, direction: MigrationDirection, items: MigrationItem[]): Promise<void> {
  const claudeMd = path.join(wd, 'CLAUDE.md');
  const agentsMd = path.join(wd, 'AGENTS.md');
  if (direction === 'to-claude') {
    if ((await isNonEmptyTextFile(agentsMd)) && (await isMissingOrEmptyTextFile(claudeMd))) {
      items.push({
        id: 'agents-md:0',
        kind: 'agents-md',
        direction,
        label: 'AGENTS.md → CLAUDE.md',
        source: agentsMd,
        target: claudeMd,
      });
    }
  } else {
    if ((await isNonEmptyTextFile(claudeMd)) && (await isMissingOrEmptyTextFile(agentsMd))) {
      items.push({
        id: 'agents-md:0',
        kind: 'agents-md',
        direction,
        label: 'CLAUDE.md → AGENTS.md',
        source: claudeMd,
        target: agentsMd,
      });
    }
  }
}

async function detectAgents(wd: string, direction: MigrationDirection, items: MigrationItem[]): Promise<void> {
  const claudeAgents = path.join(wd, '.claude', 'agents');
  const codexAgents = path.join(wd, '.codex', 'agents');

  if (direction === 'to-claude') {
    // codex/agents/<name>.toml → claude/agents/<name>.md
    if (!(await isDir(codexAgents))) return;
    const sourceFiles = await listFilesByExt(codexAgents, '.toml');
    if (sourceFiles.length === 0) return;
    const targetExisting = new Set((await listFilesByExt(claudeAgents, '.md')).map((n) => n.replace(/\.md$/i, '')));
    const baseNames = sourceFiles.map((f) => f.replace(/\.toml$/i, ''));
    const missing = baseNames.filter((n) => !targetExisting.has(n));
    if (missing.length === 0) return;
    items.push({
      id: 'agents:0',
      kind: 'agents',
      direction,
      label: `agents (${missing.length} 个新增)`,
      source: codexAgents,
      target: claudeAgents,
      subItems: missing.map((name) => ({
        name,
        sourcePath: path.join(codexAgents, `${name}.toml`),
        targetPath: path.join(claudeAgents, `${name}.md`),
      })),
    });
  } else {
    // claude/agents/<name>.md → codex/agents/<name>.toml
    if (!(await isDir(claudeAgents))) return;
    const sourceFiles = await listFilesByExt(claudeAgents, '.md');
    if (sourceFiles.length === 0) return;
    const convertibleSourceFiles: string[] = [];
    for (const file of sourceFiles) {
      if (await isConvertibleClaudeAgentFile(path.join(claudeAgents, file))) {
        convertibleSourceFiles.push(file);
      }
    }
    if (convertibleSourceFiles.length === 0) return;
    const targetExisting = new Set(
      (await listFilesByExt(codexAgents, '.toml')).map((n) => n.replace(/\.toml$/i, '')),
    );
    const baseNames = convertibleSourceFiles.map((f) => f.replace(/\.md$/i, ''));
    const missing = baseNames.filter((n) => !targetExisting.has(n));
    if (missing.length === 0) return;
    items.push({
      id: 'agents:0',
      kind: 'agents',
      direction,
      label: `agents (${missing.length} 个新增)`,
      source: claudeAgents,
      target: codexAgents,
      subItems: missing.map((name) => ({
        name,
        sourcePath: path.join(claudeAgents, `${name}.md`),
        targetPath: path.join(codexAgents, `${name}.toml`),
      })),
    });
  }
}

async function detectHooks(wd: string, direction: MigrationDirection, items: MigrationItem[]): Promise<void> {
  const claudeHooksDir = path.join(wd, '.claude', 'hooks');
  const claudeSettings = path.join(wd, '.claude', 'settings.json');
  const codexHooksDir = path.join(wd, '.codex', 'hooks');
  const codexHooksJson = path.join(wd, '.codex', 'hooks.json');

  if (direction === 'to-claude') {
    // 源：codex 端
    const hasSourceDir = await isDir(codexHooksDir);
    const hasSourceJson = await isNonEmptyTextFile(codexHooksJson);
    if (!hasSourceDir && !hasSourceJson) return;
    // 目标缺失判断：claude settings.json 不存在 / 不含 hooks 段，或 .claude/hooks/ 不存在
    const claudeSettingsHasHooks = await fileHasJsonKey(claudeSettings, 'hooks');
    const claudeHooksDirExists = await isDir(claudeHooksDir);
    if (claudeSettingsHasHooks && claudeHooksDirExists) return;
    items.push({
      id: 'hooks:0',
      kind: 'hooks',
      direction,
      label: 'Codex hooks → Claude hooks',
      source: codexHooksJson, // converter 内部据此推算 dir
      target: claudeSettings,
    });
  } else {
    const hasSourceDir = await isDir(claudeHooksDir);
    const hasSourceJson = await fileHasJsonKey(claudeSettings, 'hooks');
    if (!hasSourceDir && !hasSourceJson) return;
    const codexHooksJsonExists = await isNonEmptyTextFile(codexHooksJson);
    const codexHooksDirExists = await isDir(codexHooksDir);
    if (codexHooksJsonExists && codexHooksDirExists) return;
    items.push({
      id: 'hooks:0',
      kind: 'hooks',
      direction,
      label: 'Claude hooks → Codex hooks',
      source: claudeHooksDir, // converter 据此推算 settings.json 路径
      target: codexHooksJson,
    });
  }
}

async function detectMcp(wd: string, direction: MigrationDirection, items: MigrationItem[]): Promise<void> {
  const mcpJson = path.join(wd, '.mcp.json');
  const codexConfigToml = path.join(wd, '.codex', 'config.toml');

  if (direction === 'to-claude') {
    // 源：codex config.toml 含 [mcp_servers]
    if (!(await fileHasTomlSection(codexConfigToml, 'mcp_servers'))) return;
    if (await fileHasJsonKey(mcpJson, 'mcpServers')) return; // 已有就不动（这里仍会让 converter 内部 merge 缺失项；保守起见 detector 直接跳过）
    items.push({
      id: 'mcp:0',
      kind: 'mcp',
      direction,
      label: '.codex/config.toml → .mcp.json',
      source: codexConfigToml,
      target: mcpJson,
    });
  } else {
    if (!(await fileHasJsonKey(mcpJson, 'mcpServers'))) return;
    if (await fileHasTomlSection(codexConfigToml, 'mcp_servers')) return;
    items.push({
      id: 'mcp:0',
      kind: 'mcp',
      direction,
      label: '.mcp.json → .codex/config.toml',
      source: mcpJson,
      target: codexConfigToml,
    });
  }
}

async function fileHasJsonKey(p: string, key: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && key in parsed;
  } catch {
    return false;
  }
}

async function fileHasTomlSection(p: string, sectionName: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    // 简单文本匹配 [section]，避免引入 TOML 解析依赖到 detector（converter 才需要）
    const re = new RegExp(`^\\s*\\[${sectionName}(\\.|\\])`, 'm');
    return re.test(raw);
  } catch {
    return false;
  }
}
