import { createHash } from 'node:crypto';
import path from 'node:path';
import { stripTrailingPathSeparators } from '../../shared/pathText';

export type SkillUsageAgentKind = 'claude-code' | 'codex';

export type SkillUsageExposureSource =
  | 'claude_skill_tool'
  | 'claude_invoked_skill_attachment'
  | 'claude_skill_content_injection'
  | 'claude_skill_file_read'
  | 'codex_skill_injection'
  | 'codex_skill_file_read';

export type SkillDocumentHashSource = 'transcript_skill_content' | 'transcript_file_read' | 'unavailable';

export interface SkillUsageTranscriptInput {
  agentKind: SkillUsageAgentKind;
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
}

interface PendingToolCall {
  toolName: string;
  signature: string;
  isCommand: boolean;
  exposures: SkillUsageExposure[];
}

interface PendingSkillRead {
  skillPaths: string[];
}

interface SkillContentParts {
  skillPath: string | null;
  skillName: string | null;
  documentContentForHash: string;
  exposureContentForHash: string;
}

export function analyzeSkillUsageTranscript(input: SkillUsageTranscriptInput): SkillUsageAnalysisResult {
  const exposures: SkillUsageExposure[] = [];
  const pendingSkillTools = new Map<string, PendingSkillTool>();
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const pendingSkillReads = new Map<string, PendingSkillRead>();
  let activeExposures: SkillUsageExposure[] = [];
  let activeRepeatedToolSignatures = new Map<string, Map<string, number>>();

  const addExposure = (params: {
    lineNo: number;
    source: SkillUsageExposureSource;
    text: string;
    toolUseId: string | null;
    fallbackSkillName: string | null;
    seenAt: number;
    startExposureGroup?: boolean;
  }) => {
    const parts = parseSkillContent(params.text);
    const skillName = params.fallbackSkillName ?? parts.skillName ?? basenameWithoutTrailingSlash(parts.skillPath) ?? 'unknown';
    if (!parts.exposureContentForHash.trim()) return;
    if (params.startExposureGroup !== false) {
      activeExposures = [];
      activeRepeatedToolSignatures = new Map();
    }
    const documentHash = resolveDocumentHash(params.source, parts);
    const exposure: SkillUsageExposure = {
      id: makeExposureId(input.rawFilePath, input.sessionId, params.lineNo, params.toolUseId, skillName),
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
    activeExposures.push(exposure);
    activeRepeatedToolSignatures.set(exposure.id, new Map());
  };

  for (let i = 0; i < input.lines.length; i += 1) {
    const lineNo = i + 1;
    const obj = parseJsonObject(input.lines[i]);
    if (!obj) continue;
    const timestamp = timestampFromIso(stringValue(obj.timestamp));
    if (isUserTurnBoundary(obj, input.agentKind)) {
      activeExposures = [];
      activeRepeatedToolSignatures = new Map();
    }
    if (input.agentKind === 'claude-code') {
      handleClaudeRecord(obj, lineNo, timestamp, {
        addExposure,
        activeExposures: () => activeExposures,
        pendingSkillTools,
        pendingToolCalls,
        pendingSkillReads,
        repeatedToolSignaturesByExposureId: () => activeRepeatedToolSignatures,
      });
    } else {
      handleCodexRecord(obj, lineNo, timestamp, {
        addExposure,
        activeExposures: () => activeExposures,
        pendingToolCalls,
        pendingSkillReads,
        repeatedToolSignaturesByExposureId: () => activeRepeatedToolSignatures,
      });
    }
  }

  return { exposures };
}

export function hashSkillContent(content: string): string {
  return sha256(normalizeSkillContent(content));
}

function handleClaudeRecord(
  obj: Record<string, unknown>,
  lineNo: number,
  seenAt: number,
  state: {
    addExposure: (params: {
      lineNo: number;
      source: SkillUsageExposureSource;
      text: string;
      toolUseId: string | null;
      fallbackSkillName: string | null;
      seenAt: number;
      startExposureGroup?: boolean;
    }) => void;
    activeExposures: () => SkillUsageExposure[];
    pendingSkillTools: Map<string, PendingSkillTool>;
    pendingToolCalls: Map<string, PendingToolCall>;
    pendingSkillReads: Map<string, PendingSkillRead>;
    repeatedToolSignaturesByExposureId: () => Map<string, Map<string, number>>;
  },
): void {
  if (isRecord(obj.attachment) && obj.attachment.type === 'invoked_skills') {
    const skills = Array.isArray(obj.attachment.skills) ? obj.attachment.skills : [];
    let isFirstExposureInGroup = true;
    for (const skill of skills) {
      if (!isRecord(skill)) continue;
      const content = stringValue(skill.content);
      if (!content) continue;
      state.addExposure({
        lineNo,
        source: 'claude_invoked_skill_attachment',
        text: content,
        toolUseId: null,
        fallbackSkillName: stringValue(skill.name) || null,
        seenAt,
        startExposureGroup: isFirstExposureInGroup,
      });
      isFirstExposureInGroup = false;
    }
    return;
  }

  const type = stringValue(obj.type);
  if ((type !== 'assistant' && type !== 'user') || !isRecord(obj.message)) return;

  const message = obj.message;
  if (type === 'assistant') {
    handleClaudeAssistantMessage(message, state);
    return;
  }

  const sourceToolUseId = stringValue(obj.sourceToolUseID);
  const pendingSkill = sourceToolUseId ? state.pendingSkillTools.get(sourceToolUseId) : null;
  const text = extractText(message.content);
  if (looksLikeSkillContent(text)) {
    const linkedPendingSkill = pendingSkill ?? pendingSkillForContent(text, state.pendingSkillTools);
    const source = linkedPendingSkill ? 'claude_skill_tool' : 'claude_skill_content_injection';
    state.addExposure({
      lineNo,
      source,
      text,
      toolUseId: linkedPendingSkill?.toolUseId ?? null,
      fallbackSkillName: linkedPendingSkill?.skillName ?? null,
      seenAt,
    });
    if (linkedPendingSkill) state.pendingSkillTools.delete(linkedPendingSkill.toolUseId);
    return;
  }

  addSkillReadExposuresFromToolResults(
    message.content,
    state.pendingSkillReads,
    'claude_skill_file_read',
    state.addExposure,
    lineNo,
    seenAt,
    true,
  );
  handleToolResult(message.content, state.pendingToolCalls);
}

function isUserTurnBoundary(obj: Record<string, unknown>, agentKind: SkillUsageAgentKind): boolean {
  if (agentKind === 'codex') {
    return obj.type === 'event_msg' && isRecord(obj.payload) && obj.payload.type === 'user_message';
  }
  if (obj.type !== 'user' || !isRecord(obj.message)) return false;
  const content = obj.message.content;
  if (containsToolResult(content)) return false;
  return !looksLikeSkillContent(extractText(content));
}

function handleClaudeAssistantMessage(
  message: Record<string, unknown>,
  state: {
    activeExposures: () => SkillUsageExposure[];
    pendingSkillTools: Map<string, PendingSkillTool>;
    pendingToolCalls: Map<string, PendingToolCall>;
    pendingSkillReads: Map<string, PendingSkillRead>;
    repeatedToolSignaturesByExposureId: () => Map<string, Map<string, number>>;
  },
): void {
  const activeExposures = state.activeExposures();

  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_use') continue;
    const toolUseId = stringValue(block.id);
    const toolName = stringValue(block.name);
    const input = isRecord(block.input) ? block.input : {};
    if (toolName === 'Skill') {
      const skillName = stringValue(input.skill);
      if (toolUseId && skillName) {
        state.pendingSkillTools.set(toolUseId, { toolUseId, skillName });
      }
      continue;
    }
    const skillReadPaths = skillReadPathsFromToolUse(toolName, input);
    if (toolUseId && skillReadPaths.length > 0) {
      state.pendingSkillReads.set(toolUseId, { skillPaths: skillReadPaths });
      continue;
    }
    if (activeExposures.length === 0) continue;
    recordToolCall(
      activeExposures,
      toolUseId,
      toolName,
      input,
      state.pendingToolCalls,
      state.repeatedToolSignaturesByExposureId(),
    );
  }
}

function handleCodexRecord(
  obj: Record<string, unknown>,
  lineNo: number,
  seenAt: number,
  state: {
    addExposure: (params: {
      lineNo: number;
      source: SkillUsageExposureSource;
      text: string;
      toolUseId: string | null;
      fallbackSkillName: string | null;
      seenAt: number;
      startExposureGroup?: boolean;
    }) => void;
    activeExposures: () => SkillUsageExposure[];
    pendingToolCalls: Map<string, PendingToolCall>;
    pendingSkillReads: Map<string, PendingSkillRead>;
    repeatedToolSignaturesByExposureId: () => Map<string, Map<string, number>>;
  },
): void {
  if (!isRecord(obj.payload)) return;
  const payload = obj.payload;
  if (obj.type === 'event_msg' && payload.type === 'token_count') {
    return;
  }
  if (obj.type !== 'response_item') return;
  const payloadType = stringValue(payload.type);
  if (payloadType === 'message' && payload.role === 'user') {
    const text = extractText(payload.content);
    if (looksLikeSkillContent(text)) {
      state.addExposure({
        lineNo,
        source: 'codex_skill_injection',
        text,
        toolUseId: null,
        fallbackSkillName: parseSkillTagName(text),
        seenAt,
      });
    }
    return;
  }
  if (payloadType === 'function_call') {
    const callId = stringValue(payload.call_id);
    const toolName = stringValue(payload.name);
    const parsedArguments = parseFunctionCallArguments(payload.arguments);
    const skillReadPaths = skillReadPathsFromToolUse(toolName, parsedArguments);
    if (callId && skillReadPaths.length > 0) {
      state.pendingSkillReads.set(callId, { skillPaths: skillReadPaths });
      return;
    }
    const activeExposures = state.activeExposures();
    if (activeExposures.length === 0) return;
    recordToolCall(
      activeExposures,
      callId,
      toolName,
      parsedArguments,
      state.pendingToolCalls,
      state.repeatedToolSignaturesByExposureId(),
    );
    return;
  }
  if (payloadType === 'function_call_output') {
    const callId = stringValue(payload.call_id);
    const pendingSkillRead = state.pendingSkillReads.get(callId);
    if (pendingSkillRead) {
      addSkillReadExposures(
        callId,
        stringValue(payload.output),
        state.pendingSkillReads,
        'codex_skill_file_read',
        state.addExposure,
        lineNo,
        seenAt,
        false,
      );
      return;
    }
    handleToolResult(
      [{ type: 'tool_result', tool_use_id: callId, content: stringValue(payload.output) }],
      state.pendingToolCalls,
    );
  }
}

function recordToolCall(
  exposures: SkillUsageExposure[],
  callId: string,
  toolName: string,
  input: Record<string, unknown>,
  pendingToolCalls: Map<string, PendingToolCall>,
  repeatedToolSignaturesByExposureId: Map<string, Map<string, number>>,
): void {
  const signature = toolSignature(toolName, input);
  const isCommand = isCommandTool(toolName);
  for (const exposure of exposures) {
    exposure.observation.toolCallCount += 1;
    const repeatedToolSignatures = repeatedToolSignaturesByExposureId.get(exposure.id) ?? new Map<string, number>();
    const seenCount = repeatedToolSignatures.get(signature) ?? 0;
    if (seenCount > 0) exposure.observation.repeatedToolCallCount += 1;
    repeatedToolSignatures.set(signature, seenCount + 1);
    repeatedToolSignaturesByExposureId.set(exposure.id, repeatedToolSignatures);
    if (isCommand) exposure.observation.commandCallCount += 1;
  }
  if (callId) {
    pendingToolCalls.set(callId, {
      toolName,
      signature,
      isCommand,
      exposures: [...exposures],
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
  const unwrapped = stripSkillTagMetadata(unwrapSkillTag(rawText));
  const skillPath = parseBaseDirectory(unwrapped);
  const contentWithoutBase = unwrapped.replace(/^Base directory for this skill:\s*.+(?:\r?\n){1,2}/, '');
  const documentContentForHash = stripSkillArguments(contentWithoutBase).trim();
  const exposureContentForHash = contentWithoutBase.trim();
  return {
    skillPath: skillPath ?? tagPath,
    skillName: parseFrontmatterName(documentContentForHash) ?? tagName,
    documentContentForHash,
    exposureContentForHash,
  };
}

function unwrapSkillTag(text: string): string {
  return text
    .replace(/^<skill(?:\s+name="[^"]+")?>\s*/i, '')
    .replace(/\s*<\/skill>$/i, '')
    .trim();
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
  const match = /<skill(?:\s+[^>]*)?>[\s\S]*?<path>([\s\S]*?)<\/path>/i.exec(text);
  const rawPath = match?.[1]?.trim();
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
  return source === 'claude_skill_file_read' || source === 'codex_skill_file_read';
}

function looksLikeSkillContent(text: string): boolean {
  return /Base directory for this skill:/i.test(text) || /<skill(?:\s+name="[^"]+")?>/i.test(text);
}

function pendingSkillForContent(
  text: string,
  pendingSkillTools: Map<string, PendingSkillTool>,
): PendingSkillTool | null {
  const skillName = parseSkillContent(text).skillName;
  if (skillName) {
    for (const pending of pendingSkillTools.values()) {
      if (pending.skillName === skillName) return pending;
    }
  }
  const firstPending = pendingSkillTools.values().next().value;
  return firstPending ?? null;
}

function skillReadPathsFromToolUse(toolName: string, input: Record<string, unknown>): string[] {
  const filePath = stringValue(input.file_path) || stringValue(input.path);
  if (/SKILL\.md$/i.test(filePath)) return [filePath];
  if (!isCommandTool(toolName)) return [];
  const command = stringValue(input.command);
  if (!/SKILL\.md/i.test(command)) return [];
  const paths: string[] = [];
  const re = /'([^']*SKILL\.md)'|"([^"]*SKILL\.md)"|([^\s;"']*SKILL\.md)/gi;
  for (const match of command.matchAll(re)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    if (raw) paths.push(raw.trim());
  }
  return paths;
}

function addSkillReadExposuresFromToolResults(
  content: unknown,
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
  for (const result of extractToolResults(content)) {
    addSkillReadExposures(
      result.toolUseId,
      result.text,
      pendingSkillReads,
      source,
      addExposure,
      lineNo,
      seenAt,
      stripNumberedLines,
    );
  }
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
  return documents.map((content, index) => {
    const pathForDocument = skillPaths[index] ?? null;
    const text = pathForDocument
      ? `Base directory for this skill: ${skillDirectoryFromFilePath(pathForDocument)}\n\n${content}`
      : content;
    return {
      text,
      skillName: parseFrontmatterName(content),
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
  const marker = '\nOutput:\n';
  const index = normalized.indexOf(marker);
  return (index >= 0 ? normalized.slice(index + marker.length) : normalized).trim();
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
    if (hasName) starts.push(i);
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
    JSON.stringify(input);
  return `${toolName}:${target}`;
}

function isCommandTool(toolName: string): boolean {
  return /(?:bash|shell|powershell|command)/i.test(toolName);
}

function isFailedToolResult(text: string, isError: boolean): boolean {
  if (isError) return true;
  const exitCode = /Exit code:\s*(-?\d+)/i.exec(text);
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
  rawFilePath: string,
  sessionId: string,
  lineNo: number,
  toolUseId: string | null,
  skillName: string,
): string {
  return sha256(`${rawFilePath}:${sessionId}:${lineNo}:${toolUseId ?? ''}:${skillName}`).slice(0, 32);
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
