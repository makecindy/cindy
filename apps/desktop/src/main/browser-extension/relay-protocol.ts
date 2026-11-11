/**
 * 扩展发起的转交请求(线协议里的 `/learning/*` 通道):宿主只负责形状校验、
 * 超时预算和排队上限,业务处理(翻译、字幕、生词本)由声明 browserExtension
 * 的插件完成。判据与扩展侧 learning-core 保持一致:宿主拒绝的请求,扩展侧
 * 本来也不会发;宿主放行的请求,插件再按业务校验一次。
 */

export const RELAY_TIMING = Object.freeze({
  model: 240_000,
  cancel: 15_000,
  queue: 30_000,
  transport: 30_000,
  resultRetention: 330_000,
});

const OPERATIONS = new Set([
  'translate',
  'explain',
  'summary',
  'conversation',
  'save',
  'list',
  'remove',
  'review',
  'import',
  'preferences',
  'config',
  'task',
  'subtitles',
  'subtitle-document',
  'subtitle-cache-clear',
]);

const MODEL_OPERATIONS = new Set([
  'subtitles',
  'subtitle-document',
  'translate',
  'explain',
  'summary',
  'conversation',
  'task',
]);

const BASE_LANGUAGES = [
  'auto',
  'en',
  'zh-CN',
  'zh-TW',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'it',
  'pt',
  'ru',
  'ar',
  'hi',
  'th',
  'vi',
];
const ISO_LANGUAGES =
  'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zu'.split(
    ' ',
  );
const LANGUAGES = new Set([...BASE_LANGUAGES, ...ISO_LANGUAGES]);

const CUSTOM_TARGET_RE = /^custom:[\p{L}\p{M}][\p{L}\p{M}\p{N} ()’'·-]{0,79}$/u;

export interface RelaySource {
  url: string;
  title: string;
  time?: number;
}

export interface RelayRequest {
  op: string;
  source: RelaySource;
  [key: string]: unknown;
}

function validTarget(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ((LANGUAGES.has(value) && value !== 'auto') || CUSTOM_TARGET_RE.test(value))
  );
}

function string(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new Error('INVALID_INPUT');
  return value;
}

function source(value: unknown): RelaySource {
  if (!value || typeof value !== 'object') return { url: '', title: '' };
  const raw = value as { url?: unknown; title?: unknown; time?: unknown };
  const url = string(raw.url ?? '', 8192);
  const title = string(raw.title ?? '', 500);
  if (url && !/^https?:$/.test(new URL(url).protocol)) throw new Error('INVALID_SOURCE');
  const time = raw.time;
  if (
    time !== undefined &&
    (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time > 864000)
  ) {
    throw new Error('INVALID_TIME');
  }
  return {
    url: url ? new URL(url).href : '',
    title,
    ...(time === undefined ? {} : { time: time as number }),
  };
}

interface SubtitleWord {
  text: string;
  start: number;
  end: number;
  breakBefore: boolean;
}

/** 校验转交请求;非法时抛出 Error(code)。返回值只含校验过的字段。 */
export function validateRelayRequest(input: unknown): RelayRequest {
  const raw = (input && typeof input === 'object' ? input : null) as Record<string, unknown> | null;
  if (!raw || typeof raw.op !== 'string' || !OPERATIONS.has(raw.op))
    throw new Error('INVALID_OPERATION');
  const out: RelayRequest = { op: raw.op, source: source(raw.source) };
  // The tab or document the request came from, so per-view state (the current video's subtitle
  // task) is not shared across tabs. Opaque to the host; mirrors the plugin's learning-core rule.
  if (raw.view !== undefined) {
    if (typeof raw.view !== 'string' || !/^[A-Za-z0-9:_-]{1,64}$/.test(raw.view))
      throw new Error('INVALID_INPUT');
    out.view = raw.view;
  }
  if (raw.target !== undefined) {
    if (!validTarget(raw.target)) throw new Error('INVALID_LANGUAGE');
    out.target = raw.target;
  }
  if (raw.language !== undefined) {
    if (typeof raw.language !== 'string' || !LANGUAGES.has(raw.language))
      throw new Error('INVALID_LANGUAGE');
    out.language = raw.language;
  }
  const editorial = raw.op === 'subtitles' && raw.editorial === true;
  const limits: Array<[string, number]> = [
    ['text', 20000],
    ['translation', 20000],
    ['context', raw.op === 'subtitle-document' || editorial ? 8000 : 4000],
    ['query', 200],
    ['scenario', 1000],
    ['instruction', 4000],
  ];
  for (const [key, max] of limits) if (raw[key] !== undefined) out[key] = string(raw[key], max);
  const text = out.text as string | undefined;
  if (
    ['translate', 'explain', 'summary', 'conversation', 'save', 'task'].includes(out.op) &&
    !text?.trim() &&
    !raw.texts
  ) {
    throw new Error('EMPTY_TEXT');
  }
  if (raw.texts !== undefined) {
    if (
      out.op !== 'translate' ||
      !Array.isArray(raw.texts) ||
      !raw.texts.length ||
      raw.texts.length > 24
    ) {
      throw new Error('INVALID_BATCH');
    }
    const texts = raw.texts.map((x) => string(x, 4000, true));
    if (texts.join('').length > 20000) throw new Error('BATCH_TOO_LARGE');
    out.texts = texts;
  }
  if (out.op === 'subtitle-document' && !text?.trim()) throw new Error('EMPTY_TEXT');
  if (out.op === 'subtitles') {
    out.editorial = editorial;
    const wordsRaw = raw.words;
    if (!Array.isArray(wordsRaw) || !wordsRaw.length || wordsRaw.length > (editorial ? 360 : 240))
      throw new Error('INVALID_BATCH');
    const words: SubtitleWord[] = wordsRaw.map(
      (w: { text?: unknown; start?: unknown; end?: unknown; breakBefore?: unknown }, i) => {
        const wordText = string(w?.text, 500, true);
        const start = w?.start;
        const end = w?.end;
        const previousEnd = (wordsRaw[i - 1] as { end?: unknown } | undefined)?.end;
        if (
          typeof start !== 'number' ||
          typeof end !== 'number' ||
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start < 0 ||
          end <= start ||
          end > 864000 ||
          (i > 0 && (typeof previousEnd !== 'number' || start < previousEnd - 0.001))
        ) {
          throw new Error('INVALID_TIME');
        }
        return { text: wordText, start, end, breakBefore: w?.breakBefore === true };
      },
    );
    if (words.map((w) => w.text).join('').length > 12000) throw new Error('BATCH_TOO_LARGE');
    out.words = words;
    if (raw.nextStart !== undefined) {
      const nextStart = raw.nextStart;
      if (
        typeof nextStart !== 'number' ||
        !Number.isFinite(nextStart) ||
        nextStart < words[words.length - 1].end ||
        nextStart > 864000
      ) {
        throw new Error('INVALID_TIME');
      }
      out.nextStart = nextStart;
    }
  }
  if (raw.id !== undefined) out.id = string(raw.id, 100, true);
  if (['remove', 'review', 'task'].includes(out.op) && !out.id) throw new Error('INVALID_ID');
  if (out.op === 'task' && !/^[a-f0-9-]{36}$/.test(out.id as string)) throw new Error('INVALID_ID');
  if (out.op === 'review') {
    if (!['again', 'hard', 'good', 'easy'].includes(raw.rating as string))
      throw new Error('INVALID_RATING');
    out.rating = raw.rating;
  }
  if (out.op === 'import') {
    if (!Array.isArray(raw.entries) || raw.entries.length > 500)
      throw new Error('IMPORT_TOO_LARGE');
    out.entries = raw.entries.map((entry) =>
      validateRelayRequest({ ...(entry as object), op: 'save' }),
    );
  }
  if (out.op === 'list') {
    out.offset = Number.isInteger(raw.offset) && (raw.offset as number) >= 0 ? raw.offset : 0;
    out.limit = Number.isInteger(raw.limit) ? Math.min(100, Math.max(1, raw.limit as number)) : 50;
    out.due = raw.due === true;
  }
  return out;
}

/** 一个转交请求允许吊多久:模型类请求按尝试次数预留两槽调度时间,其余只留传输预算。 */
export function relayRequestTimeout(request: RelayRequest): number {
  if (!MODEL_OPERATIONS.has(request.op)) return RELAY_TIMING.transport;
  const attempts =
    request.op === 'subtitles' ? (request.editorial ? 2 : 3) : request.op === 'translate' ? 2 : 1;
  return (
    attempts * (2 * (RELAY_TIMING.model + RELAY_TIMING.cancel) + RELAY_TIMING.queue) +
    RELAY_TIMING.transport
  );
}

export const RELAY_PROGRESS_STAGES = [
  'accepted',
  'opening-task',
  'submitting-task',
  'stopping',
  'cache',
  'queued',
  'waiting-previous',
  'model',
  'generating',
  'validating',
  'saving',
] as const;
