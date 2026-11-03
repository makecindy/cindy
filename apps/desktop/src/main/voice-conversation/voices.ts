import {
  normalizeSpeechVoiceId,
  type SpeechVoiceCatalog,
  type SpeechVoice,
} from '../../shared/voiceConversation.js';
import { gatewayReferenceSpeechVoices, referenceSpeechVoices } from '../../shared/speechVoices.js';
import { alibabaSystemVoices } from '../../shared/alibabaSpeechVoices.js';
import { loadDashscopeVoices } from './dashscopeVoices.js';
import type { SpeechConnection } from './speech.js';
import { openRouterSpeechBaseUrl } from './openrouter.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};

async function readJson(response: Response, signal: AbortSignal): Promise<RecordValue> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('voice_catalog_unavailable');
  }
  const reader = response.body.getReader();
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('voice_catalog_too_large');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return record(JSON.parse(text + decoder.decode()));
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
  }
}

/** Account-owned lists stay in memory, never in the public model Registry or user settings.
 * No universal OpenAI /voices endpoint exists. A catalog entry is not execution proof;
 * in particular ElevenLabs high_quality_base_model_ids is not an availability allowlist.
 */
export async function loadSpeechVoices(
  connection: SpeechConnection,
  modelId: string,
  fetcher: typeof fetch,
  assertCurrent: () => void,
  providerId?: string,
): Promise<SpeechVoiceCatalog> {
  assertCurrent();
  if (providerId === 'xd' && connection.protocol === 'openai') {
    const voices = gatewayReferenceSpeechVoices(modelId);
    if (voices.length)
      return { source: 'reference', voices: voices.map((voice) => ({ ...voice })) };
  }
  const openRouterBase = providerId !== 'xd' && connection.protocol === 'openai'
    ? openRouterSpeechBaseUrl(connection.baseUrl) : undefined;
  if ((connection.protocol === 'openai' && !openRouterBase) || connection.protocol === 'qwen-tts') {
    const voices =
      connection.protocol === 'qwen-tts'
        ? alibabaSystemVoices(modelId, connection.protocol, connection.baseUrl)
        : referenceSpeechVoices(modelId, connection.protocol).map((id) => ({
            id,
            name: id,
          }));
    return { source: voices.length ? 'reference' : 'manual', voices };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const voices = new Map<string, SpeechVoice>();
  const append = (raw: unknown, nameKey: string): void => {
    const entry = record(raw);
    const id = normalizeSpeechVoiceId(entry.voice_id);
    if (!id) return;
    const name = typeof entry[nameKey] === 'string' ? entry[nameKey].trim().slice(0, 256) : '';
    if (voices.size < 1000) voices.set(id, { id, name: name || id });
  };
  const request = async (url: URL, body?: unknown): Promise<RecordValue> => {
    assertCurrent();
    controller.signal.throwIfAborted();
    const response = await fetcher(url.toString(), {
      method: body ? 'POST' : 'GET',
      headers: { ...connection.headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: controller.signal,
    });
    const json = await readJson(response, controller.signal);
    assertCurrent();
    return json;
  };
  try {
    const base = connection.baseUrl.replace(/\/+$/, '');
    if (openRouterBase) {
      const json = await request(new URL(`${openRouterBase}/models?output_modalities=speech`));
      if (!Array.isArray(json.data)) throw new Error('invalid_voice_catalog');
      const model = json.data.map(record).find(entry => entry.id === modelId);
      if (!model) throw new Error('voice_catalog_unavailable');
      if (model.supported_voices == null) return { source: 'manual', voices: [] };
      if (!Array.isArray(model.supported_voices)) throw new Error('invalid_voice_catalog');
      const ids = [...new Set(model.supported_voices
        .map(normalizeSpeechVoiceId).filter((id): id is string => !!id))];
      return {
        source: 'provider', voices: ids.slice(0, 1000).map(id => ({ id, name: id })),
        ...(ids.length > 1000 ? { truncated: true } : {}),
      };
    }
    if (connection.protocol === 'dashscope-tts')
      return await loadDashscopeVoices(modelId, base, request, assertCurrent);
    if (connection.protocol === 'minimax') {
      // https://platform.minimax.io/docs/api-reference/voice-management-get
      const json = await request(new URL(`${base}/get_voice`), { voice_type: 'all' });
      if (record(json.base_resp).status_code !== 0) throw new Error('voice_catalog_unavailable');
      let count = 0;
      for (const key of ['system_voice', 'voice_cloning', 'voice_generation']) {
        const entries = json[key];
        if (entries !== undefined && !Array.isArray(entries))
          throw new Error('invalid_voice_catalog');
        if (Array.isArray(entries)) {
          count += entries.length;
          entries.forEach((entry) => append(entry, 'voice_name'));
        }
      }
      return { source: 'provider', voices: [...voices.values()], truncated: count > 1000 };
    }
    // https://elevenlabs.io/docs/api-reference/voices/search
    // Preserve a custom proxy prefix and origin. Unversioned proxies can expose the
    // legacy /voices route; failure falls back to manual entry in the UI.
    const paginated = /\/v1$/.test(base);
    const url = new URL(paginated ? `${base.slice(0, -3)}/v2/voices` : `${base}/voices`);
    if (paginated) url.searchParams.set('page_size', '100');
    const tokens = new Set<string>();
    for (let page = 0; page < 10; page += 1) {
      const json = await request(url);
      if (!Array.isArray(json.voices)) throw new Error('invalid_voice_catalog');
      json.voices.forEach((entry) => append(entry, 'name'));
      if (json.has_more !== true)
        return {
          source: 'provider',
          voices: [...voices.values()],
          truncated: json.voices.length > 1000,
        };
      if (!paginated || voices.size >= 1000) break;
      if (
        typeof json.next_page_token !== 'string' ||
        !json.next_page_token ||
        tokens.has(json.next_page_token)
      )
        throw new Error('invalid_voice_pagination');
      tokens.add(json.next_page_token);
      url.searchParams.set('next_page_token', json.next_page_token);
    }
    return { source: 'provider', voices: [...voices.values()], truncated: true };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
