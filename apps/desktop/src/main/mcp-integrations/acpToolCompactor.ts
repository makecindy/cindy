/**
 * ACP-only MCP `tools/list` response compactor.
 *
 * Antigravity CLI (`agy` 1.5.x) splits MCP tools across all connected servers
 * into Eager vs Lazy by sorting smallest-first against a global serialized
 * schema byte budget (~52 KB raw JSON). Cindy's built-in MCP servers ship rich
 * multi-paragraph Chinese/English tool & parameter descriptions (~180 KB total),
 * which causes large core tools (`create_worker`, `create_workers`, `start_team`,
 * `send_to_worker`, `ghost_forge_install`, `cindy_browser/call_tool`,
 * `cindy_ssh/call_tool`) to be pushed into `Lazy`.
 *
 * This module is ONLY invoked on HTTP MCP `tools/list` responses for ACP
 * sessions (`activeContext.acpCompactTools === true`). It NEVER affects Claude
 * Code, Codex, or Pi, and NEVER alters tool names or `inputSchema` validation
 * structure (`type`, `properties`, `required`, `enum`, `items`, `format`, etc.).
 */

import type http from 'node:http';

const DEFAULT_MAX_TOOL_DESCRIPTION_CHARS = 120;

export function compactAcpToolDescription(
  text: string,
  maxChars = DEFAULT_MAX_TOOL_DESCRIPTION_CHARS,
): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  const slice = normalized.slice(0, maxChars);
  const minBoundary = Math.floor(maxChars * 0.45);
  for (const sep of ['。', '. ', '；', '; ']) {
    const idx = slice.lastIndexOf(sep);
    if (idx >= minBoundary) {
      return slice.slice(0, idx + sep.length).trim();
    }
  }
  return `${slice.trimEnd()}…`;
}

export function compactAcpInputSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => compactAcpInputSchema(item));
  }
  if (!node || typeof node !== 'object') return node;
  const record = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'description' || key === '$schema' || key === 'title') continue;
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        props[propName] = compactAcpInputSchema(propSchema);
      }
      out[key] = props;
    } else if (key === 'items') {
      out[key] = compactAcpInputSchema(value);
    } else if (
      (key === 'anyOf' || key === 'oneOf' || key === 'allOf') &&
      Array.isArray(value)
    ) {
      out[key] = value.map((item) => compactAcpInputSchema(item));
    } else {
      out[key] = value;
    }
  }
  return out;
}

function compactSingleRpcPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const rpc = payload as Record<string, unknown>;
  const result = rpc.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return payload;
  const resultObj = result as Record<string, unknown>;
  if (!Array.isArray(resultObj.tools)) return payload;
  const compactedTools = resultObj.tools.map((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
    const t = tool as Record<string, unknown>;
    return {
      ...t,
      ...(typeof t.description === 'string'
        ? { description: compactAcpToolDescription(t.description) }
        : {}),
      ...(t.inputSchema !== undefined
        ? { inputSchema: compactAcpInputSchema(t.inputSchema) }
        : {}),
    };
  });
  return {
    ...rpc,
    result: {
      ...resultObj,
      tools: compactedTools,
    },
  };
}

export function compactAcpToolsListPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    return payload.map((item) => compactSingleRpcPayload(item));
  }
  return compactSingleRpcPayload(payload);
}

export function isToolsListRpcBody(parsedBody: unknown): boolean {
  if (!parsedBody || typeof parsedBody !== 'object') return false;
  if (Array.isArray(parsedBody)) {
    return parsedBody.some(
      (item) =>
        item &&
        typeof item === 'object' &&
        (item as { method?: unknown }).method === 'tools/list',
    );
  }
  return (parsedBody as { method?: unknown }).method === 'tools/list';
}

function transformBodyText(body: string, contentType: string): string {
  const lowerType = contentType.toLowerCase();
  if (lowerType.includes('text/event-stream')) {
    return body
      .split('\n')
      .map((line) => {
        if (!line.startsWith('data:')) return line;
        const jsonPart = line.slice(5).trim();
        if (!jsonPart) return line;
        try {
          const parsed: unknown = JSON.parse(jsonPart);
          const compacted = compactAcpToolsListPayload(parsed);
          return `data: ${JSON.stringify(compacted)}`;
        } catch {
          return line;
        }
      })
      .join('\n');
  }
  try {
    const parsed: unknown = JSON.parse(body);
    const compacted = compactAcpToolsListPayload(parsed);
    return JSON.stringify(compacted);
  } catch {
    return body;
  }
}

/**
 * Intercepts a single `tools/list` HTTP response from StreamableHTTPServerTransport,
 * compacts tool descriptions/schema metadata, adjusts `Content-Length`, and flushes
 * to the underlying `ServerResponse`.
 */
export function wrapResponseForAcpToolsListCompaction(
  res: http.ServerResponse,
): http.ServerResponse {
  const chunks: Buffer[] = [];
  let pendingHead: { statusCode: number; statusMessage?: string; headers?: http.OutgoingHttpHeaders } | null = null;
  let flushed = false;

  const toBuffer = (chunk: unknown, encoding?: BufferEncoding): Buffer => {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (typeof chunk === 'string') return Buffer.from(chunk, encoding ?? 'utf8');
    if (chunk instanceof Uint8Array) return Buffer.from(chunk);
    return Buffer.from(String(chunk), 'utf8');
  };

  const flushToReal = (cb?: () => void): void => {
    if (flushed) {
      cb?.();
      return;
    }
    flushed = true;
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const contentTypeHeader =
      pendingHead?.headers?.['content-type'] ??
      pendingHead?.headers?.['Content-Type'] ??
      res.getHeader('content-type') ??
      '';
    const contentType = Array.isArray(contentTypeHeader)
      ? contentTypeHeader.join('; ')
      : String(contentTypeHeader);

    const outBuf = Buffer.from(transformBodyText(rawBody, contentType), 'utf8');
    if (pendingHead) {
      const headers: http.OutgoingHttpHeaders = { ...(pendingHead.headers ?? {}) };
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'content-length') delete headers[k];
      }
      if (!contentType.toLowerCase().includes('text/event-stream')) {
        headers['content-length'] = String(outBuf.byteLength);
      }
      if (pendingHead.statusMessage !== undefined) {
        res.writeHead(pendingHead.statusCode, pendingHead.statusMessage, headers);
      } else {
        res.writeHead(pendingHead.statusCode, headers);
      }
    } else if (res.hasHeader('content-length')) {
      res.setHeader('content-length', String(outBuf.byteLength));
    }
    res.end(outBuf, cb);
  };

  return new Proxy(res, {
    get(target, prop, receiver) {
      if (prop === 'writeHead') {
        return (
          statusCode: number,
          statusMessageOrHeaders?: string | http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
          maybeHeaders?: http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
        ) => {
          if (typeof statusMessageOrHeaders === 'string') {
            pendingHead = {
              statusCode,
              statusMessage: statusMessageOrHeaders,
              headers: (maybeHeaders as http.OutgoingHttpHeaders | undefined) ?? undefined,
            };
          } else {
            pendingHead = {
              statusCode,
              headers: (statusMessageOrHeaders as http.OutgoingHttpHeaders | undefined) ?? undefined,
            };
          }
          return receiver;
        };
      }
      if (prop === 'write') {
        return (chunk: unknown, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
          const enc = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
          const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
          if (chunk !== undefined && chunk !== null) {
            chunks.push(toBuffer(chunk, enc));
          }
          callback?.();
          return true;
        };
      }
      if (prop === 'end') {
        return (chunk?: unknown, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void) => {
          if (typeof chunk === 'function') {
            flushToReal(chunk as () => void);
            return receiver;
          }
          const enc = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
          const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
          if (chunk !== undefined && chunk !== null) {
            chunks.push(toBuffer(chunk, enc));
          }
          flushToReal(callback);
          return receiver;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
