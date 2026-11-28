/**
 * stdioMcp.ts (shared, 跨进程)
 * ---------------------------------------------------------------------------
 * 本地 stdio MCP 配置的形状与校验，单独成文件是为了不把 maker-core 的类型引入
 * 只需要这个形状的程序（`scripts/device-link` 的 tsconfig 会把 import 链一起编译）。
 */

/** Runs on the Desktop owning this configuration, never in the task's project. */
export interface StdioMcpConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function isStdioMcpConfig(value: unknown): value is StdioMcpConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  const string = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0');
  return Object.keys(c).every(key => ['command', 'args', 'env'].includes(key)) &&
    string(c.command) && c.command.trim().length > 0 &&
    Array.isArray(c.args) && c.args.every(string) &&
    !!c.env && typeof c.env === 'object' && !Array.isArray(c.env) &&
    Object.entries(c.env).every(([key, val]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && string(val));
}
