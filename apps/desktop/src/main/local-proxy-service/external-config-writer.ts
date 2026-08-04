/**
 * 把对外模型代理的连接信息写进用户 **自己的 Claude Code 全局配置**
 * (`~/.claude/settings.json` 的 `env` 段),让外部 `claude` CLI 直接指向 Cindy 本地服务。
 *
 * 这是**外向文件写**(写用户家目录),红线:
 *   - 只在用户主动点击「写入配置」时调用(IPC 过 `assertTrustedAppRendererEvent`)。
 *   - 非破坏性 merge:只增改 `env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_API_KEY` 两个键,
 *     其余 env 键与所有其它顶层配置原样保留。
 *   - 写前经 `previewExternalConfig` 展示将改动的内容 + 同名冲突项,由 UI 二次确认。
 *   - 原子写(temp + rename),失败不留半截文件;解析失败/非法 JSON 一律不覆盖,报错回滚。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from '../logger.js';
import type {
  LocalProxyConfigPreview,
  LocalProxyConfigWriteResult,
} from '../../shared/localProxyService.js';

const log = createLogger('local-proxy:external-config');

const ENV_BASE_URL_KEY = 'ANTHROPIC_BASE_URL';
const ENV_API_KEY_KEY = 'ANTHROPIC_API_KEY';

/**
 * 用户 Claude Code 全局配置目录。遵循 CLI 自己的 `CLAUDE_CONFIG_DIR` 覆盖约定;
 * 未设置时用 `~/.claude`(与 CLI 默认一致)。
 */
export function resolveClaudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

/** 待写入的 env 键值。 */
export function buildProposedEnv(url: string, token: string): Record<string, string> {
  return {
    [ENV_BASE_URL_KEY]: url,
    [ENV_API_KEY_KEY]: token,
  };
}

interface ParsedSettings {
  /** 解析出的顶层对象(非对象 JSON 视为损坏)。 */
  root: Record<string, unknown>;
  /** 现有 env 段(若存在且为对象)。 */
  env: Record<string, string>;
}

/**
 * 读并解析现有配置。文件不存在 → 返回空壳(exists=false)。存在但不是合法 JSON 对象、
 * 或 `env` 段不是对象 → 抛错(调用方据此拒绝写,绝不覆盖用户的坏文件/异形结构)。
 */
function readExistingSettings(filePath: string): { exists: boolean; parsed: ParsedSettings } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, parsed: { root: {}, env: {} } };
    }
    throw err;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // 空文件视为「无配置」,可安全新建结构。
    return { exists: true, parsed: { root: {}, env: {} } };
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new Error(`${filePath} 不是合法 JSON,已放弃写入(不覆盖用户文件)。`);
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`${filePath} 顶层不是对象,已放弃写入。`);
  }
  const root = json as Record<string, unknown>;
  const envRaw = root.env;
  const env: Record<string, string> = {};
  if (envRaw !== undefined) {
    if (envRaw === null || typeof envRaw !== 'object' || Array.isArray(envRaw)) {
      throw new Error(`${filePath} 的 env 段不是对象,已放弃写入。`);
    }
    for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) {
      // Claude Code 的 env 值都是字符串;非字符串项原样透传(下面写回时保留)。
      if (typeof v === 'string') env[k] = v;
    }
  }
  return { exists: true, parsed: { root, env } };
}

/** 生成写入预览:目标路径、是否存在、将写入的 env、以及会被覆盖的同名冲突项。 */
export function previewExternalConfig(url: string, token: string): LocalProxyConfigPreview {
  const filePath = resolveClaudeSettingsPath();
  const { exists, parsed } = readExistingSettings(filePath);
  const proposedEnv = buildProposedEnv(url, token);
  const conflicts: { key: string; current: string; next: string }[] = [];
  for (const [key, next] of Object.entries(proposedEnv)) {
    const current = parsed.env[key];
    if (current !== undefined && current !== next) {
      conflicts.push({ key, current, next });
    }
  }
  return { path: filePath, exists, proposedEnv, conflicts };
}

/**
 * 非破坏性写入:merge 两个键进 `env`,保留其它 env 键与所有顶层字段,原子落盘。
 * 解析失败/异形结构直接抛,不写(见 readExistingSettings)。
 */
export function writeExternalConfig(url: string, token: string): LocalProxyConfigWriteResult {
  const filePath = resolveClaudeSettingsPath();
  try {
    const { parsed } = readExistingSettings(filePath);
    // 保留 root 里原样的 env 段(含非字符串项),只覆盖我们这两个键。
    const existingEnvRaw =
      parsed.root.env && typeof parsed.root.env === 'object' && !Array.isArray(parsed.root.env)
        ? (parsed.root.env as Record<string, unknown>)
        : {};
    const nextRoot: Record<string, unknown> = {
      ...parsed.root,
      env: { ...existingEnvRaw, ...buildProposedEnv(url, token) },
    };
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}-${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, `${JSON.stringify(nextRoot, null, 2)}\n`, 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (writeErr) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort 清理 */ }
      throw writeErr;
    }
    log.info(`已写入对外代理配置到 ${filePath}`);
    return { success: true, path: filePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`写入对外代理配置失败: ${message}`);
    return { success: false, error: message };
  }
}
