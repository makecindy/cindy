import path from 'node:path';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import { describeToolUse, createdPathsFromDescriptor } from '@cindy/maker-shared/tool-use-descriptor';
import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import { isContentToolFailureLike } from '@cindy/maker-shared/message-presentation';
import { parseToolResultPayload } from '@cindy/maker-shared/payload-summary';
import { extractCommandOutputPathCandidates } from '../../shared/commandOutputPaths.js';
import { findPathMatches } from '../../shared/bareFilePathTokens.js';
import { getDbClient } from '../localDb/client/current.js';
import type { SharedTaskPeerCapture } from './sharedTaskDispatch.js';

const markdown = unified().use(remarkParse);
// /clear retains message rows. Resolve the live boundary in each query, including
// tool pairing, rather than reusing a snapshot from before the owner cleared it.
const visibleHistory = `EXISTS (SELECT 1 FROM sessions s WHERE s.id = messages.session_id
  AND (s.cleared_at IS NULL OR messages.created_at > s.cleared_at))`;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function decode(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

/** Transport success does not override a failure inside the tool's result. */
function toolResultFailed(content: unknown): boolean {
  let value = content;
  for (;;) {
    const parsed = typeof value === 'string' ? decode(value) : value;
    const envelope = record(parsed);
    // Main persists actual harness failures with this marker. For legacy plain
    // text use anchored diagnostics, never presentation's whole-body keywords.
    if (!envelope) return typeof parsed === 'string' && isContentToolFailureLike({ body: '', secondaryBody: parsed });
    if (envelope.ok === false || envelope.success === false || envelope.isError === true || envelope.is_error === true) return true;
    const status = typeof envelope.status === 'string' ? envelope.status.toLowerCase() : '';
    if (['error', 'failed', 'failure', 'denied', 'declined'].includes(status)) return true;
    if ([envelope.exitCode, envelope.exit_code].some((code) => typeof code === 'number' && Number.isFinite(code) && code !== 0)) return true;
    if (['error', 'errors', 'exception'].some((key) => {
      const error = envelope[key];
      if (typeof error === 'string') return error.trim().length > 0;
      if (Array.isArray(error)) return error.length > 0;
      return error === true || (typeof error === 'number' && error !== 0) || record(error) !== null;
    })) return true;
    // stderr, stdout and delivery URLs are data. An unqualified legacy message
    // can still carry an error diagnostic, but explicit success takes precedence.
    const success = envelope.ok === true || envelope.success === true || envelope.isError === false || envelope.is_error === false
      || envelope.exitCode === 0 || envelope.exit_code === 0 || ['success', 'completed', 'ok'].includes(status);
    if (!success && typeof envelope.message === 'string'
      && isContentToolFailureLike({ body: '', secondaryBody: envelope.message })) return true;
    if (envelope.ok !== true || !record(envelope.result)) return false;
    value = envelope.result;
  }
}

/** Only explicit file references count; a substring in source, a patch or a log does not. */
function references(content: unknown, role: string, includeText: boolean): string[] {
  const body = record(content);
  if (role === 'tool_use') {
    const tool = parseMessageToolUse({ role, content });
    const descriptor = describeToolUse(tool.toolName, tool.input);
    if (descriptor.kind === 'command') return extractCommandOutputPathCandidates(descriptor.command);
    return createdPathsFromDescriptor(descriptor);
  }
  if (role === 'tool_result') {
    // Display extractors also find URLs inside read/search/log output. Those
    // URLs are content, not authority; only explicit delivery fields count here.
    const payload = parseToolResultPayload(typeof content === 'string' ? content : JSON.stringify(content));
    if (payload?._xdt_render_image === false) return [];
    const produced = Array.isArray(payload?.xdt_media_produced) ? payload.xdt_media_produced : [];
    const models = Array.isArray(payload?._xdt_model_files) ? payload._xdt_model_files.map((file) => record(file)?.url) : [];
    return [...produced, ...models].filter((url): url is string => typeof url === 'string');
  }
  const result: string[] = [];
  // Persisted attachments have passed the host's input-reference admission and
  // materialization. Never interpret a JSON-looking message string as attachments.
  for (const key of ['files', 'images']) {
    if (!Array.isArray(body?.[key])) continue;
    for (const attachment of body[key]) {
      const file = record(attachment);
      if (typeof file?.path === 'string') result.push(file.path);
      if (typeof file?.url === 'string') result.push(file.url);
    }
  }
  if (!includeText) return result;
  const text = typeof content === 'string' ? content : typeof body?.text === 'string' ? body.text : '';
  // Match the rendered links/file chips, not examples inside fenced source or
  // unused reference definitions. An AST also preserves spaces and parentheses.
  result.push(text);
  const tree = markdown.parse(text);
  const definitions = new Map<string, string>();
  visit(tree, 'definition', (node) => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  visit(tree, (node, _index, parent) => {
    if (node.type === 'link' || node.type === 'image') result.push(node.url);
    else if (node.type === 'inlineCode') result.push(node.value);
    else if (node.type === 'text' && parent?.type !== 'link' && parent?.type !== 'linkReference') {
      result.push(...findPathMatches(node.value).map((match) => match.value));
    } else if (node.type === 'linkReference' || node.type === 'imageReference') {
      const url = definitions.get(node.identifier);
      if (url) result.push(url);
    }
  });
  return result;
}

function referencePath(reference: string, workingDir: string): string | null {
  let value = reference.trim();
  // Match renderer/lib/markdownTarget.normalizeSandboxHref: lexical absolute
  // path normalization only; task provenance and sensitive-path gates still apply.
  const sandbox = value.match(/^sandbox:\/*(?:([a-z]:[\\/][^\n]*)|(\/[^\n]*))$/i);
  if (sandbox) value = sandbox[1] ?? sandbox[2] ?? value;
  try {
    if (value.startsWith('xdt-file://') || value.startsWith('xdt-audio://')) {
      const url = new URL(value);
      // A remote file reference must never grant access to a coincident local path.
      if (url.searchParams.has('remoteHostId')) return null;
      value = url.searchParams.get('path') ?? (value.startsWith('xdt-file:///') ? decodeURIComponent(value.slice('xdt-file://'.length)) : '');
    } else if (value.startsWith('file://')) {
      value = fileURLToPath(value);
    } else {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
      // Markdown file links may carry a line locator. It is not part of the file.
      value = value.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)$/, '');
      // Raw local Markdown destinations/attachment paths preserve literal '%',
      // unlike file:// and query-based URLs, which were decoded above.
    }
    if (!value || value.includes('\0')) return null;
    if (!path.isAbsolute(value) && !/^(?:\.\.?)[\\/]/.test(value)) return null;
    return path.resolve(workingDir, value);
  } catch { return null; }
}

/** Read current host history, never the guest's payload or a stale authorization cache. */
export async function sharedTaskReferencesFile(
  requested: string, workingDir: string, capture: SharedTaskPeerCapture,
): Promise<boolean> {
  const name = path.basename(requested);
  const encodedName = encodeURIComponent(name);
  const needles = [name, encodedName, encodedName.replace(/[!'()*]/g, (char) => '%' + char.charCodeAt(0).toString(16)), JSON.stringify(name).slice(1, -1)];
  let after = 0;
  while (capture.isCurrent()) {
    const rows = await getDbClient().query<{ rowid: number; role: string; content: string; agentMeta: string | null; toolUseId: string | null; createdAt: number }>(
      `SELECT rowid, role, content, agent_meta AS agentMeta, tool_use_id AS toolUseId, created_at AS createdAt FROM messages
       WHERE session_id = ? AND rewind_at IS NULL AND rowid > ?
         AND ${visibleHistory}
         AND role IN ('user', 'assistant', 'tool_use', 'tool_result')
         AND (instr(lower(content), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0)
       ORDER BY rowid LIMIT 64`,
      [capture.author.sessionId, after, ...needles],
    );
    if (!capture.isCurrent()) return false;
    for (const row of rows) {
      // Guest attribution is stamped by Main. Guest prose never grants access;
      // only the separately validated, host-materialized attachments are usable.
      const meta = row.agentMeta ? record(decode(row.agentMeta)) : null;
      if (row.role === 'user' && row.agentMeta && !meta) continue;
      const content = decode(row.content);
      if (!references(content, row.role, row.role !== 'user' || !meta?.sharedTaskAuthor).some((reference) => {
        const candidate = referencePath(reference, workingDir);
        return candidate !== null && path.relative(requested, candidate) === '';
      })) continue;
      if (row.role === 'tool_result') {
        // A URL in a failed result (including error diagnostics) is not delivery.
        // Pair with the live invocation so failure detection uses its tool kind.
        if (!row.toolUseId) continue;
        const uses = await getDbClient().query<{ content: string }>(
          `SELECT content FROM messages WHERE session_id = ? AND role = 'tool_use'
           AND rewind_at IS NULL AND tool_use_id = ? AND rowid < ?
           AND ${visibleHistory} ORDER BY rowid DESC LIMIT 1`,
          [capture.author.sessionId, row.toolUseId, row.rowid],
        );
        if (!capture.isCurrent()) return false;
        if (!uses.length) continue;
        const tool = parseMessageToolUse({ role: 'tool_use', content: decode(uses[0].content) });
        const descriptor = describeToolUse(tool.toolName, tool.input);
        // Native readers and shell commands can echo JSON-shaped file contents.
        // Their actual outputs are authorized via invocation output paths below;
        // delivery metadata is a contract of MCP/dynamic tool responses only.
        if (descriptor.kind !== 'mcp' && descriptor.kind !== 'dynamic') continue;
        if (toolResultFailed(content)) continue;
      }
      if (row.role === 'tool_use') {
        // A queued/denied tool invocation is not delivery. Only completed output
        // records can expose generated file chips outside the workspace.
        const tool = parseMessageToolUse({ role: row.role, toolUseId: row.toolUseId, content });
        if (!tool.toolUseId) continue;
        const results = await getDbClient().query<{ content: string; createdAt: number }>(
          `SELECT content, created_at AS createdAt FROM messages WHERE session_id = ? AND role = 'tool_result'
           AND rewind_at IS NULL AND tool_use_id = ? AND rowid > ?
           AND ${visibleHistory} ORDER BY rowid LIMIT 1`,
          [capture.author.sessionId, tool.toolUseId, row.rowid],
        );
        if (!capture.isCurrent()) return false;
        if (!results.length) continue;
        const result = decode(results[0].content);
        const descriptor = describeToolUse(tool.toolName, tool.input);
        if (toolResultFailed(result)) continue;
        if (descriptor.kind === 'command' || descriptor.kind === 'mcp') {
          // Shell destinations and MCP output arguments are only candidates.
          // Success must not expose an untouched, pre-existing destination file.
          const start = row.createdAt;
          const end = results[0].createdAt;
          if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
          const file = await stat(requested).catch(() => null);
          if (!capture.isCurrent()) return false;
          // Message timestamps have millisecond precision; include the result's
          // final millisecond even when the filesystem reports fractional ms.
          if (!file?.isFile() || !Number.isFinite(file.mtimeMs) || file.mtimeMs < start || file.mtimeMs >= end + 1) continue;
        }
      }
      return true;
    }
    if (rows.length < 64) return false;
    const last = rows[rows.length - 1].rowid;
    if (last <= after) return false;
    after = last;
  }
  return false;
}
