import { alibabaSystemVoices } from '../../shared/alibabaSpeechVoices.js';
import { isCosyVoiceHttpModel, isQwenAudioHttpModel } from '../../shared/speechProtocols.js';
import { normalizeSpeechVoiceId, type SpeechVoiceCatalog } from '../../shared/voiceConversation.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};

/** List/query only: never creates, edits, deletes or downloads a voice. The list
 * response may omit target_model, so query details instead of guessing from IDs.
 * https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api
 */
export async function loadDashscopeVoices(
  modelId: string,
  baseUrl: string,
  request: (url: URL, body: unknown) => Promise<RecordValue>,
  assertCurrent: () => void,
): Promise<SpeechVoiceCatalog> {
  const system = alibabaSystemVoices(modelId, 'dashscope-tts', baseUrl);
  if (!isCosyVoiceHttpModel(modelId) && !isQwenAudioHttpModel(modelId))
    return { voices: [], source: 'manual' };
  const voices = new Map(system.map((voice) => [voice.id, voice]));
  const seen = new Set<string>();
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/services/audio/tts/customization`);
  let truncated = false;
  let customVoicesUnavailable = false;
  let details = 0;
  const query = async (input: RecordValue): Promise<RecordValue> => {
    const json = await request(url, { model: 'voice-enrollment', input });
    if (json.code || !json.output || typeof json.output !== 'object' || Array.isArray(json.output))
      throw new Error('invalid_voice_catalog');
    return record(json.output);
  };
  try {
    for (let page = 0; page < 10; page++) {
      const output = await query({ action: 'list_voice', page_index: page, page_size: 100 });
      if (!Array.isArray(output.voice_list)) throw new Error('invalid_voice_catalog');
      const entries = output.voice_list;
      for (const raw of entries.slice(0, 100)) {
        const entry = record(raw);
        const id = normalizeSpeechVoiceId(entry.voice_id);
        if (!id || seen.has(id) || voices.has(id)) continue;
        seen.add(id);
        if (entry.status !== undefined && entry.status !== 'OK') continue;
        if (typeof entry.target_model === 'string' && entry.target_model !== modelId) continue;
        let metadata = entry;
        if (!entry.target_model || !entry.status) {
          // The total 15s deadline also covers these requests. Bound the fan-out
          // independently of list size; unverified entries remain manual-only.
          if (details >= 100) {
            truncated = true;
            continue;
          }
          details++;
          metadata = await query({ action: 'query_voice', voice_id: id });
        }
        if (metadata.target_model !== modelId || metadata.status !== 'OK') continue;
        if (voices.size >= 1000) {
          truncated = true;
          continue;
        }
        const name =
          typeof entry.voice_name === 'string' ? entry.voice_name.trim().slice(0, 256) : '';
        voices.set(id, { id, name: name || id });
      }
      if (entries.length < 100) break;
      if (entries.length > 100 || page === 9 || voices.size >= 1000) {
        truncated = true;
        break;
      }
    }
  } catch {
    // Do not turn an ownership/credential change into a successful fallback with
    // private results. Provider failure alone leaves known public/verified voices.
    assertCurrent();
    customVoicesUnavailable = true;
  }
  assertCurrent();
  const custom = voices.size > system.length;
  return {
    voices: [...voices.values()],
    source: system.length ? (custom ? 'mixed' : 'reference') : custom ? 'provider' : 'manual',
    ...(truncated ? { truncated: true } : {}),
    ...(customVoicesUnavailable ? { customVoicesUnavailable: true } : {}),
  };
}
