/**
 * 把对外模型代理的 **Codex(OpenAI Responses)出口**连接信息写进用户 **自己的 Codex CLI 全局
 * 配置**(`$CODEX_HOME/config.toml` 或 `~/.codex/config.toml`),让外部 `codex` 直接指向 Cindy
 * 本地 loopback。
 *
 * 这是**外向文件写**(写用户家目录),红线:
 *   - 只在用户主动点击「写入 Codex 配置」时调用(IPC 过 `assertTrustedAppRendererEvent`)。
 *   - 非破坏性 merge:只设 root `model_provider="cindy_external"` 与
 *     `[model_providers.cindy_external]`(name/base_url/wire_api/env_key)这两处,其余所有
 *     字段(其它 provider、profiles、mcp servers…)原样保留。
 *   - **token 绝不写进文件** —— codex 经 `env_key="CINDY_LOCAL_TOKEN"` 从环境变量读;预览里
 *     给出用户需在外部 shell 自设的 `export CINDY_LOCAL_TOKEN=<token>` 行(含明文,仅用户主动
 *     触发时返回)。
 *   - 写前经 `previewCodexConfig` 展示完整 merge 后 TOML + 同名冲突项,由 UI 二次确认。
 *   - 原子写(temp + rename),失败不留半截文件;`smol-toml` 解析失败/根非 table 一律不覆盖,报错。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { createLogger } from '../logger.js';
import type { LocalProxyCodexConfigPreview } from '../../shared/localProxyService.js';

const log = createLogger('local-proxy:codex-config');

/** Cindy 在用户 codex 配置里注册的 provider id / 环境变量名(固定值,勿改 —— 迁移/复用靠它)。 */
const CINDY_PROVIDER_ID = 'cindy_external';
const CINDY_TOKEN_ENV_KEY = 'CINDY_LOCAL_TOKEN';

/**
 * 用户 Codex CLI 全局配置文件路径。遵循 codex 自己的 `CODEX_HOME` 覆盖约定;
 * 未设置时用 `~/.codex`(与 codex 默认一致)。
 */
export function resolveCodexConfigPath(): string {
  const dir = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  return path.join(dir, 'config.toml');
}

/** 待写入 `[model_providers.cindy_external]` 的键值(**不含 token** —— 走 env_key)。 */
function buildProviderBlock(codexUrl: string): Record<string, string> {
  return {
    name: 'Cindy',
    base_url: codexUrl,
    wire_api: 'responses',
    env_key: CINDY_TOKEN_ENV_KEY,
  };
}

/** 用户需在外部 shell 自设的 token 环境变量行(含明文 token)。 */
function buildTokenExportLine(token: string): string {
  return `export ${CINDY_TOKEN_ENV_KEY}=${token}`;
}

/**
 * 读并解析现有 config.toml。文件不存在 → 空壳(exists=false)。存在但 `smol-toml` 解析失败、
 * 或根不是 table → 抛错(调用方据此拒绝写,绝不覆盖用户的坏文件/异形结构)。
 */
function readExistingConfig(filePath: string): { exists: boolean; root: Record<string, unknown> } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, root: {} };
    }
    throw err;
  }
  if (raw.trim().length === 0) {
    return { exists: true, root: {} };
  }
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${filePath} 不是合法 TOML(${detail}),已放弃写入(不覆盖用户文件)。`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath} 顶层不是 table,已放弃写入。`);
  }
  return { exists: true, root: parsed as Record<string, unknown> };
}

/** 从已解析根里取现有的 `model_providers.cindy_external` 块(不存在/异形 → 空对象)。 */
function existingProviderBlock(root: Record<string, unknown>): Record<string, unknown> {
  const providers = root.model_providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return {};
  const block = (providers as Record<string, unknown>)[CINDY_PROVIDER_ID];
  if (!block || typeof block !== 'object' || Array.isArray(block)) return {};
  return block as Record<string, unknown>;
}

/**
 * 非破坏性 merge:返回一个新的根 table,仅设 `model_provider` 与 `model_providers.cindy_external`,
 * 其余字段(含其它 provider 块)原样保留。
 */
function mergeConfig(root: Record<string, unknown>, codexUrl: string): Record<string, unknown> {
  const providersRaw = root.model_providers;
  const providers =
    providersRaw && typeof providersRaw === 'object' && !Array.isArray(providersRaw)
      ? { ...(providersRaw as Record<string, unknown>) }
      : {};
  providers[CINDY_PROVIDER_ID] = {
    ...existingProviderBlock(root),
    ...buildProviderBlock(codexUrl),
  };
  return {
    ...root,
    model_provider: CINDY_PROVIDER_ID,
    model_providers: providers,
  };
}

/** 收集会被覆盖的同名冲突项(root.model_provider 与 provider 块内四个键)。 */
function collectConflicts(
  root: Record<string, unknown>,
  codexUrl: string,
): { key: string; current: string; next: string }[] {
  const conflicts: { key: string; current: string; next: string }[] = [];
  const currentProvider = root.model_provider;
  if (typeof currentProvider === 'string' && currentProvider !== CINDY_PROVIDER_ID) {
    conflicts.push({ key: 'model_provider', current: currentProvider, next: CINDY_PROVIDER_ID });
  }
  const existing = existingProviderBlock(root);
  for (const [key, next] of Object.entries(buildProviderBlock(codexUrl))) {
    const current = existing[key];
    if (typeof current === 'string' && current !== next) {
      conflicts.push({ key: `model_providers.${CINDY_PROVIDER_ID}.${key}`, current, next });
    }
  }
  return conflicts;
}

/** 生成写入预览:目标路径、是否存在、完整 merge 后 TOML、冲突项、需自设的 token env 行。 */
export function previewCodexConfig(codexUrl: string, token: string): LocalProxyCodexConfigPreview {
  const filePath = resolveCodexConfigPath();
  const { exists, root } = readExistingConfig(filePath);
  const proposedToml = stringifyToml(mergeConfig(root, codexUrl));
  return {
    path: filePath,
    exists,
    proposedToml,
    conflicts: collectConflicts(root, codexUrl),
    tokenExportLine: buildTokenExportLine(token),
  };
}

/**
 * 非破坏性写入:merge `model_provider` 与 `[model_providers.cindy_external]`,保留其它所有字段,
 * 原子落盘。解析失败/异形结构直接抛,不写(见 readExistingConfig)。token 不入文件。
 */
export function writeCodexConfig(
  codexUrl: string,
): { success: true; path: string } | { success: false; error: string } {
  const filePath = resolveCodexConfigPath();
  try {
    const { root } = readExistingConfig(filePath);
    const nextRoot = mergeConfig(root, codexUrl);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    // 保权限:codex config.toml 常含 provider 凭证,可能本就是 0600。temp+rename 若用
    // Node 默认 `0666 & umask`(常见 022 → 0644)落位,会把一个 0600 的密文配置 rename 成
    // 世界可读,泄漏同机其它用户可读的凭证。故:文件已存在 → 沿用其原有 mode(绝不放宽);
    // 新建 → 收紧到 0600。Windows(NTFS)不吃 POSIX mode 位,跳过 chmod。(#1666 review)
    let targetMode = 0o600;
    try {
      targetMode = fs.statSync(filePath).mode & 0o777;
    } catch { /* 文件不存在 → 用默认 0600 */ }
    const tmpPath = `${filePath}.${process.pid}-${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, `${stringifyToml(nextRoot)}\n`, 'utf8');
      if (process.platform !== 'win32') {
        fs.chmodSync(tmpPath, targetMode);
      }
      fs.renameSync(tmpPath, filePath);
    } catch (writeErr) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort 清理 */ }
      throw writeErr;
    }
    log.info(`已写入 Codex 对外代理配置到 ${filePath}`);
    return { success: true, path: filePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`写入 Codex 对外代理配置失败: ${message}`);
    return { success: false, error: message };
  }
}
