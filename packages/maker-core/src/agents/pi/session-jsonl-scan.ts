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

function extractEntryMeta(line: string, oversized: boolean): {
  type?: string;
  id?: string;
  role?: string;
  customType?: string;
  planEnabled?: boolean;
} {
  const prefix = line.length > ENTRY_PREFIX_CHARS ? line.slice(0, ENTRY_PREFIX_CHARS) : line;
  if (!oversized) {
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
      return {};
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

function applyEntry(scan: PiSessionJsonlScan, line: string, oversized: boolean): boolean | undefined {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (trimmed.length === 0) return;
  const meta = extractEntryMeta(trimmed, oversized);
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
    let line = '';
    let oversized = false;
    let skeleton = '';
    let inString = false;
    let escaped = false;
    let unicode = 0;
    let valid = true;
    let settled = false;
    let planStateKnown = true;

    const finish = (result: PiSessionJsonlScan | null): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Validate the complete JSON grammar without retaining large string values.
    // Escapes/control characters are checked before replacing strings with "".
    // A bounded skeleton that grows too large safely uses the RPC fallback.
    const validate = (text: string): void => {
      for (const char of text) {
        if (!valid) return;
        if (inString) {
          if (unicode) {
            if (!/[0-9a-f]/i.test(char)) valid = false;
            unicode--;
          } else if (escaped) {
            if (char === 'u') unicode = 4;
            else if (!'"\\/bfnrt'.includes(char)) valid = false;
            escaped = false;
          } else if (char === '\\') escaped = true;
          else if (char === '"') { inString = false; skeleton += '"'; }
          else if (char.charCodeAt(0) < 32) valid = false;
        } else {
          skeleton += char;
          if (char === '"') inString = true;
        }
        if (skeleton.length > 64 * 1024) valid = false;
      }
    };

    const consumeLine = (): void => {
      if (line.trim()) {
        try {
          if (!valid || inString || escaped || unicode) throw new Error('incomplete JSONL');
          JSON.parse(skeleton);
          const known = applyEntry(scan, line, oversized);
          if (known !== undefined) planStateKnown = known;
        } catch {
          // Native resume ignores malformed tails. Do not synthesize their
          // enabled flag or keep a previous local flag as authoritative.
          planStateKnown = false;
        }
      }
      line = ''; oversized = false; skeleton = '';
      inString = false; escaped = false; unicode = 0; valid = true;
    };

    const consume = (text: string): void => {
      let start = 0;
      while (start < text.length) {
        const newline = text.indexOf('\n', start);
        const part = text.slice(start, newline < 0 ? text.length : newline);
        validate(part);
        if (line.length + part.length > 64 * 1024) oversized = true;
        if (line.length < 64 * 1024) line += part.slice(0, 64 * 1024 - line.length);
        if (newline < 0) break;
        consumeLine();
        start = newline + 1;
      }
    };

    stream.on('data', (chunk: Buffer | string) => {
      consume(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    });
    stream.on('error', () => finish(null));
    stream.on('end', () => {
      consume(decoder.end());
      if (line.length) consumeLine();
      finish(planStateKnown ? scan : null);
    });
  });
}
