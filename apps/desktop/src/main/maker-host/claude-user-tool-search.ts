/**
 * 读取用户**显式**配置的 ENABLE_TOOL_SEARCH(issue #7524)。
 *
 * Cindy 对未知兼容性的上游默认把 ENABLE_TOOL_SEARCH 注入为 'false'(见
 * claude-behavior-flags.ts,#2929 的 fail-closed 防线)。但 flags 合并进子进程环境后优先级
 * 高于 settings.json 的 `env` 块,用户主动写下的 `"ENABLE_TOOL_SEARCH": "true"` 会被静默
 * 覆盖,且无处可改。这里只读这一个键,让用户的显式选择能压过 Cindy 的默认值。
 *
 * 优先级与终端里直接运行 claude 一致:宿主进程环境 > ~/.claude/settings.json 的 env。
 * 只读 `env.ENABLE_TOOL_SEARCH` 一个键,不读取、不记录该文件的其它内容;读不到、解析失败
 * 或值不合法一律视为未配置(回到 Cindy 默认)。
 *
 * 解析口径与 Claude CLI 一致:接受 BOM、注释与尾逗号(JSONC)。maker-core 的
 * workspace-settings-guard 里有同样的 stripJsonc,但它没有从包里导出;为避免为此改动共享包
 * 的 exports,这里保留一份同逻辑的小函数,两处改动时需同步。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code 接受 true / false / auto / auto:N(阈值百分比)。其它值按未配置处理,
// 避免把任意字符串写进子进程环境。
const TOOL_SEARCH_VALUE = /^(?:true|false|auto(?::\d{1,3})?)$/i;

/** 去掉 JSONC 的注释与尾逗号(字符串里的内容原样保留)。 */
function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function normalize(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return TOOL_SEARCH_VALUE.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

export function readUserToolSearchOverride(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string | undefined {
  const fromEnv = normalize(env.ENABLE_TOOL_SEARCH);
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8');
    const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
    const parsed: unknown = JSON.parse(stripJsonc(text));
    const settingsEnv = (parsed as { env?: Record<string, unknown> } | null)?.env;
    return normalize(settingsEnv?.ENABLE_TOOL_SEARCH);
  } catch {
    return undefined;
  }
}
