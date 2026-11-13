/**
 * 本机 Codex CLI 主目录的唯一判据。
 *
 * 用户可以用 `CODEX_HOME` 把 Codex CLI 的主目录指到别处(Windows 的
 * `E:\CodexHome`、Linux/NixOS 的自定义目录都常见)。只有**绝对路径**生效:
 * 空值或相对路径一律回退 `~/.codex` —— 相对路径会按 cwd 解析,落进工作区。
 *
 * 凭证发现、远端同步、设置页的 CLI 扫描共用这一处(#8258),免得同一台电脑上
 * 「凭证在 A 目录、扫描在 B 目录」这种分裂。
 */
import path from 'node:path';

export function codexHomeDir(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env.CODEX_HOME;
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(home, '.codex');
}
