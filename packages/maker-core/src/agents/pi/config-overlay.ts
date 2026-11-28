/**
 * Pi 用户扩展配置投影（config-overlay）。
 *
 * 会话 `configHome` 每次启动都是随机隔离目录（`run-tmp/<hex>`），扩展自带的配置文件
 * （例如 `web-search.json`）没法只靠用户手动放置跨任务生效。稳定根
 * `<agentHome>/config-overlay/` 承载这类惰性配置：启动时复制进本次 `configHome`。
 *
 * 只做单向投影，**不写回**：会话里扩展对配置的修改只在本次会话生效，清扫时随
 * `configHome` 一起消失。稳定根只能由用户自己编辑 —— 否则 Full access 会话可以借
 * `configHome` 把模型写的配置持久到用户的 agent home，绕过「模型写 agent home 必须
 * 用户确认」这条隔离（见 docs/dev-rules/pi-full-access-native-parity.md）。
 *
 * 其余边界（见 docs/dev-rules/pi-harness.md §2「用户扩展配置投影」）：
 * - 只收扁平、`*.json`、非保留名的普通文件；符号链接不跟随（与全局约定同一口径：
 *   复制内容，不建指向用户文件的可写链接）。
 * - `settings.json`／`models.json`／`auth.json`／`mcp.json`、权限快照、`internal-extensions`、
 *   `extensions/`、`skills/`、`prompts/`、`themes/` 等保留名一律拒绝 —— 投影它们会绕过
 *   Cindy 的配置、凭证与 MCP 审批边界。
 * - 投影失败不阻断 Pi 启动（宿主辅助能力不得让 Pi 比原生更难用），只回报被拒文件名与原因。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const PI_CONFIG_OVERLAY_DIR_NAME = 'config-overlay';
/** 单次投影最多接受的配置文件数，防止把 configHome 变成用户文件树。 */
export const PI_CONFIG_OVERLAY_MAX_FILES = 32;
/** 单个配置文件上限。扩展配置是惰性 JSON，超过这个量级不是配置而是数据。 */
export const PI_CONFIG_OVERLAY_MAX_FILE_BYTES = 256 * 1024;
const MAX_FILE_NAME_LENGTH = 128;
/** 日志里最多回报多少个被拒文件名，避免一次坏目录刷爆日志。 */
export const PI_CONFIG_OVERLAY_LOG_LIMIT = 8;

/**
 * 不允许通过 overlay 投影的名字（小写比较，Windows 文件名大小写不敏感）。
 * 这些文件由 Cindy 或 Pi 自己的配置／凭证／审批链路负责，投影会绕过既有边界。
 */
export const PI_CONFIG_OVERLAY_RESERVED_NAMES: readonly string[] = [
  'settings.json',
  'models.json',
  'auth.json',
  'mcp.json',
  'pi-cache-compatibility.json',
  'pi-native-compat-overrides.json',
  'append-system-prompt.md',
  'system.md',
  'append_system.md',
  'agents.md',
  'agents.override.md',
  'claude.md',
  'extensions',
  'skills',
  'prompts',
  'themes',
  'sessions',
  'runtime',
  'run-tmp',
  'fork-tmp',
  'internal-extensions',
  'cindy-managed-skills',
  'bash-package-home',
  'bin',
];

export type PiConfigOverlayRejectionReason =
  | 'not-a-regular-file'
  | 'invalid-name'
  | 'reserved-name'
  | 'too-many-files'
  | 'too-large'
  | 'invalid-json'
  | 'write-failed';

export interface PiConfigOverlayEntry {
  readonly name: string;
  readonly bytes: number;
}

export interface PiConfigOverlayRejection {
  readonly name: string;
  readonly reason: PiConfigOverlayRejectionReason;
}

export interface PiConfigOverlayProjection {
  readonly entries: readonly PiConfigOverlayEntry[];
  readonly rejected: readonly PiConfigOverlayRejection[];
  /** 稳定根整体不可用（读目录失败等）。不阻断启动，只用于诊断。 */
  readonly error?: string;
}

export function piConfigOverlayDir(agentHome: string): string {
  return path.join(agentHome, PI_CONFIG_OVERLAY_DIR_NAME);
}

function isReservedOverlayName(name: string): boolean {
  return PI_CONFIG_OVERLAY_RESERVED_NAMES.includes(name.toLowerCase());
}

/** 扁平 `*.json`，只允许保守字符集，避免路径分隔符与 Windows 设备名。 */
function isValidOverlayFileName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_FILE_NAME_LENGTH) return false;
  if (!name.toLowerCase().endsWith('.json')) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return false;
  return !isReservedOverlayName(name);
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * 把稳定根里的惰性配置复制进本次会话的 configHome。
 * 不抛错：任何异常都收敛成 `rejected`／`error`，Pi 启动继续。
 */
export async function projectPiConfigOverlay(
  agentHome: string,
  configHome: string,
): Promise<PiConfigOverlayProjection> {
  const sourceDir = piConfigOverlayDir(agentHome);
  let dirents;
  try {
    dirents = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return { entries: [], rejected: [] };
    return {
      entries: [],
      rejected: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const entries: PiConfigOverlayEntry[] = [];
  const rejected: PiConfigOverlayRejection[] = [];
  for (const dirent of [...dirents].sort((a, b) => a.name.localeCompare(b.name))) {
    const name = dirent.name;
    if (!dirent.isFile()) {
      rejected.push({ name, reason: 'not-a-regular-file' });
      continue;
    }
    if (!isValidOverlayFileName(name)) {
      rejected.push({
        name,
        reason: isReservedOverlayName(name) ? 'reserved-name' : 'invalid-name',
      });
      continue;
    }
    if (entries.length >= PI_CONFIG_OVERLAY_MAX_FILES) {
      rejected.push({ name, reason: 'too-many-files' });
      continue;
    }
    let bytes: Buffer;
    try {
      const stat = await fs.stat(path.join(sourceDir, name));
      if (!stat.isFile()) {
        rejected.push({ name, reason: 'not-a-regular-file' });
        continue;
      }
      if (stat.size > PI_CONFIG_OVERLAY_MAX_FILE_BYTES) {
        rejected.push({ name, reason: 'too-large' });
        continue;
      }
      bytes = await fs.readFile(path.join(sourceDir, name));
    } catch {
      rejected.push({ name, reason: 'not-a-regular-file' });
      continue;
    }
    if (bytes.byteLength > PI_CONFIG_OVERLAY_MAX_FILE_BYTES) {
      rejected.push({ name, reason: 'too-large' });
      continue;
    }
    try {
      JSON.parse(bytes.toString('utf8'));
    } catch {
      rejected.push({ name, reason: 'invalid-json' });
      continue;
    }
    try {
      await fs.writeFile(path.join(configHome, name), bytes, { mode: 0o600 });
    } catch {
      rejected.push({ name, reason: 'write-failed' });
      continue;
    }
    entries.push({ name, bytes: bytes.byteLength });
  }
  return { entries, rejected };
}
