/**
 * 换引擎续做：导入完成后按现有「切换引擎」交接机制生成交接文本，写成隐藏的
 * context_rebuild 标记。下一次发送时由 agentHandoffPending 从数据库取出并注入，
 * 用户在发送前换了引擎，切换流程会生成新的交接覆盖它。
 *
 * 交接文本由代码确定性拼出（最近几轮逐字 + 更早轮次一行提要），不调用模型；
 * 完整记录仍全部留在任务里。
 */

import { getDbClient } from '../localDb/client/current.js';
import { buildHandoffText, type HandoffSourceMessage } from '../maker-ipc/agentHandoff.js';
import type { NativeHarness } from './types.js';

const HARNESS_LABEL: Record<NativeHarness, string> = { cc: 'Claude Code', codex: 'Codex', pi: 'Pi' };
/** 交接只需要近期逐字与早期一行提要：近期取足够多的行，早期只取用户消息。 */
const RECENT_ROWS = 600;
const EARLY_USER_TEXT_CAP = 600;

export function harnessLabel(kind: NativeHarness): string {
  return HARNESS_LABEL[kind];
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function readHandoffSource(sessionId: string): Promise<HandoffSourceMessage[]> {
  const db = getDbClient();
  const recent = await db.query<{ rowid: number; role: string; content: string; createdAt: number; toolUseId: string | null; agentMeta: string | null }>(`
    SELECT rowid, role, content, created_at AS createdAt, tool_use_id AS toolUseId, agent_meta AS agentMeta
    FROM messages
    WHERE session_id = ? AND rewind_at IS NULL AND role IN ('user','assistant','tool_use','tool_result')
      AND NOT (agent_meta IS NOT NULL AND json_valid(agent_meta) AND json_type(agent_meta, '$.sessionImport') IS NOT NULL)
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `, [sessionId, RECENT_ROWS]);
  recent.reverse();
  const oldest = recent[0]?.createdAt ?? Number.MAX_SAFE_INTEGER;
  const early = await db.query<{ content: string; createdAt: number }>(`
    SELECT content, created_at AS createdAt
    FROM messages
    WHERE session_id = ? AND rewind_at IS NULL AND role = 'user' AND created_at < ?
    ORDER BY created_at ASC, rowid ASC
  `, [sessionId, oldest]);
  const out: HandoffSourceMessage[] = early.map((r) => {
    const content = parse(r.content);
    const text = typeof content === 'string' ? content : (content as { text?: unknown })?.text;
    return { role: 'user', content: typeof text === 'string' ? text.slice(0, EARLY_USER_TEXT_CAP) : content, createdAt: r.createdAt };
  });
  for (const r of recent) {
    out.push({ role: r.role, content: parse(r.content), createdAt: r.createdAt, toolUseId: r.toolUseId, agentMeta: r.agentMeta });
  }
  return out;
}

export async function buildImportHandoffMarker(params: {
  sessionId: string;
  fromLabel: string;
  toHarness: NativeHarness;
}): Promise<{ id: string; clientId: string; content: string; createdAt: number }> {
  const messages = await readHandoffSource(params.sessionId);
  const handoff = buildHandoffText(messages, {
    fromLabel: params.fromLabel,
    toLabel: harnessLabel(params.toHarness),
    sessionId: params.sessionId,
    reason: 'agent-switch',
  });
  const last = messages[messages.length - 1]?.createdAt ?? Date.now();
  return {
    id: `imp-${params.sessionId}-handoff`,
    clientId: `import:${params.sessionId}:handoff`,
    content: JSON.stringify({ handoff, consumed: false, reason: 'session-import', from: params.fromLabel }),
    createdAt: last + 1,
  };
}
