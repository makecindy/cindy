import { createHash } from 'node:crypto';
import path from 'node:path';
import { stripTrailingPathSeparators } from '../../shared/pathText';

export type SkillUsageAgentKind = 'claude-code' | 'codex' | 'pi';

export type SkillUsageExposureSource =
  | 'claude_skill_tool'
  | 'claude_invoked_skill_attachment'
  | 'claude_skill_content_injection'
  | 'claude_skill_file_read'
  | 'codex_skill_injection'
  | 'codex_skill_file_read'
  | 'pi_skill_injection'
  | 'pi_skill_file_read';

export type SkillDocumentHashSource = 'transcript_skill_content' | 'transcript_file_read' | 'unavailable';

export interface SkillUsageTranscriptInput {
  agentKind: SkillUsageAgentKind;
  /** 原生日志的逻辑身份，归档或移动文件时保持不变，子 Agent 与父任务分别取值。 */
  sessionId: string;
  sdkSessionId: string;
  rawFilePath: string;
  lines: string[];
}

export interface SkillUsageObservation {
  toolCallCount: number;
  repeatedToolCallCount: number;
  toolErrorCount: number;
  commandCallCount: number;
  commandFailureCount: number;
}

export interface SkillUsageExposure {
  id: string;
  agentKind: SkillUsageAgentKind;
  sessionId: string;
  sdkSessionId: string;
  rawFilePath: string;
  rawLineNo: number;
  skillName: string;
  skillPath: string | null;
  skillDocumentHash: string | null;
  exposureContentHash: string;
  documentHashSource: SkillDocumentHashSource;
  source: SkillUsageExposureSource;
  toolUseId: string | null;
  seenAt: number;
  observation: SkillUsageObservation;
}

export interface SkillUsageAnalysisResult {
  exposures: SkillUsageExposure[];
}

interface PendingSkillTool {
  toolUseId: string;
  skillName: string;
  turnId: string;
}

interface PendingToolCall {
  isCommand: boolean;
  exposures: SkillUsageExposure[];
  entryId: string | null;
}

interface PendingSkillRead {
  skillPaths: string[];
  turnId: string;
  entryId: string | null;
}

interface ExposureContext {
  turnId: string;
  activeExposures: SkillUsageExposure[];
  seenToolSignatures: Set<string>;
}

interface AddExposureParams {
  lineNo: number;
  source: SkillUsageExposureSource;
  text: string;
  toolUseId: string | null;
  fallbackSkillName: string | null;
  seenAt: number;
  startExposureGroup?: boolean;
  context?: ExposureContext;
}

interface AnalysisState {
  addExposure: (params: AddExposureParams) => void;
  context: ExposureContext;
  pendingSkillTools: Map<string, PendingSkillTool>;
  pendingToolCalls: Map<string, PendingToolCall>;
  pendingSkillReads: Map<string, PendingSkillRead>;
  entryId: string | null;
  piParents: Map<string, string | null> | null;
}

interface SkillContentParts {
  skillPath: string | null;
  skillName: string | null;
  documentContentForHash: string;
  exposureContentForHash: string;
}

export function analyzeSkillUsageTranscript(input: SkillUsageTranscriptInput): SkillUsageAnalysisResult {
  const exposures: SkillUsageExposure[] = [];
  const piContexts = new Map<string, ExposureContext>();
  const lastPiChildIndices = input.agentKind === 'pi' ? findLastPiChildIndices(input.lines) : new Map<string, number>();
  let nativeRecordId: string | null = null;
  const state: AnalysisState = {
    context: createExposureContext('initial'),
    pendingSkillTools: new Map(),
    pendingToolCalls: new Map(),
    pendingSkillReads: new Map(),
    entryId: null,
    piParents: input.agentKind === 'pi' ? new Map() : null,
    addExposure: (params) => {
      const context = params.context ?? state.context;
      if (params.startExposureGroup !== false) {
        context.activeExposures = [];
        context.seenToolSignatures = new Set();
      }
      const parts = parseSkillContent(params.text);
      const skillName = basenameWithoutTrailingSlash(parts.skillPath) ?? params.fallbackSkillName ?? parts.skillName ?? 'unknown';
      if (!parts.exposureContentForHash.trim()) return;
      const documentHash = resolveDocumentHash(params.source, parts);
      const exposure: SkillUsageExposure = {
        id: makeExposureId(input.agentKind, input.sessionId, nativeRecordId, params.lineNo, params.toolUseId, skillName),
        agentKind: input.agentKind,
        sessionId: input.sessionId,
        sdkSessionId: input.sdkSessionId,
        rawFilePath: input.rawFilePath,
        rawLineNo: params.lineNo,
        skillName,
        skillPath: parts.skillPath,
        skillDocumentHash: documentHash.skillDocumentHash,
        exposureContentHash: hashSkillContent(parts.exposureContentForHash),
        documentHashSource: documentHash.documentHashSource,
        source: params.source,
        toolUseId: params.toolUseId,
        seenAt: params.seenAt,
        observation: createEmptyObservation(),
      };
      exposures.push(exposure);
      context.activeExposures.push(exposure);
    },
  };

  for (let i = 0; i < input.lines.length; i += 1) {
    const lineNo = i + 1;
    const obj = parseJsonObject(input.lines[i]);
    if (!obj) continue;
    nativeRecordId = input.agentKind === 'claude-code' ? stringValue(obj.uuid) || null
      : input.agentKind === 'pi' ? stringValue(obj.id) || null
        : isRecord(obj.payload) ? stringValue(obj.payload.id) || null : null;
    const timestamp = timestampFromIso(stringValue(obj.timestamp))
      || (isRecord(obj.message) && typeof obj.message.timestamp === 'number' ? obj.message.timestamp : 0);
    const startsTurn = isGenuineUserMessage(obj, input.agentKind);
    if (input.agentKind === 'pi') {
      const entryId = stringValue(obj.id);
      if (!entryId || obj.type === 'session' || state.piParents!.has(entryId)) continue;
      const parentId = stringValue(obj.parentId) || null;
      const parent = parentId ? piContexts.get(parentId) : undefined;
      const lastChild = parentId !== null && lastPiChildIndices.get(parentId) === i;
      // 只为尚未读到的兄弟分支保留快照；线性链和最后一个子节点接管父状态。
      if (!startsTurn) {
        state.context = parent
          ? lastChild ? parent : copyExposureContext(parent)
          : createExposureContext(`pi-${entryId}`);
      }
      if (lastChild) piContexts.delete(parentId);
      state.entryId = entryId;
      state.piParents!.set(entryId, parentId);
    }
    if (startsTurn) {
      state.context = createExposureContext(`${input.agentKind}-${lineNo}`);
    }
    if (input.agentKind === 'claude-code') handleClaudeRecord(obj, lineNo, timestamp, state);
    else if (input.agentKind === 'codex') handleCodexRecord(obj, lineNo, timestamp, state);
    else {
      handlePiRecord(obj, lineNo, timestamp, state);
      if ((lastPiChildIndices.get(state.entryId!) ?? -1) > i) piContexts.set(state.entryId!, state.context);
    }
  }
  return { exposures };
}

function findLastPiChildIndices(lines: string[]): Map<string, number> {
  const lastChildIndices = new Map<string, number>();
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const obj = parseJsonObject(lines[i]);
    if (!obj || obj.type === 'session') continue;
    const entryId = stringValue(obj.id);
    if (!entryId || seen.has(entryId)) continue;
    const parentId = stringValue(obj.parentId);
    // 缺失或尚未出现的父节点不提供上下文，与实际按行解析保持一致。
    if (seen.has(parentId)) lastChildIndices.set(parentId, i);
    seen.add(entryId);
  }
  return lastChildIndices;
}

function createExposureContext(turnId: string): ExposureContext {
  return { turnId, activeExposures: [], seenToolSignatures: new Set() };
}

function copyExposureContext(context: ExposureContext): ExposureContext {
  return {
    ...context,
    activeExposures: [...context.activeExposures],
    seenToolSignatures: new Set(context.seenToolSignatures),
  };
}

// 迟到读取仍属于发起轮，不能切换新轮的曝光组。
function contextForPending(pending: Pick<ExposureContext, 'turnId'>, state: AnalysisState): ExposureContext {
  return pending.turnId === state.context.turnId
    ? state.context : createExposureContext(pending.turnId);
}

export function hashSkillContent(content: string): string {
  return sha256(normalizeSkillContent(content));
}

function isGenuineUserMessage(obj: Record<string, unknown>, agentKind: SkillUsageAgentKind): boolean {
  if (agentKind === 'codex') {
    return obj.type === 'event_msg' && isRecord(obj.payload) && obj.payload.type === 'user_message';
  }
  if (agentKind === 'pi') {
    // Pi 的 /skill 命令展开仍是用户输入，必须开始新轮。
    return obj.type === 'message' && isRecord(obj.message) && obj.message.role === 'user';
  } else if (obj.type !== 'user' || !isRecord(obj.message) || obj.isMeta === true || obj.isCompactSummary === true
    || obj.sourceToolUseID || obj.attachment || containsToolResult(obj.message.content)) return false;
  if (!isRecord(obj.message)) return false;
  const text = extractText(obj.message.content);
  return !looksLikeSkillContent(text) && !/^\s*<(?:task-notification|local-command|ide_opened_file)\b/i.test(text);
}

function handleClaudeRecord(obj: Record<string, unknown>, lineNo: number, seenAt: number, state: AnalysisState): void {
  if (isRecord(obj.attachment) && obj.attachment.type === 'invoked_skills') {
    const skills = Array.isArray(obj.attachment.skills) ? obj.attachment.skills : [];
    let isFirstExposureInGroup = true;
    for (const skill of skills) {
      if (!isRecord(skill)) continue;
      const content = stringValue(skill.content);
      if (!content) continue;
      state.addExposure({
        lineNo, source: 'claude_invoked_skill_attachment', text: content, toolUseId: null,
        fallbackSkillName: stringValue(skill.name) || null, seenAt, startExposureGroup: isFirstExposureInGroup,
      });
      isFirstExposureInGroup = false;
    }
    return;
  }
  if ((obj.type !== 'assistant' && obj.type !== 'user') || !isRecord(obj.message)) return;
  if (obj.type === 'assistant') {
    const content = Array.isArray(obj.message.content) ? obj.message.content : [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      const toolUseId = stringValue(block.id);
      const toolName = stringValue(block.name);
      const args = isRecord(block.input) ? block.input : {};
      if (toolName === 'Skill') {
        const skillName = stringValue(args.skill);
        if (toolUseId && skillName) state.pendingSkillTools.set(toolUseId, {
          toolUseId, skillName, turnId: state.context.turnId,
        });
      } else recordNativeToolCall(toolUseId, toolName, args, state);
    }
    return;
  }
  // tool_result 里的文本由调用身份识别，不能被递归 extractText 当成用户注入。
  if (containsToolResult(obj.message.content)) {
    handleNativeToolResults(extractToolResults(obj.message.content), 'claude_skill_file_read', lineNo, seenAt, true, state);
    return;
  }
  const text = extractText(obj.message.content);
  if (!looksLikeSkillContent(text)) return;
  const sourceToolUseId = stringValue(obj.sourceToolUseID);
  const pendingSkill = state.pendingSkillTools.get(sourceToolUseId)
    ?? pendingSkillForContent(text, state.pendingSkillTools, state.context.turnId);
  state.addExposure({
    lineNo, source: pendingSkill ? 'claude_skill_tool' : 'claude_skill_content_injection', text,
    toolUseId: pendingSkill?.toolUseId ?? null, fallbackSkillName: pendingSkill?.skillName ?? null, seenAt,
    context: pendingSkill ? contextForPending(pendingSkill, state) : state.context,
  });
  if (pendingSkill) state.pendingSkillTools.delete(pendingSkill.toolUseId);
}

function handleCodexRecord(obj: Record<string, unknown>, lineNo: number, seenAt: number, state: AnalysisState): void {
  if (obj.type !== 'response_item' || !isRecord(obj.payload)) return;
  const payload = obj.payload;
  if (payload.type === 'message' && payload.role === 'user') {
    const text = extractText(payload.content);
    if (looksLikeSkillContent(text)) state.addExposure({
      lineNo, source: 'codex_skill_injection', text, toolUseId: null, fallbackSkillName: parseSkillTagName(text), seenAt,
    });
    return;
  }
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const toolName = stringValue(payload.name);
    const args = payload.type === 'function_call'
      ? parseFunctionCallArguments(payload.arguments) : parseFunctionCallArguments(payload.input);
    // 自由 JavaScript 只是工具输入；不执行，也不从字符串里猜文件读取。
    const rawInput = stringValue(payload.input);
    const toolInput = Object.keys(args).length > 0 ? args
      : payload.type === 'custom_tool_call' && isCommandTool(toolName) ? { cmd: rawInput } : { input: rawInput };
    recordNativeToolCall(stringValue(payload.call_id), toolName, toolInput, state);
  } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    handleNativeToolResults([{
      toolUseId: stringValue(payload.call_id), text: extractText(payload.output), isError: payload.is_error === true,
    }], 'codex_skill_file_read', lineNo, seenAt, false, state);
  }
}

function handlePiRecord(obj: Record<string, unknown>, lineNo: number, seenAt: number, state: AnalysisState): void {
  if (obj.type !== 'message' || !isRecord(obj.message)) return;
  const message = obj.message;
  if (message.role === 'user') {
    const text = extractText(message.content);
    if (looksLikeSkillContent(text)) state.addExposure({
      lineNo, source: 'pi_skill_injection', text, toolUseId: null, fallbackSkillName: parseSkillTagName(text), seenAt,
    });
  } else if (message.role === 'assistant') {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!isRecord(block) || block.type !== 'toolCall') continue;
      recordNativeToolCall(stringValue(block.id), stringValue(block.name), parseFunctionCallArguments(block.arguments), state);
    }
  } else if (message.role === 'toolResult') {
    handleNativeToolResults([{
      toolUseId: stringValue(message.toolCallId), text: extractText(message.content), isError: message.isError === true,
    }], 'pi_skill_file_read', lineNo, seenAt, false, state);
  }
}

function recordNativeToolCall(callId: string, toolName: string, input: Record<string, unknown>, state: AnalysisState): void {
  const skillPaths = skillReadPathsFromToolUse(toolName, input);
  if (callId && skillPaths.length > 0) {
    state.pendingSkillReads.set(callId, {
      skillPaths, turnId: state.context.turnId, entryId: state.entryId,
    });
    return;
  }
  if (state.context.activeExposures.length === 0) return;
  recordToolCall(state.context.activeExposures, callId, toolName, input,
    state.pendingToolCalls, state.context.seenToolSignatures, state.entryId);
}

function handleNativeToolResults(
  results: Array<{ toolUseId: string; text: string; isError: boolean }>,
  source: SkillUsageExposureSource, lineNo: number, seenAt: number, stripNumberedLines: boolean, state: AnalysisState,
): void {
  for (const result of results) {
    const read = state.pendingSkillReads.get(result.toolUseId);
    if (read && isPendingOnCurrentBranch(read.entryId, state)) {
      const context = contextForPending(read, state);
      addSkillReadExposures(result.toolUseId, result.text, state.pendingSkillReads, source,
        (params) => state.addExposure({ ...params, context }), lineNo, seenAt, stripNumberedLines);
      continue;
    }
    const pending = state.pendingToolCalls.get(result.toolUseId);
    if (pending && !isPendingOnCurrentBranch(pending.entryId, state)) continue;
    handleToolResult([{ type: 'tool_result', tool_use_id: result.toolUseId, content: result.text, is_error: result.isError }], state.pendingToolCalls);
  }
}

function isPendingOnCurrentBranch(entryId: string | null, state: AnalysisState): boolean {
  if (!state.piParents) return true;
  let cursor = state.entryId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    if (cursor === entryId) return true;
    seen.add(cursor);
    cursor = state.piParents.get(cursor) ?? null;
  }
  return false;
}
function recordToolCall(
  exposures: SkillUsageExposure[],
  callId: string,
  toolName: string,
  input: Record<string, unknown>,
  pendingToolCalls: Map<string, PendingToolCall>,
  seenToolSignatures: Set<string>,
  entryId: string | null,
): void {
  const signature = toolSignature(toolName, input);
  const isCommand = isCommandTool(toolName);
  const repeated = seenToolSignatures.has(signature);
  seenToolSignatures.add(signature);
  for (const exposure of exposures) {
    exposure.observation.toolCallCount += 1;
    if (repeated) exposure.observation.repeatedToolCallCount += 1;
    if (isCommand) exposure.observation.commandCallCount += 1;
  }
  if (callId) {
    pendingToolCalls.set(callId, {
      isCommand,
      exposures: [...exposures],
      entryId,
    });
  }
}

function handleToolResult(
  content: unknown,
  pendingToolCalls: Map<string, PendingToolCall>,
): void {
  for (const result of extractToolResults(content)) {
    const pending = pendingToolCalls.get(result.toolUseId);
    if (!pending) continue;
    pendingToolCalls.delete(result.toolUseId);
    const failed = isFailedToolResult(result.text, result.isError);
    if (failed) {
      for (const exposure of pending.exposures) {
        exposure.observation.toolErrorCount += 1;
        if (pending.isCommand) exposure.observation.commandFailureCount += 1;
      }
    }
  }
}

function extractToolResults(content: unknown): Array<{ toolUseId: string; text: string; isError: boolean }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ toolUseId: string; text: string; isError: boolean }> = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_result') continue;
    out.push({
      toolUseId: stringValue(block.tool_use_id),
      text: extractText(block.content),
      isError: block.is_error === true,
    });
  }
  return out;
}

function containsToolResult(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => isRecord(block) && block.type === 'tool_result');
}

function parseSkillContent(text: string): SkillContentParts {
  const rawText = text.trim();
  const tagName = parseSkillTagName(rawText);
  const tagPath = parseSkillTagPath(rawText);
  const tag = unwrapSkillTag(rawText);
  const unwrapped = stripSkillTagMetadata(tag.content)
    .replace(/^References are relative to .+\.\r?\n/, '');
  const skillPath = parseBaseDirectory(unwrapped);
  const contentWithoutBase = unwrapped.replace(/^Base directory for this skill:\s*.+(?:\r?\n){1,2}/, '');
  const documentContentForHash = stripSkillArguments(contentWithoutBase).trim();
  const exposureContentForHash = [contentWithoutBase.trim(), tag.arguments].filter(Boolean).join('\n');
  return {
    skillPath: skillPath ?? tagPath,
    skillName: parseFrontmatterName(documentContentForHash) ?? tagName,
    documentContentForHash,
    exposureContentForHash,
  };
}

function unwrapSkillTag(text: string): { content: string; arguments: string } {
  const match = /^<skill(?:\s+[^>]*)?>\s*([\s\S]*?)\s*<\/skill>([\s\S]*)$/i.exec(text);
  return match ? { content: match[1].trim(), arguments: match[2].trim() } : { content: text, arguments: '' };
}

function stripSkillTagMetadata(text: string): string {
  let out = text.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(/^<(name|path)>[\s\S]*?<\/\1>\s*/i, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

function parseBaseDirectory(text: string): string | null {
  const match = /^Base directory for this skill:\s*(.+)$/m.exec(text);
  return normalizeSkillDirectory(match?.[1]?.trim() || null);
}

function parseSkillTagName(text: string): string | null {
  const attrMatch = /<skill\s+name="([^"]+)"/i.exec(text);
  if (attrMatch?.[1]) return attrMatch[1].trim();
  const childMatch = /<skill(?:\s+[^>]*)?>[\s\S]*?<name>([\s\S]*?)<\/name>/i.exec(text);
  return childMatch?.[1]?.trim() || null;
}

function parseSkillTagPath(text: string): string | null {
  const location = /^<skill\s[^>]*\blocation="([^"]+)"/i.exec(text)?.[1];
  const match = /<skill(?:\s+[^>]*)?>[\s\S]*?<path>([\s\S]*?)<\/path>/i.exec(text);
  const rawPath = (location ?? match?.[1])?.trim();
  if (!rawPath) return null;
  return skillDirectoryFromFilePath(rawPath);
}

function parseFrontmatterName(text: string): string | null {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  for (const line of match[1].split(/\r?\n/)) {
    const nameMatch = /^name:\s*(.+)$/.exec(line);
    if (nameMatch) return nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return null;
}

function stripSkillArguments(text: string): string {
  return text.replace(/\r?\nARGUMENTS:[\s\S]*$/i, '');
}

function normalizeSkillContent(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function resolveDocumentHash(
  source: SkillUsageExposureSource,
  parts: SkillContentParts,
): { skillDocumentHash: string | null; documentHashSource: SkillDocumentHashSource } {
  if (!parts.documentContentForHash.trim()) {
    return {
      skillDocumentHash: null,
      documentHashSource: 'unavailable',
    };
  }
  // Pi 的 /skill 展开剥掉 frontmatter；不能把正文 hash 冒充完整 SKILL.md 的版本。
  if (source === 'pi_skill_injection') {
    return { skillDocumentHash: null, documentHashSource: 'unavailable' };
  }
  if (isSkillFileReadSource(source)) {
    return {
      skillDocumentHash: hashSkillContent(parts.documentContentForHash),
      documentHashSource: 'transcript_file_read',
    };
  }
  return {
    skillDocumentHash: hashSkillContent(parts.documentContentForHash),
    documentHashSource: 'transcript_skill_content',
  };
}

function isSkillFileReadSource(source: SkillUsageExposureSource): boolean {
  return source === 'claude_skill_file_read' || source === 'codex_skill_file_read' || source === 'pi_skill_file_read';
}

function looksLikeSkillContent(text: string): boolean {
  return /^(?:Base directory for this skill:|<skill(?:\s[^>]*)?>)/i.test(text.trimStart());
}

function pendingSkillForContent(
  text: string,
  pendingSkillTools: Map<string, PendingSkillTool>,
  turnId: string,
): PendingSkillTool | null {
  const currentTools = [...pendingSkillTools.values()].filter((pending) => pending.turnId === turnId);
  const skillName = parseSkillContent(text).skillName;
  if (skillName) {
    for (const pending of currentTools) {
      if (pending.skillName === skillName) return pending;
    }
  }
  const firstPending = currentTools[0];
  return firstPending ?? null;
}

function skillReadPathsFromToolUse(toolName: string, input: Record<string, unknown>): string[] {
  const filePath = stringValue(input.file_path) || stringValue(input.path);
  if (/(?:^|[._/])read(?:_file|_text_file)?$/i.test(toolName) && /SKILL\.md$/i.test(filePath)) return [filePath];
  if (!isCommandTool(toolName)) return [];
  const command = stringValue(input.command) || stringValue(input.cmd);
  if (!/SKILL\.md/i.test(command)) return [];
  const paths: string[] = [];
  // 只接受读命令的字面路径；echo/rm/任意脚本中的 SKILL.md 不是读取证据。
  const tokens = command.match(/'[^']*'|"[^"]*"|&&|[;|\r\n]|[^\s;|]+/g) ?? [];
  let reading = false;
  let atCommandStart = true;
  for (const token of tokens) {
    if (/^(?:&&|[;|\r\n])$/.test(token)) {
      reading = false;
      atCommandStart = true;
      continue;
    }
    if (atCommandStart) {
      reading = /^(?:cat|type|get-content|gc|sed|head|tail|bat|more|less)$/i.test(token);
      atCommandStart = false;
      continue;
    }
    const raw = token.replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (reading && /SKILL\.md$/i.test(raw) && !/[$`*?]/.test(raw)) paths.push(raw);
  }
  return paths;
}

function addSkillReadExposures(
  toolUseId: string,
  output: string,
  pendingSkillReads: Map<string, PendingSkillRead>,
  source: SkillUsageExposureSource,
  addExposure: (params: {
    lineNo: number;
    source: SkillUsageExposureSource;
    text: string;
    toolUseId: string | null;
    fallbackSkillName: string | null;
    seenAt: number;
    startExposureGroup?: boolean;
  }) => void,
  lineNo: number,
  seenAt: number,
  stripNumberedLines: boolean,
): void {
  const pendingSkillRead = pendingSkillReads.get(toolUseId);
  if (!pendingSkillRead) return;
  pendingSkillReads.delete(toolUseId);
  const documents = skillDocumentsFromToolOutput(output, pendingSkillRead.skillPaths, stripNumberedLines);
  for (const [index, document] of documents.entries()) {
    addExposure({
      lineNo,
      source,
      text: document.text,
      toolUseId,
      fallbackSkillName: document.skillName,
      seenAt,
      startExposureGroup: index === 0,
    });
  }
}

function skillDocumentsFromToolOutput(
  output: string,
  skillPaths: string[],
  stripNumberedLines: boolean,
): Array<{ text: string; skillName: string | null }> {
  const stdout = stripNumberedLines ? stripLineNumbers(commandStdout(output)) : commandStdout(output);
  const documents = splitSkillDocuments(stdout);
  return documents.map((content) => {
    const parts = parseSkillContent(content);
    // 批读可以部分失败或改变输出顺序；只有单文件读取或正文的明确路径才足以定位。
    const pathForDocument = parts.skillPath ?? (skillPaths.length === 1 && documents.length === 1
      ? skillDirectoryFromFilePath(skillPaths[0]) : null);
    const text = pathForDocument && !parts.skillPath
      ? `Base directory for this skill: ${pathForDocument}\n\n${content}`
      : content;
    return {
      text,
      skillName: parts.skillName,
    };
  });
}

function stripLineNumbers(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+\t/, ''))
    .join('\n');
}

function commandStdout(output: string): string {
  const normalized = output.replace(/\r\n/g, '\n');
  for (const marker of ['\nOutput:\n', '\nFinal output:\n']) {
    const index = normalized.indexOf(marker);
    if (index >= 0) return normalized.slice(index + marker.length).trim();
  }
  return normalized.trim();
}

function splitSkillDocuments(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '---') continue;
    let hasName = false;
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j += 1) {
      const line = lines[j].trim();
      if (line === '---') break;
      if (/^name:\s*.+/.test(line)) {
        hasName = true;
        break;
      }
    }
    if (hasName) {
      let start = i;
      let previousLine = i - 1;
      while (previousLine >= 0 && !lines[previousLine].trim()) previousLine -= 1;
      // 保留紧邻文档的路径封装；否则拆掉头部后无法区分批读的来源。
      if (previousLine >= 0 && /^Base directory for this skill:\s*.+$/.test(lines[previousLine])) {
        start = previousLine;
        previousLine -= 1;
        while (previousLine >= 0 && !lines[previousLine].trim()) previousLine -= 1;
      }
      if (previousLine >= 0 && /^<skill(?:\s[^>]*)?>\s*$/.test(lines[previousLine])) start = previousLine;
      starts.push(start);
    }
  }
  return starts
    .map((start, index) => {
      const end = starts[index + 1] ?? lines.length;
      return lines.slice(start, end).join('\n').trim();
    })
    .filter(Boolean);
}

function toolSignature(toolName: string, input: Record<string, unknown>): string {
  const target =
    stringValue(input.file_path) ||
    stringValue(input.path) ||
    stringValue(input.command) ||
    stringValue(input.cmd) ||
    JSON.stringify(input);
  return `${toolName}:${target}`;
}

function isCommandTool(toolName: string): boolean {
  return /(?:bash|shell|powershell|command)/i.test(toolName);
}

function isFailedToolResult(text: string, isError: boolean): boolean {
  if (isError) return true;
  const exitCode = /(?:Exit code:\s*|Process exited with code\s+)(-?\d+)/i.exec(text);
  if (exitCode) return Number(exitCode[1]) !== 0;
  return false;
}

function parseFunctionCallArguments(argumentsValue: unknown): Record<string, unknown> {
  if (isRecord(argumentsValue)) return argumentsValue;
  if (typeof argumentsValue !== 'string') return {};
  const parsed = parseJsonObject(argumentsValue);
  return parsed ?? {};
}

function createEmptyObservation(): SkillUsageObservation {
  return {
    toolCallCount: 0,
    repeatedToolCallCount: 0,
    toolErrorCount: 0,
    commandCallCount: 0,
    commandFailureCount: 0,
  };
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    if (typeof block.text === 'string') {
      parts.push(block.text);
    } else if (typeof block.content === 'string') {
      parts.push(block.content);
    } else if (Array.isArray(block.content)) {
      parts.push(extractText(block.content));
    }
  }
  return parts.filter(Boolean).join('\n\n');
}

function makeExposureId(
  agentKind: SkillUsageAgentKind,
  sessionId: string,
  nativeRecordId: string | null,
  lineNo: number,
  toolUseId: string | null,
  skillName: string,
): string {
  const recordIdentity = nativeRecordId ? ['record', nativeRecordId]
    : toolUseId ? ['tool', toolUseId] : ['line', lineNo];
  return sha256(JSON.stringify([agentKind, sessionId, recordIdentity, toolUseId, skillName])).slice(0, 32);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function basenameWithoutTrailingSlash(value: string | null): string | null {
  if (!value) return null;
  const normalized = stripTrailingPathSeparators(value);
  return path.win32.basename(normalized) || path.posix.basename(normalized) || null;
}

function normalizeSkillDirectory(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^[a-z]:[\\/]?$/i.test(trimmed) || /^[\\/]+$/.test(trimmed)) return trimmed;
  return stripTrailingPathSeparators(trimmed);
}

function skillDirectoryFromFilePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/SKILL\.md$/i.test(trimmed)) return normalizeSkillDirectory(trimmed);
  const dirname = /\\/.test(trimmed) ? path.win32.dirname(trimmed) : path.posix.dirname(trimmed);
  return normalizeSkillDirectory(dirname);
}

function timestampFromIso(raw: string): number {
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
