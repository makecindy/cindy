export interface ToolResultCompactionMarker {
  type: 'tool_result_compacted';
  version: 1;
  originalBytes: number;
  compactedAt: number;
  diagnostics?: ToolResultDiagnostics;
}

/** Observed fields, not an inferred task verdict. No messages, input or media. */
export interface ToolResultDiagnostics {
  ok?: boolean;
  isError?: boolean;
  errorCode?: string;
  outcome?: 'confirmed' | 'unknown' | 'failed';
  outcomeUnknown?: boolean;
  effect?: 'confirmed' | 'unverifiable' | 'refused';
  deliveryMode?: 'background' | 'foreground';
  verificationStatus?: 'satisfied' | 'unsatisfied' | 'unknown';
  observationOk?: boolean;
  observationErrorCode?: string;
  afterSnapshotOk?: boolean;
  afterSnapshotErrorCode?: string;
}

// Self-contained: the legacy inline DB worker embeds this same function.
export function sanitizeToolResultDiagnostics(value: unknown): ToolResultDiagnostics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['ok', 'isError', 'outcomeUnknown', 'observationOk', 'afterSnapshotOk']) {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  }
  const enums: Record<string, readonly string[]> = {
    outcome: ['confirmed', 'unknown', 'failed'],
    effect: ['confirmed', 'unverifiable', 'refused'],
    deliveryMode: ['background', 'foreground'],
    verificationStatus: ['satisfied', 'unsatisfied', 'unknown'],
    // Deliberately closed: even a short arbitrary error code can contain a secret.
    errorCode: [
      'INVALID_ARGS', 'UNKNOWN_TOOL', 'COMPUTER_DRIVER_ERROR', 'CUA_UNAVAILABLE',
      'COMPUTER_DRIVER_INCOMPATIBLE', 'STALE_SNAPSHOT', 'SECURE_FIELD',
      'PATH_NOT_ALLOWED', 'REQUEST_CANCELLED', 'ACTION_OUTCOME_UNKNOWN',
      'POSTCONDITION_NOT_SATISFIED', 'DESKTOP_INPUT_BUSY', 'DESKTOP_INPUT_YIELDED', 'APP_NOT_INSTALLED',
      'window_id_not_found', 'window_not_found', 'stale_element_token',
      'screenshot_context_missing', 'capture_expired', 'typed_output_mismatch',
      'background_unavailable', 'browser_consent_required',
      'ACT_INVALID_REQUEST', 'BROWSER_UNAVAILABLE', 'BROWSER_NOT_CONNECTED',
      'BROWSER_RUNTIME_ACTION_FAILED', 'BROWSER_RUNTIME_INVALID_REQUEST', 'TIMEOUT',
    ],
  };
  enums.observationErrorCode = enums.errorCode;
  enums.afterSnapshotErrorCode = enums.errorCode;
  for (const [key, allowed] of Object.entries(enums)) {
    if (typeof source[key] === 'string' && allowed.includes(source[key])) result[key] = source[key];
  }
  return Object.keys(result).length ? result as ToolResultDiagnostics : undefined;
}

/** Parse only a whole structured result or our bounded persistence footer. */
export function extractToolResultDiagnostics(content: unknown, unwrapMcp = true): ToolResultDiagnostics | undefined {
  let value = content;
  let isError = false;
  // messages.content may JSON-encode the tool's textual JSON once more.
  for (let layer = 0; layer < 2 && typeof value === 'string'; layer += 1) {
    let text = value;
    const footer = '\n\n[tool result diagnostics: ';
    const suffix = ']\n\n[tool result truncated: stored first 8KB]';
    const position = text.lastIndexOf(footer);
    if (position >= 0 && text.endsWith(suffix) && text.length - position <= 1024) {
      try {
        return sanitizeToolResultDiagnostics(JSON.parse(text.slice(position + footer.length, -suffix.length)));
      } catch { return undefined; }
    }
    text = text.trim();
    if (text.startsWith('<tool_use_error>') && text.endsWith('</tool_use_error>')) {
      text = text.slice(16, -17).trim();
      isError = true;
    }
    // Historical uncapped rows may be enormous. Future rows are capped before archive.
    if (text.length > 1024 * 1024) return isError ? { isError: true } : undefined;
    if (!text.startsWith('{') && !text.startsWith('"')) return isError ? { isError: true } : undefined;
    try { value = JSON.parse(text); } catch { return isError ? { isError: true } : undefined; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return isError ? { isError: true } : undefined;
  const root = value as Record<string, unknown>;
  const object = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  if (unwrapMcp && Array.isArray(root.content) && root.content.length === 1) {
    const block = object(root.content[0]);
    if (block.type === 'text' && typeof block.text === 'string') {
      return sanitizeToolResultDiagnostics({
        ...extractToolResultDiagnostics(block.text, false),
        ...(typeof root.isError === 'boolean' ? { isError: root.isError } : {}),
        ...(isError ? { isError: true } : {}),
      });
    }
  }
  // Truncated card results remain valid JSON so presentation references survive.
  if (root.truncated === true && (typeof root.xdt_card_id === 'string' || typeof root.xdt_anchor_card_id === 'string')) {
    return sanitizeToolResultDiagnostics(root.diagnostics) ?? sanitizeToolResultDiagnostics({ ok: root.ok });
  }
  const data = root.tool !== undefined || root.errorCode !== undefined ? object(root.data) : root;
  return sanitizeToolResultDiagnostics({
    ok: root.ok,
    isError: isError ? true : root.isError,
    errorCode: root.errorCode ?? root.code ?? object(root.refusal).code,
    outcome: object(root.outcome).status,
    outcomeUnknown: data.outcome_unknown,
    effect: data.effect,
    deliveryMode: object(data.delivery).mode,
    verificationStatus: object(object(root.postcheck).data).status ?? data.status,
    observationOk: object(root.observation).ok,
    observationErrorCode: object(root.observation).errorCode,
    afterSnapshotOk: object(root.afterSnapshot).ok,
    afterSnapshotErrorCode: object(root.afterSnapshot).errorCode,
  });
}

export function parseToolResultCompactionMarker(
  content: unknown,
): ToolResultCompactionMarker | null {
  let parsed = content;
  if (typeof parsed === 'string') {
    if (!parsed.includes('tool_result_compacted')) return null;
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (
    record.type !== 'tool_result_compacted' ||
    record.version !== 1 ||
    typeof record.originalBytes !== 'number' ||
    !Number.isFinite(record.originalBytes) ||
    record.originalBytes < 0 ||
    typeof record.compactedAt !== 'number' ||
    !Number.isFinite(record.compactedAt) ||
    record.compactedAt < 0
  ) {
    return null;
  }
  const diagnostics = sanitizeToolResultDiagnostics(record.diagnostics);
  return {
    type: 'tool_result_compacted',
    version: 1,
    originalBytes: record.originalBytes,
    compactedAt: record.compactedAt,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

const COMPACTED_BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

export function formatToolResultCompactionBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  // 先取整字节数,再交替换档位:1048575 B 属于 MB 档,不该停在 KB 档被四舍五入成
  // "1024 KB" —— 那一档的合法最大值是 1023,超过就该升到下一档。
  let value = Math.round(bytes);
  let unit = 0;
  while (value >= 1024 && unit < COMPACTED_BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  for (;;) {
    // 展示值也可能因为取整跨过 1024(1023.6 KB → "1024"),此时同样要升档。
    // 各档原有精度保持不变:KB 小于 10 保留一位小数、其余取整;MB 与 GB 始终一位小数。
    const text =
      unit === 0
        ? `${value}`
        : unit === 1
          ? value < 10
            ? value.toFixed(1)
            : `${Math.round(value)}`
          : value.toFixed(1);
    if (Number(text) < 1024 || unit === COMPACTED_BYTE_UNITS.length - 1) {
      return `${text} ${COMPACTED_BYTE_UNITS[unit]}`;
    }
    value = Number(text) / 1024;
    unit += 1;
  }
}
