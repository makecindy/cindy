/**
 * invoke 结果增量（`transfer.delta`）：控制端对同一 channel + args 的重复读取声明
 * `delta: 1`，并照旧带上已持有结果的内容标签 `ifNoneMatch`。被控端若还记得最近一次
 * 发给这个控制端、同一请求、同一标签的结果全文，就只回「与那份结果相比的差异」。
 * 两端的起点是标签（SHA-256）相同的同一段 JSON 文本，套用同一份补丁得到同一段文本；
 * 被控端发出前先自己套用一遍核对，长度再由控制端核对一次。
 *
 * 补丁（JSON，作用在解析后的基准值上）：
 *   `{ s: value }`                  整体替换
 *   `{ a: [n | [value], ...] }`     数组：取基准第 n 个元素，或新的字面元素
 *   `{ o: { key: patch, ... } }`    对象：键与顺序同基准，未列出的键保持基准值
 * 元素按 JSON 文本完全相同才复用，所以变了的行整行重发。
 *
 * 只对 `INVOKE_DELTA_CHANNELS` 里的只读列表启用；两端都按这张表判断，旧端不认识
 * `delta` 字段，行为不变。
 */

export interface InvokeResultDelta {
  /** 基准结果的内容标签（即请求的 `ifNoneMatch`）。 */
  base: string;
  /** 还原后 JSON 文本的 UTF-16 长度；控制端据此再核对一次。 */
  length: number;
  /** 还原后全文的抽样摘要（`sampleInvokeResultText`），发现行错位；不是完整性校验。 */
  sample: number;
  patch?: InvokeResultPatch;
  /** 同一补丁 JSON 的 gzip + base64；控制端声明可解且确有收益时使用。 */
  gzipBase64?: string;
}

export type InvokeResultPatch =
  | { s: unknown }
  | { a: Array<number | [unknown]> }
  | { o: Record<string, InvokeResultPatch> };

/** 只用于侧栏任务列表；其它只读列表要逐个确认适用后再加入。 */
export const INVOKE_DELTA_CHANNELS: ReadonlySet<string> = new Set(['local-db:sessions:list']);

export function isInvokeDeltaChannel(channel: string | undefined): boolean {
  return typeof channel === 'string' && INVOKE_DELTA_CHANNELS.has(channel);
}

/** 增量至少要省下全文的一半，否则照旧发全文（或 gzip）。 */
const MAX_DELTA_RATIO = 0.5;
/** 只拆到「顶层对象 → 其中的数组」两层，行本身整行替换。 */
const MAX_DEPTH = 2;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function samePlainKeys(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const left = Object.keys(a);
  const right = Object.keys(b);
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/** 每个元素只序列化一次；整体相等由「元素逐个复用且顺序不变」推出，不再整段比较。 */
function diff(base: unknown, next: unknown, depth: number): InvokeResultPatch | undefined {
  if (depth < MAX_DEPTH && Array.isArray(base) && Array.isArray(next)) {
    const byText = new Map<string, number>();
    base.forEach((element, index) => {
      const text = JSON.stringify(element);
      if (!byText.has(text)) byText.set(text, index);
    });
    let reused = 0;
    let inPlace = base.length === next.length;
    const a = next.map((element, position): number | [unknown] => {
      const index = byText.get(JSON.stringify(element));
      if (index === undefined) {
        inPlace = false;
        return [element];
      }
      reused += 1;
      if (index !== position) inPlace = false;
      return index;
    });
    if (inPlace) return undefined;
    return reused > 0 ? { a } : { s: next };
  }
  if (depth < MAX_DEPTH && isPlainObject(base) && isPlainObject(next) && samePlainKeys(base, next)) {
    const o: Record<string, InvokeResultPatch> = {};
    let changed = false;
    for (const key of Object.keys(next)) {
      const child = diff(base[key], next[key], depth + 1);
      if (child) {
        o[key] = child;
        changed = true;
      }
    }
    return changed ? { o } : undefined;
  }
  return JSON.stringify(base) === JSON.stringify(next) ? undefined : { s: next };
}

/** 复用的基准元素按 JSON 长度计入预算：重复引用同一大元素也不能展开出超限结果。 */
function apply(base: unknown, patch: InvokeResultPatch | undefined, depth: number, budget: { left: number }): unknown {
  if (patch === undefined) return base;
  if (!isPlainObject(patch)) throw new Error('invalid delta patch');
  if ('s' in patch) return patch.s;
  if (depth >= MAX_DEPTH) throw new Error('delta patch too deep');
  if ('a' in patch) {
    if (!Array.isArray(base) || !Array.isArray(patch.a)) throw new Error('invalid array delta');
    const lengths = new Map<number, number>();
    return patch.a.map((entry) => {
      if (typeof entry === 'number') {
        if (!Number.isInteger(entry) || entry < 0 || entry >= base.length) throw new Error('invalid array delta index');
        let length = lengths.get(entry);
        if (length === undefined) {
          length = JSON.stringify(base[entry])?.length ?? 4;
          lengths.set(entry, length);
        }
        budget.left -= length;
        if (budget.left < 0) throw new Error('delta result too large');
        return base[entry];
      }
      if (!Array.isArray(entry) || entry.length !== 1) throw new Error('invalid array delta element');
      return entry[0];
    });
  }
  if ('o' in patch) {
    if (!isPlainObject(base) || !isPlainObject(patch.o)) throw new Error('invalid object delta');
    for (const key of Object.keys(patch.o)) {
      if (!Object.prototype.hasOwnProperty.call(base, key)) throw new Error('invalid object delta key');
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(base)) {
      const child = Object.prototype.hasOwnProperty.call(patch.o, key) ? patch.o[key] : undefined;
      result[key] = apply(base[key], child, depth + 1, budget);
    }
    return result;
  }
  throw new Error('invalid delta patch');
}

const SAMPLE_POINTS = 8192;

/**
 * 抽样摘要：长度加等距抽样字符的 FNV-1a（步长为长度除以 8192 下取整，最多约 16K 个字符）。
 * 成本有上限、与结果大小无关，用来发现补丁
 * 套错位置（行错位、序号偏移）。被控端可信，这不是防篡改的完整性校验。
 */
export function sampleInvokeResultText(text: string): number {
  const step = Math.max(1, Math.floor(text.length / SAMPLE_POINTS));
  let hash = (0x811c9dc5 ^ text.length) >>> 0;
  for (let index = 0; index < text.length; index += step) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return Math.imul(hash ^ text.charCodeAt(text.length - 1), 0x01000193) >>> 0;
}

/**
 * 控制端：从缓存的基准全文还原新结果（值与全文）；超过 maxChars 或补丁不合法时抛错。
 * 值来自本次对基准的新解析，不与缓存或其它调用方共享引用，可直接交给调用方。
 */
export function applyInvokeResultPatchValue(baseText: string, patch: InvokeResultPatch, maxChars: number): { value: unknown; text: string } {
  const value = apply(JSON.parse(baseText), patch, 0, { left: maxChars });
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || text.length > maxChars) throw new Error('delta result too large');
  return { value, text };
}

export function applyInvokeResultPatch(baseText: string, patch: InvokeResultPatch, maxChars: number): string {
  return applyInvokeResultPatchValue(baseText, patch, maxChars).text;
}

/**
 * 被控端：只有补丁明显更小、且自己套用后与 `nextText` 逐字相同时才返回补丁，
 * 否则返回 null（照旧发全文）。
 */
export function computeInvokeResultPatch(baseText: string, nextText: string, maxChars: number): InvokeResultPatch | null {
  let base: unknown;
  let next: unknown;
  try {
    base = JSON.parse(baseText);
    next = JSON.parse(nextText);
  } catch {
    return null;
  }
  const patch = diff(base, next, 0);
  if (!patch || 's' in patch) return null;
  if (JSON.stringify(patch).length > nextText.length * MAX_DELTA_RATIO) return null;
  try {
    if (applyInvokeResultPatch(baseText, patch, maxChars) !== nextText) return null;
  } catch {
    return null;
  }
  return patch;
}

const MAX_BASE_ENTRIES = 32;
/** 同一控制端最多占几份（active / all / archived 等参数各一份），不能挤掉其它控制端。 */
const MAX_BASE_ENTRIES_PER_PEER = 4;
/** JS 字符串按 UTF-16 计，约 8MB 内存；与控制端结果缓存同量级。 */
const MAX_BASE_CHARS = 4 * 1024 * 1024;
/** 同一控制端最多占总预算的一半。 */
const MAX_BASE_CHARS_PER_PEER = MAX_BASE_CHARS / 2;

/**
 * 被控端：每个控制端、每个请求最近一次发出的结果全文，只在内存、有上限。
 * 记不住（被淘汰、进程重启、连接重建）时控制端的 `ifNoneMatch` 对不上，自然回全文。
 */
export class InvokeDeltaBases {
  private readonly entries = new Map<string, { tag: string; text: string }>();
  private chars = 0;

  get(src: string, requestKey: string): { tag: string; text: string } | undefined {
    return this.entries.get(`${src}\u0000${requestKey}`);
  }

  remember(src: string, requestKey: string, tag: string, text: string): void {
    const key = `${src}\u0000${requestKey}`;
    const previous = this.entries.get(key);
    if (previous) {
      this.chars -= previous.text.length;
      this.entries.delete(key);
    }
    if (text.length > MAX_BASE_CHARS_PER_PEER) return;
    this.entries.set(key, { tag, text });
    this.chars += text.length;
    const prefix = `${src}\u0000`;
    // 先淘汰该控制端自己最旧的几份（条数、字符两道上限），再按全局上限淘汰。
    const own = [...this.entries].filter(([entry]) => entry.startsWith(prefix));
    let ownChars = own.reduce((sum, [, entry]) => sum + entry.text.length, 0);
    for (let i = 0; i < own.length - 1 && (own.length - i > MAX_BASE_ENTRIES_PER_PEER || ownChars > MAX_BASE_CHARS_PER_PEER); i++) {
      ownChars -= own[i]![1].text.length;
      this.delete(own[i]![0]);
    }
    while (this.entries.size > MAX_BASE_ENTRIES || this.chars > MAX_BASE_CHARS) {
      this.delete(this.entries.keys().next().value!);
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.chars -= entry.text.length;
    this.entries.delete(key);
  }

  /** 控制端被撤销、踢出或本机关闭远控时，立即释放它的基准；普通断线保留。 */
  forgetPeer(src: string): void {
    const prefix = `${src}\u0000`;
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.chars = 0;
  }
}
