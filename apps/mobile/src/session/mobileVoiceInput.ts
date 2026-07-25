import { apiFetchRaw } from '@/api/client';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { i18n } from '@/i18n';
import {
  currentMobileVoiceUiLanguage,
  resolveMobileVoiceRefinementSourceLanguage,
} from '@/session/mobileVoiceLanguage';
import {
  DictationRefiner,
  extractJsonStringFieldSnapshot,
  type DictationRefinementContext,
  type TextModelClient,
} from '@cindy/voice-input-core';
import type { StoredMobileVoiceCredential } from '@/session/mobileVoiceCredentialStore';
import { redactMobileVoiceCredentialText } from '@/session/mobileVoiceCredentialRedaction';
import {
  composerVoiceStateLabel,
  type ComposerVoiceState,
} from '@cindy/maker-shared/session-operation';

export const MOBILE_MAX_VOICE_AUDIO_BYTES = 64 * 1024 * 1024;

// 语音错误文案:函数而非模块常量,调用时按当前语言取值(常量会把语言冻结在加载时)。
export function mobileVoiceEmptyTranscriptError(): string {
  return i18n.t('composer.voice.emptyTranscript');
}
export function mobileVoiceMicPermissionError(): string {
  return i18n.t('composer.voice.micPermission');
}
export function mobileVoiceRealtimeAudioUnavailableError(): string {
  return i18n.t('composer.voice.realtimeAudioUnavailable');
}

export type MobileVoiceState = ComposerVoiceState;

export interface MobileVoiceRecording {
  uri: string;
  size: number;
  mimeType?: string;
  fileName?: string;
  durationMs?: number;
}

export interface MobileVoiceUploadResult {
  ossKey: string;
  mimeType: string;
  fileName: string;
  size: number;
}

export interface MobileVoiceDraftInsertion {
  start: number;
  end: number;
  text: string;
}

interface VoicePresignResult {
  putUrl: string;
  key: string;
  expiresAt: string;
}

interface UploadDeps {
  apiFetch?: typeof apiFetchRaw;
  fetch?: typeof fetch;
}

interface CloudVoiceDeps {
  fetch?: typeof fetch;
}

const MOBILE_VOICE_INPUT_HISTORY_HEADER = '语音输入历史（旧到新，仅作术语、别名和用词风格参考）：';
const MAX_MOBILE_VOICE_HISTORY_ENTRIES_FOR_REFINEMENT = 100;
const MAX_MOBILE_VOICE_HISTORY_ITEM_CHARS = 360;
const MAX_REFINER_RESPONSE_CHARS = 64_000;
const MAX_ERROR_DETAIL_CHARS = 1_000;

export function appendVoiceTranscriptDraft(current: string, transcript: string): string {
  return appendVoiceTranscriptDraftWithRange(current, transcript).draft;
}

export function appendVoiceTranscriptDraftWithRange(
  current: string,
  transcript: string,
): { draft: string; insertion: MobileVoiceDraftInsertion | null } {
  const text = transcript.trim();
  if (!text) return { draft: current, insertion: null };
  const base = current.trimEnd();
  if (!base) {
    return {
      draft: text,
      insertion: { start: 0, end: text.length, text },
    };
  }
  if (/[\s\n]$/.test(current)) {
    const start = current.length;
    return {
      draft: `${current}${text}`,
      insertion: { start, end: start + text.length, text },
    };
  }
  const start = base.length + 1;
  return {
    draft: `${base}\n${text}`,
    insertion: { start, end: start + text.length, text },
  };
}

export function replaceVoiceTranscriptDraftRange(
  current: string,
  insertion: MobileVoiceDraftInsertion | null,
  transcript: string,
): string {
  const text = transcript.trim();
  if (!text) return current;
  if (!insertion) return appendVoiceTranscriptDraft(current, text);
  if (current.slice(insertion.start, insertion.end) !== insertion.text) {
    return appendVoiceTranscriptDraft(current, text);
  }
  return `${current.slice(0, insertion.start)}${text}${current.slice(insertion.end)}`;
}

export function mobileVoiceStateLabel(state: MobileVoiceState): string {
  return composerVoiceStateLabel(state);
}

export function canCancelMobileVoiceRecording(state: MobileVoiceState): boolean {
  return state === 'listening';
}

export function isMobileVoiceMicPermissionError(message: string | null | undefined): boolean {
  return message === mobileVoiceMicPermissionError();
}

export function normalizeMobileVoiceTranscriptResult(value: unknown): { text: string; provider?: string; model?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { text: '' };
  const record = value as Record<string, unknown>;
  return {
    text: typeof record.text === 'string' ? record.text.trim() : '',
    provider: typeof record.provider === 'string' ? record.provider : undefined,
    model: typeof record.model === 'string' ? record.model : undefined,
  };
}

export function resolveVoiceRecordingMeta(input: {
  uri: string;
  mimeType?: string | null;
  fileName?: string | null;
}): { mimeType: string; fileName: string; ext: string } {
  const uriExt = extensionFromName(input.fileName || input.uri);
  const mimeType = input.mimeType?.trim()
    || mimeTypeForExtension(uriExt)
    || 'audio/mp4';
  const ext = uriExt || extensionForMimeType(mimeType) || 'm4a';
  return {
    mimeType,
    fileName: input.fileName?.trim() || `mobile-voice.${ext}`,
    ext,
  };
}

export async function presignMobileVoiceUpload(
  recording: Pick<MobileVoiceRecording, 'size' | 'mimeType' | 'fileName' | 'uri'>,
  options: { token: string | null; deps?: UploadDeps },
): Promise<VoicePresignResult> {
  if (!Number.isFinite(recording.size) || recording.size <= 0) {
    throw new Error(i18n.t('composer.voice.recordingEmpty'));
  }
  if (recording.size > MOBILE_MAX_VOICE_AUDIO_BYTES) {
    throw new Error(i18n.t('composer.voice.recordingTooLarge', { size: Math.round(MOBILE_MAX_VOICE_AUDIO_BYTES / 1024 / 1024) }));
  }
  const apiFetch = options.deps?.apiFetch ?? apiFetchRaw;
  const meta = resolveVoiceRecordingMeta(recording);
  const result = await apiFetch<VoicePresignResult>('/api/device-link/media/presign-put', {
    baseUrl: DEVICE_LINK_API_BASE_URL,
    method: 'POST',
    token: options.token,
    body: {
      size: recording.size,
      contentType: meta.mimeType,
      ext: meta.ext,
    },
  });
  if (!result || typeof result.putUrl !== 'string' || typeof result.key !== 'string') {
    throw new Error(i18n.t('composer.voice.invalidUploadUrl'));
  }
  return result;
}

export async function putMobileVoiceUpload(
  putUrl: string,
  body: BodyInit,
  mimeType: string,
  deps: UploadDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetch ?? fetch;
  const response = await fetchImpl(putUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
      'x-oss-object-acl': 'private',
    },
    body,
  });
  if (!response.ok) {
    throw new Error(i18n.t('composer.voice.uploadFailed', { status: response.status, statusText: response.statusText }));
  }
}

export async function uploadMobileVoiceRecording(
  recording: MobileVoiceRecording,
  body: BodyInit,
  options: { token: string | null; deps?: UploadDeps },
): Promise<MobileVoiceUploadResult> {
  const meta = resolveVoiceRecordingMeta(recording);
  const presigned = await presignMobileVoiceUpload(recording, options);
  await putMobileVoiceUpload(presigned.putUrl, body, meta.mimeType, options.deps);
  return {
    ossKey: presigned.key,
    mimeType: meta.mimeType,
    fileName: meta.fileName,
    size: recording.size,
  };
}

export function buildMobileVoiceRefinementContext(
  credential: StoredMobileVoiceCredential,
  options: {
    uiLanguage?: string;
    sourceLanguage?: string;
    refinementContext?: DictationRefinementContext;
    localVoiceInputHistory?: readonly string[];
  } = {},
): DictationRefinementContext {
  const settings = credential.settings;
  const dictionaryEntries = settings?.dictionaryEntries ?? [];
  const history = mergeMobileVoiceHistories(settings?.voiceInputHistory, options.localVoiceInputHistory);
  const uiLanguage = options.refinementContext?.uiLanguage?.trim()
    || options.uiLanguage?.trim()
    || currentMobileVoiceUiLanguage();
  const sourceLanguage = resolveMobileVoiceRefinementSourceLanguage(
    options.refinementContext?.sourceLanguage
      ?? options.sourceLanguage
      ?? settings?.language,
    uiLanguage,
  );
  const base: DictationRefinementContext = {
    uiLanguage,
    sourceLanguage,
    userRefinementInstructions: settings?.refinementInstructions?.trim() || undefined,
    userDictionary: formatMobileVoiceDictionary(dictionaryEntries) || undefined,
    dictionaryAliasHints: dictionaryEntries.map((entry) => ({
      term: entry.text,
      frequency: entry.frequency,
      aliases: entry.aliases ?? [],
    })),
    voiceInputHistory: formatMobileVoiceHistory(history) || undefined,
  };
  return {
    ...base,
    ...options.refinementContext,
    uiLanguage,
    sourceLanguage,
  };
}

/**
 * 托管润色客户端:请求目标(voice-server refine 端点 + 一次性授权)由
 * requestTargetProvider 现取,客户端不落任何推理 key,也不再支持用本机保存的
 * key 直拨上游(BYOK 已删除)。
 */
export class MobileLiteLlmTextModelClient implements TextModelClient {
  private readonly deps?: CloudVoiceDeps;
  private readonly requestTargetProvider: (options?: { refreshAccessToken?: boolean }) => Promise<{ url: string; authorization: string }>;

  constructor(options: {
    requestTargetProvider: (options?: { refreshAccessToken?: boolean }) => Promise<{ url: string; authorization: string }>;
    deps?: CloudVoiceDeps;
  }) {
    this.deps = options.deps;
    this.requestTargetProvider = options.requestTargetProvider;
  }

  async requestJson<T>(input: {
    model: string;
    system: string;
    user: unknown;
    schemaName: string;
    promptCacheScope?: string;
    onTextSnapshot?: (text: string) => void;
  }): Promise<T> {
    const fetchImpl = this.deps?.fetch ?? fetch;
    // prompt_cache_key 让上游把 warmup 与真实润色路由到同一缓存分片;派生逻辑
    // 必须与 makeMobileRefinerPromptCacheKey 完全一致(warmup 调用方用它预热)。
    const promptCacheKey = makeMobileRefinerPromptCacheKey({
      model: input.model,
      schemaName: input.schemaName,
      promptVersion: extractPromptVersion(input.user),
      system: input.system,
      scope: input.promptCacheScope,
    });
    const request = async (refreshAccessToken = false) => {
      const target = await this.requestTargetProvider({ refreshAccessToken });
      return fetchImpl(target.url, {
      method: 'POST',
      headers: {
        Authorization: target.authorization,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: input.model,
        response_format: { type: 'json_object' },
        prompt_cache_key: promptCacheKey,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: input.system },
          {
            role: 'user',
            content: JSON.stringify({
              schemaName: input.schemaName,
              input: input.user,
            }),
          },
        ],
      }),
      });
    };
    let response = await request();
    if (!response.ok && response.status === 401) {
      response = await request(true);
    }
    if (!response.ok) {
      throw new Error(await cloudVoiceHttpErrorMessage(i18n.t('composer.voice.refineFailed'), response, ''));
    }
    if (hasReadableStreamBody(response.body)) {
      const content = await readStreamingChatCompletion(response.body, input.onTextSnapshot);
      return parseJsonObject(content) as T;
    }
    const buffered = await readBufferedResponseText(response);
    if (buffered.trim()) {
      if (buffered.length > MAX_REFINER_RESPONSE_CHARS) {
        throw new Error(i18n.t('composer.voice.refineResponseTooLarge', { max: MAX_REFINER_RESPONSE_CHARS }));
      }
      const streamedContent = readBufferedChatCompletion(buffered, input.onTextSnapshot);
      if (streamedContent) return parseJsonObject(streamedContent) as T;
      const payload = parseJsonObject(buffered);
      const content = extractChatCompletionContent(payload);
      return parseJsonObject(content) as T;
    }
    const payload = await response.json().catch(() => null);
    const content = extractChatCompletionContent(payload);
    return parseJsonObject(content) as T;
  }
}

/**
 * 派生托管润色的 prompt_cache_key。warmup(refine-warmup 端点)与真实润色请求
 * 必须用同一把 key,否则预热的是错误的缓存分片(与 desktop
 * makeRefinerPromptCacheKey 同构,哈希实现按移动端无 node crypto 改为纯 JS)。
 */
export function makeMobileRefinerPromptCacheKey(input: {
  model: string;
  schemaName: string;
  promptVersion?: string;
  system: string;
  scope?: string;
}): string {
  const scopeHash = shortStableHash(input.scope?.trim() || 'default');
  return `xdt:${input.schemaName}:${shortStableHash([
    input.model,
    input.promptVersion ?? '',
    shortStableHash(input.system),
    scopeHash,
  ].join('\n'))}`;
}

function extractPromptVersion(user: unknown): string | undefined {
  if (!isRecord(user)) return undefined;
  return typeof user.promptVersion === 'string' ? user.promptVersion : undefined;
}

/** 纯 JS 的稳定短哈希(两个不同种子的 FNV-1a 拼接,64bit 强度,非加密用途)。 */
function shortStableHash(text: string): string {
  return `${fnv1aHex(text, 0x811c9dc5)}${fnv1aHex(text, 0x01234567)}`;
}

function fnv1aHex(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

async function readStreamingChatCompletion(
  body: ReadableStream<Uint8Array>,
  onTextSnapshot?: (text: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let rawChars = 0;
  let lastSnapshot = '';
  let streamError: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      rawChars += chunk.length;
      if (rawChars > MAX_REFINER_RESPONSE_CHARS) {
        throw new Error(i18n.t('composer.voice.refineResponseTooLarge', { max: MAX_REFINER_RESPONSE_CHARS }));
      }
      buffer += normalizeSseLineEndings(chunk);
      let splitAt = buffer.indexOf('\n\n');
      while (splitAt >= 0) {
        const block = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        const event = parseSseBlock(block);
        if (event) {
          if (isRecord(event.data) && isRecord(event.data.error)) {
            streamError = typeof event.data.error.message === 'string'
              ? event.data.error.message
              : i18n.t('composer.voice.refineStreamFailed');
          }
          const delta = extractDeltaContent(event.data);
          if (delta) {
            content += delta;
            const snapshot = extractJsonStringFieldSnapshot(content, 'text');
            if (snapshot && snapshot !== lastSnapshot) {
              lastSnapshot = snapshot;
              onTextSnapshot?.(snapshot);
            }
          }
        }
        splitAt = buffer.indexOf('\n\n');
      }
    }

    if (buffer.trim()) {
      const event = parseSseBlock(buffer);
      const delta = event ? extractDeltaContent(event.data) : '';
      if (delta) {
        content += delta;
        const snapshot = extractJsonStringFieldSnapshot(content, 'text');
        if (snapshot && snapshot !== lastSnapshot) onTextSnapshot?.(snapshot);
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (streamError) throw new Error(streamError);
  return content.trim();
}

async function readBufferedResponseText(response: Response): Promise<string> {
  const textReader = (response as { text?: unknown }).text;
  if (typeof textReader !== 'function') return '';
  try {
    return await textReader.call(response);
  } catch {
    return '';
  }
}

async function cloudVoiceHttpErrorMessage(
  prefix: string,
  response: Response,
  credential: { proxyApiKey?: unknown } | string,
): Promise<string> {
  const status = `HTTP ${response.status} ${response.statusText}`.trim();
  const raw = await readBufferedResponseText(response);
  const detail = extractCloudVoiceErrorDetail(raw);
  const message = detail ? `${prefix}: ${status} · ${detail}` : `${prefix}: ${status}`;
  return redactMobileVoiceCredentialText(message, credential);
}

function extractCloudVoiceErrorDetail(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as unknown;
    return truncateErrorDetail(readCloudVoiceErrorMessage(parsed) ?? text);
  } catch {
    return truncateErrorDetail(text);
  }
}

function readCloudVoiceErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const detail = value.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  const message = value.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  const error = value.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (isRecord(error)) {
    const errorMessage = error.message;
    if (typeof errorMessage === 'string' && errorMessage.trim()) return errorMessage.trim();
    const errorDetail = error.detail;
    if (typeof errorDetail === 'string' && errorDetail.trim()) return errorDetail.trim();
  }
  return null;
}

function truncateErrorDetail(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_ERROR_DETAIL_CHARS) return normalized;
  return `${normalized.slice(0, MAX_ERROR_DETAIL_CHARS)}...`;
}

function readBufferedChatCompletion(raw: string, onTextSnapshot?: (text: string) => void): string {
  const state = createChatCompletionStreamState();
  const normalized = normalizeSseLineEndings(raw);
  for (const block of normalized.split(/\n\n+/)) {
    if (!block.trim()) continue;
    const event = parseSseBlock(block);
    if (event) applyChatCompletionEvent(event, state, onTextSnapshot);
  }
  if (state.streamError) throw new Error(state.streamError);
  return state.content.trim();
}

type ParsedSseBlock = { data: unknown };

type ChatCompletionStreamState = {
  content: string;
  lastSnapshot: string;
  streamError: string | null;
};

function createChatCompletionStreamState(): ChatCompletionStreamState {
  return {
    content: '',
    lastSnapshot: '',
    streamError: null,
  };
}

function applyChatCompletionEvent(
  event: ParsedSseBlock,
  state: ChatCompletionStreamState,
  onTextSnapshot?: (text: string) => void,
): void {
  if (isRecord(event.data) && isRecord(event.data.error)) {
    state.streamError = typeof event.data.error.message === 'string'
      ? event.data.error.message
      : i18n.t('composer.voice.refineStreamFailed');
  }
  const delta = extractDeltaContent(event.data);
  if (!delta) return;
  state.content += delta;
  const snapshot = extractJsonStringFieldSnapshot(state.content, 'text');
  if (snapshot && snapshot !== state.lastSnapshot) {
    state.lastSnapshot = snapshot;
    onTextSnapshot?.(snapshot);
  }
}

function parseSseBlock(block: string): ParsedSseBlock | null {
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join('\n');
  if (dataStr === '[DONE]') return { data: {} };
  try {
    return { data: JSON.parse(dataStr) };
  } catch {
    return null;
  }
}

function normalizeSseLineEndings(chunk: string): string {
  return chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function extractDeltaContent(chunk: unknown): string {
  if (!isRecord(chunk) || !Array.isArray(chunk.choices)) return '';
  return chunk.choices
    .map((choice) => {
      if (!isRecord(choice)) return '';
      const delta = isRecord(choice.delta) ? choice.delta : null;
      const content = delta?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((part) => {
            if (typeof part === 'string') return part;
            if (isRecord(part) && typeof part.text === 'string') return part.text;
            return '';
          })
          .join('');
      }
      return '';
    })
    .join('');
}

function extractChatCompletionContent(value: unknown): string {
  if (!value || typeof value !== 'object') throw new Error(i18n.t('composer.voice.refineNoContent'));
  const choice = (value as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  if (content && typeof content === 'object') return JSON.stringify(content);
  throw new Error(i18n.t('composer.voice.refineNoContent'));
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(i18n.t('composer.voice.refineNoContent'));
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(i18n.t('composer.voice.refineInvalidJson', { snippet: trimmed.slice(0, 80) }));
    return JSON.parse(match[0]);
  }
}

function hasReadableStreamBody(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value && typeof (value as { getReader?: unknown }).getReader === 'function';
}

function formatMobileVoiceDictionary(
  entries: NonNullable<StoredMobileVoiceCredential['settings']>['dictionaryEntries'] | undefined,
): string {
  return (entries ?? [])
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .map((text) => `- ${text}`)
    .join('\n');
}

function formatMobileVoiceHistory(history: readonly string[]): string {
  const entries = normalizeMobileVoiceHistoryNewestFirst(history).reverse();
  if (entries.length === 0) return '';
  return [
    MOBILE_VOICE_INPUT_HISTORY_HEADER,
    ...entries.map((entry) => `- ${entry}`),
  ].join('\n');
}

function mergeMobileVoiceHistories(
  syncedDesktopHistory: readonly string[] | undefined,
  localMobileHistory: readonly string[] | undefined,
): string[] {
  return normalizeMobileVoiceHistoryNewestFirst([
    ...(localMobileHistory ?? []),
    ...(syncedDesktopHistory ?? []),
  ]);
}

function normalizeMobileVoiceHistoryNewestFirst(history: readonly string[]): string[] {
  const entries: string[] = [];
  for (const item of history) {
    const text = item
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_MOBILE_VOICE_HISTORY_ITEM_CHARS)
      .trim();
    if (!text || entries.includes(text)) continue;
    entries.push(text);
    if (entries.length >= MAX_MOBILE_VOICE_HISTORY_ENTRIES_FOR_REFINEMENT) break;
  }
  return entries;
}

function extensionFromName(name: string): string {
  const match = /\.([a-zA-Z0-9]{1,12})(?:[?#].*)?$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}

function extensionForMimeType(mimeType: string): string | null {
  if (mimeType === 'audio/wav' || mimeType === 'audio/wave' || mimeType === 'audio/x-wav') return 'wav';
  if (mimeType === 'audio/mp4' || mimeType === 'audio/m4a' || mimeType === 'audio/x-m4a') return 'm4a';
  if (mimeType === 'audio/mpeg') return 'mp3';
  if (mimeType === 'audio/webm') return 'webm';
  if (mimeType === 'audio/ogg') return 'ogg';
  return null;
}

function mimeTypeForExtension(ext: string): string | null {
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'webm') return 'audio/webm';
  if (ext === 'ogg') return 'audio/ogg';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
