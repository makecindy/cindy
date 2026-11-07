import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const ENTRY_PREFIX_CHARS = 4096;

export interface PiSessionJsonlScan {
  userEntryIds: Set<string>;
  lastPlanModeEnabled: boolean | null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function firstQuoted(field: string, prefix: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`).exec(prefix);
  return match?.[1];
}

/** Read native data.enabled before a large todos payload, with bounded parsing. */
function planEnabledFromPrefix(prefix: string): boolean | undefined {
  for (const match of prefix.matchAll(/"enabled"\s*:\s*(true|false)\s*(?=[,}])/g)) {
    try {
      // Closing data + root must produce a real entry. A nested field or text
      // that merely resembles metadata cannot supply the plan-mode flag.
      const entry = recordOf(JSON.parse(prefix.slice(0, match.index + match[0].length) + '}}'));
      const data = recordOf(entry?.data);
      if (entry?.type === 'custom' && entry.customType === 'plan-mode' && typeof data?.enabled === 'boolean') {
        return data.enabled;
      }
    } catch { /* The next candidate may be the actual top-level data.enabled. */ }
  }
  return undefined;
}

function extractEntryMeta(line: string): {
  type?: string;
  id?: string;
  role?: string;
  customType?: string;
  planEnabled?: boolean;
} {
  const prefix = line.length > ENTRY_PREFIX_CHARS ? line.slice(0, ENTRY_PREFIX_CHARS) : line;
  if (line.length <= 64 * 1024) {
    try {
      const entry = recordOf(JSON.parse(line));
      if (!entry) return {};
      const message = recordOf(entry.message);
      const data = recordOf(entry.data);
      return {
        type: typeof entry.type === 'string' ? entry.type : undefined,
        id: typeof entry.id === 'string' ? entry.id : undefined,
        role: typeof message?.role === 'string' ? message.role : undefined,
        customType: typeof entry.customType === 'string' ? entry.customType : undefined,
        planEnabled: typeof data?.enabled === 'boolean' ? data.enabled : undefined,
      };
    } catch {
      /* fall through to prefix scan for truncated / huge lines */
    }
  }
  return {
    type: firstQuoted('type', prefix),
    id: firstQuoted('id', prefix),
    role: firstQuoted('role', prefix),
    customType: firstQuoted('customType', prefix),
    planEnabled: planEnabledFromPrefix(prefix),
  };
}

function applyEntry(scan: PiSessionJsonlScan, line: string): boolean | undefined {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (trimmed.length === 0) return;
  const meta = extractEntryMeta(trimmed);
  if (meta.type === 'message' && meta.role === 'user' && meta.id) {
    scan.userEntryIds.add(meta.id);
  }
  if (meta.type === 'custom' && meta.customType === 'plan-mode') {
    if (typeof meta.planEnabled !== 'boolean') return false;
    scan.lastPlanModeEnabled = meta.planEnabled;
    return true;
  }
}

/**
 * 只扫 session JSONL 的元数据:user entry id 与最后一条 plan-mode。
 * 不经过 Pi RPC,也不把整段带图历史装进 16 Mi 字符的 JSONL 响应帧。
 */
export async function scanPiSessionJsonl(sessionFile: string): Promise<PiSessionJsonlScan | null> {
  return new Promise((resolve) => {
    const scan: PiSessionJsonlScan = {
      userEntryIds: new Set<string>(),
      lastPlanModeEnabled: null,
    };
    const stream = createReadStream(sessionFile);
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let prefix = '';
    let skippingRestOfLine = false;
    let settled = false;
    let planStateKnown = true;

    const applyLine = (line: string): void => {
      const known = applyEntry(scan, line);
      if (known !== undefined) planStateKnown = known;
    };

    const finish = (result: PiSessionJsonlScan | null): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const consumePrefixLine = (): void => {
      if (prefix.length === 0) return;
      applyLine(prefix);
      prefix = '';
    };

    const emitCompleteLines = (): void => {
      while (true) {
        if (skippingRestOfLine) {
          const newlineIndex = buffer.indexOf('\n');
          if (newlineIndex === -1) {
            buffer = '';
            return;
          }
          buffer = buffer.slice(newlineIndex + 1);
          skippingRestOfLine = false;
          consumePrefixLine();
          continue;
        }
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) {
          if (buffer.length > ENTRY_PREFIX_CHARS) {
            prefix = buffer.slice(0, ENTRY_PREFIX_CHARS);
            buffer = '';
            skippingRestOfLine = true;
          }
          return;
        }
        applyLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
      }
    };

    stream.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      emitCompleteLines();
    });
    stream.on('error', () => finish(null));
    stream.on('end', () => {
      buffer += decoder.end();
      emitCompleteLines();
      if (!skippingRestOfLine && buffer.length > 0) applyLine(buffer);
      else consumePrefixLine();
      // An unreadable latest flag must use the existing RPC fallback, never a
      // preceding entry's flag (or a guessed default) as current native state.
      finish(planStateKnown ? scan : null);
    });
  });
}
