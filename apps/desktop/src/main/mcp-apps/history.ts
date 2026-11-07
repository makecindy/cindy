import { parseMcpAppRecord, projectMcpAppContent } from '@cindy/maker-shared/mcp-apps';
import { t } from '../i18n.js';

/** Keep Host trust visible in the existing public title, without exporting private metadata. */
export function projectMcpAppHistory(content: unknown, marked = false): unknown {
  const projected = projectMcpAppContent(content, marked);
  if (!marked) return projected;
  let value = content;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return projected; }
  }
  const record = parseMcpAppRecord(value);
  const meta = record?.tool._meta as Record<string, unknown> | undefined;
  const plugin = meta?.['cindy/plugin'] as { name?: unknown; trust?: unknown } | undefined;
  if (!plugin || typeof plugin.name !== 'string' || typeof plugin.trust !== 'string' ||
      !['unverified', 'cindy-official', 'reviewed', 'verified-publisher'].includes(plugin.trust)) return projected;
  const history = (projected as { mcpAppHistory: { version: number; title: string; text: string } }).mcpAppHistory;
  return { mcpAppHistory: { ...history, title: `${plugin.name} · ${t(`mcpApps.pluginTrust.${plugin.trust}`)}` } };
}
