import { createHash } from 'node:crypto';
import { isValidPluginNamespace } from '@cindy/plugin-protocol';
import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import { readTurnResources, type TurnResourceReceipt } from '@cindy/maker-shared/turn-resources';
import { GHOST_CALL_TOOL_NAMES, isGhostCallToolName, isValidGhostId } from '../shared/ghost.js';
import { installedGhostLogicalIdentity, parsePluginInstanceId } from '../shared/pluginIdentity.js';
import { getDbClient } from './localDb/client/current.js';
import type { DbClient } from './localDb/client/DbClient.js';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function decode(value: unknown): unknown {
  for (let i = 0; i < 3 && typeof value === 'string'; i++) {
    try { value = JSON.parse(value); } catch { break; }
  }
  return value;
}

/** Only safe labels and opaque identities can leave the executing host. */
export function createTurnResourceReceipt(
  kind: TurnResourceReceipt['kind'], identity: string, name: unknown,
): TurnResourceReceipt | undefined {
  const id = `tr_${createHash('sha256').update(JSON.stringify([kind, identity])).digest('hex').slice(0, 24)}`;
  return readTurnResources([{ kind, id, name }])[0];
}

function resultPayload(value: unknown): unknown {
  const decoded = decode(value);
  const envelope = record(decoded);
  const content = Array.isArray(decoded) ? decoded : envelope?.content;
  if (Array.isArray(content)) {
    const text = content.map(item => record(item)?.text).filter((item): item is string => typeof item === 'string').join('\n');
    return decode(text);
  }
  return decoded;
}

const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function pluginInvocation(toolName: string, input: unknown) {
  const tool = parseMessageToolUse({ role: 'tool_use', content: { toolName, input } });
  const args = record(tool.input);
  if (!isGhostCallToolName(tool.toolName) || !args || args.grant_only === true || typeof args.tool !== 'string') return;
  if (args.tool === 'list_tools' || (args.tool === 'call_tool' && record(args.args)?.name === 'list_tools')) return;
  const rawId = typeof args.ghost_id === 'string' ? args.ghost_id : '';
  const identity = isValidGhostId(rawId) ? null : parsePluginInstanceId(rawId);
  const ghostId = identity?.ghostId ?? (isValidGhostId(rawId) ? rawId : null);
  if (!ghostId) return;
  const namespace = identity ? identity.namespace : args.namespace;
  if (namespace !== undefined && namespace !== null && !isValidPluginNamespace(namespace)) return;
  return { rawId, ghostId, namespace: namespace as string | null | undefined, args };
}

function pluginExecutionIdentity(invocation: NonNullable<ReturnType<typeof pluginInvocation>>): string {
  return createTurnResourceReceipt('plugin', JSON.stringify([
    invocation.namespace === undefined ? 'legacy-unspecified' : invocation.namespace, invocation.ghostId,
  ]), invocation.ghostId)!.id;
}

/** Capture a host execution fact from the original result, before presentation truncation. */
export function readExecutedPluginIdentity(toolName: string, input: unknown, result: unknown): string | undefined {
  const invocation = pluginInvocation(toolName, input);
  return invocation && record(resultPayload(result))?.ok === true ? pluginExecutionIdentity(invocation) : undefined;
}

/** Native Skill success comes from its exact original result, never a display summary. */
export function readExecutedSkillIdentity(toolName: string, input: unknown, result: unknown): string | undefined {
  const skill = record(input)?.skill;
  if (toolName !== 'Skill' || typeof skill !== 'string' || !SKILL_NAME_PATTERN.test(skill)) return;
  const text = resultPayload(result);
  if (typeof text !== 'string' || !text.trim() || text.includes('<tool_use_error>')) return;
  return createTurnResourceReceipt('skill', `claude:${skill}`, skill)?.id;
}

/** Run inside the durable message FIFO, after tool writes and before the final seal. */
export async function readTurnResourcesForReply(
  sessionId: string, replyClientId: string, inputClientIds: readonly string[],
  db: Pick<DbClient, 'queryOne' | 'query'> = getDbClient(),
): Promise<TurnResourceReceipt[]> {
  const inputs = [...new Set(inputClientIds.filter(id => typeof id === 'string' && id.length > 0))];
  if (!inputs.length) return [];
  const reply = await db.queryOne<{ content: string; meta: string | null; createdAt: number; rowid: number }>(`
    SELECT m.content, m.agent_meta AS meta, m.created_at AS createdAt, m.rowid
    FROM messages m JOIN sessions s ON s.id=m.session_id
    WHERE m.session_id=? AND m.client_id=? AND m.role='assistant' AND m.rewind_at IS NULL
      AND (s.cleared_at IS NULL OR m.created_at>s.cleared_at)
  `, [sessionId, replyClientId]);
  // safeStringify stores assistant strings verbatim, including JSON-looking answers.
  if (!reply || typeof reply.content !== 'string' || !reply.content.trim()) return [];
  const replyMeta = record(decode(reply.meta));
  if (replyMeta?.parentUuid || replyMeta?.failedSamplingAttempt || replyMeta?.assistantPhase === 'commentary'
    || !inputs.includes(String(replyMeta?.replyToClientId ?? ''))) return [];
  const rows = await db.query<{ content: string; meta: string | null; agentKind: string | null; result: string | null; resultRewindAt: number | null }>(`
    SELECT tool.content, tool.agent_meta AS meta, tool.agent_kind AS agentKind,
      (SELECT result.content FROM messages result
        WHERE result.session_id=tool.session_id AND result.role='tool_result'
          AND result.tool_use_id=tool.tool_use_id AND result.rewind_at IS NULL
          AND result.rowid>tool.rowid AND result.rowid<? AND result.created_at<=?
        ORDER BY result.created_at DESC, result.rowid DESC LIMIT 1) AS result,
      (SELECT result.rewind_at FROM messages result
        WHERE result.session_id=tool.session_id AND result.role='tool_result'
          AND result.tool_use_id=tool.tool_use_id
          AND result.rowid>tool.rowid AND result.rowid<? AND result.created_at<=?
        ORDER BY result.created_at DESC, result.rowid DESC LIMIT 1) AS resultRewindAt
    FROM messages tool JOIN sessions s ON s.id=tool.session_id
    JOIN messages input ON input.session_id=tool.session_id AND input.role='user' AND input.rewind_at IS NULL
      AND input.client_id=json_extract(CASE WHEN json_valid(tool.agent_meta) THEN tool.agent_meta ELSE '{}' END, '$.replyToClientId')
    WHERE tool.session_id=? AND tool.role='tool_use' AND tool.rewind_at IS NULL
      AND json_extract(CASE WHEN json_valid(tool.content) THEN tool.content ELSE '{}' END, '$.toolName')
        IN (SELECT value FROM json_each(?))
      AND input.client_id IN (SELECT value FROM json_each(?))
      AND input.rowid<tool.rowid AND input.created_at<=tool.created_at
      AND tool.rowid<? AND tool.created_at<=?
      AND (s.cleared_at IS NULL OR (input.created_at>s.cleared_at AND tool.created_at>s.cleared_at))
    ORDER BY tool.created_at, tool.rowid
  `, [reply.rowid, reply.createdAt, reply.rowid, reply.createdAt, sessionId,
    JSON.stringify(['Skill', 'Workflow', 'cindy_mcp_call_tool', ...GHOST_CALL_TOOL_NAMES]),
    JSON.stringify(inputs), reply.rowid, reply.createdAt]);
  const resources: TurnResourceReceipt[] = [];
  for (const row of rows) {
    // A grouped invocation may have no result row; an explicitly rewound result
    // is different and must not be restored merely because its tool has a Host fact.
    if (row.resultRewindAt !== null) continue;
    const tool = parseMessageToolUse({ role: 'tool_use', content: decode(row.content) });
    const input = record(tool.input);
    if (!input) continue;
    const meta = record(decode(row.meta));
    // Child tools inherit replyToClientId; their invocation facts belong to the child.
    if (meta?.parentUuid) continue;
    const result = resultPayload(row.result);
    const text = typeof result === 'string' ? result : '';
    if (tool.toolName === 'Workflow' && text.includes('<tool_use_error>')) continue;
    if (tool.toolName === 'Workflow') {
      // A native named-start event is stronger than a launch prompt or a tool-call attempt.
      const workflow = readTurnResources([meta?.workflowResource]).find(item => item.kind === 'workflow');
      if (workflow) resources.push(workflow);
      continue;
    }
    if (tool.toolName === 'Skill' && (row.agentKind === 'claude-code' || row.agentKind === 'cc')) {
      if (typeof input.skill !== 'string' || !SKILL_NAME_PATTERN.test(input.skill)) continue;
      const skill = createTurnResourceReceipt('skill', `claude:${input.skill}`, input.skill);
      if (skill && meta?.turnResourceSkillExecutionId === skill.id) resources.push(skill);
      continue;
    }
    const invocation = pluginInvocation(tool.toolName, input);
    if (!invocation) continue;
    // A merged result can be stored under another invocation's primary tool ID.
    // Only the exact host fact proves this invocation ran, even after result capping.
    if (meta?.turnResourcePluginExecutionId !== pluginExecutionIdentity(invocation)) continue;
    const { rawId, ghostId } = invocation;
    let { namespace } = invocation;
    let name = ghostId;
    try {
      // Resolve on the executing host, never against a controller's plugin catalog.
      const { findGhostForInstanceId } = await import('./cindy-brain/index.js');
      const installed = findGhostForInstanceId(rawId, input.namespace as string | null | undefined);
      if (installed) {
        name = installed.manifest.name;
        namespace = installedGhostLogicalIdentity(installed).namespace;
      }
    } catch { /* An unavailable/uninstalled plugin retains its safe logical id as label. */ }
    const plugin = createTurnResourceReceipt('plugin', JSON.stringify([namespace === undefined ? 'legacy-unspecified' : namespace, ghostId]), name);
    if (plugin) resources.push(plugin);
  }
  return readTurnResources(resources);
}
