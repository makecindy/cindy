import { randomUUID } from 'node:crypto';

/** Session-only originals: bounded memory, no disk, no background jobs or model calls. */
export class BrowserResultCache {
  private readonly originals = new Map<
    string,
    { text: string; source: { profile?: string; targetId?: string } }
  >();

  clear(): void {
    this.originals.clear();
  }

  source(id: string) {
    return this.originals.get(id)?.source;
  }

  digest(
    value: Record<string, unknown>,
    source: { profile?: string; targetId?: string } = {},
  ): Record<string, unknown> {
    const json = JSON.stringify(value);
    if (json.length <= 16_384) return value;
    // Oversize results keep the existing explicit truncation fallback. Never
    // advertise an original that could not be retained within the memory budget.
    if (json.length > 2_000_000) return value;
    if (this.originals.size >= 4) this.originals.delete(this.originals.keys().next().value!);
    const id = `result-${randomUUID()}`;
    this.originals.set(id, { text: json, source });
    return {
      ok: value.ok,
      action: value.action,
      errorCode: value.errorCode,
      message: typeof value.message === 'string' ? value.message.slice(0, 2_000) : undefined,
      ...(value.loginWall ? { loginWall: sample(value.loginWall, 0, { remaining: 1_000 }) } : {}),
      ...(value.failureKind
        ? { failureKind: value.failureKind, failedStep: value.failedStep }
        : {}),
      ...(value.recovery ? { recovery: value.recovery } : {}),
      ...(value.maintenanceMessage ? { maintenanceMessage: value.maintenanceMessage } : {}),
      truncated: true,
      summary: sample(value, 0, { remaining: 6_000 }),
      fullResult: {
        id,
        chars: json.length,
        read: { action: 'readResult', resultId: id, offset: 0, maxChars: 12_000 },
      },
      hint: '摘要不是完整结果。缺少事实或页面 ref 时用 readResult 分段补读；不要猜测或重放动作。原文仅留在当前工具会话，最多保留最近四份大结果。',
    };
  }

  read(id: string, offset: number, maxChars: number) {
    const text = this.originals.get(id)?.text;
    if (text === undefined)
      return {
        ok: false,
        action: 'readResult',
        message: '原文已过期或不属于当前工具会话；请重新只读获取所需内容，不要重放写操作。',
      };
    if (offset > text.length)
      return {
        ok: false,
        action: 'readResult',
        message: 'offset 超出原文长度',
        chars: text.length,
      };
    let end = Math.min(text.length, offset + maxChars);
    // 不把 UTF-16 代理对切到两页：退回到代理对之前；页内只剩高位代理时整对带上，保证分页前进。
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end)))
      end += end - 1 > offset ? -1 : 1;
    return {
      ok: true,
      action: 'readResult',
      resultId: id,
      offset,
      chars: text.length,
      text: text.slice(offset, end),
      nextOffset: end < text.length ? end : null,
    };
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Deterministic structural samples; counts make omissions explicit. */
function sample(value: unknown, depth: number, budget: { remaining: number }): unknown {
  if (budget.remaining <= 0) return '[omitted]';
  budget.remaining -= 80;
  if (typeof value === 'string') {
    budget.remaining -= Math.min(value.length, 240);
    return value.length > 240 ? `${value.slice(0, 240)}… [${value.length} chars]` : value;
  }
  if (Array.isArray(value))
    return {
      count: value.length,
      sample: depth >= 4 ? [] : value.slice(0, 2).map((item) => sample(item, depth + 1, budget)),
    };
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (depth >= 4)
      return {
        keys: entries.slice(0, 12).map(([key]) => key.slice(0, 80)),
        keyCount: entries.length,
      };
    return Object.fromEntries([
      ...entries
        .slice(0, 12)
        .map(([key, item]) => [key.slice(0, 80), sample(item, depth + 1, budget)]),
      ...(entries.length > 12 ? [['omittedKeys', entries.length - 12]] : []),
    ]);
  }
  return value;
}

/** Advisory only: legitimate duplicate titles / empty fields must not become failures. */
export function lintBrowserOutput(value: unknown): string[] {
  const object =
    value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const rows = Array.isArray(value)
    ? value
    : ['rows', 'records', 'items', 'results'].map((key) => object?.[key]).find(Array.isArray);
  if (!rows?.length) return [];
  const warnings = new Set<string>();
  const seen = new Set<string>();
  for (const row of rows.slice(0, 200)) {
    const key = JSON.stringify(row);
    if (seen.has(key)) warnings.add('duplicate_records');
    seen.add(key);
    if (!row || typeof row !== 'object') continue;
    for (const item of Object.values(row)) {
      if (item === '' || item === null) warnings.add('empty_fields');
      if (typeof item === 'string' && /<\/?[a-z][^>]*>/i.test(item)) warnings.add('markup');
    }
  }
  return [...warnings];
}
