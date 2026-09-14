import http from 'node:http';

import { OLLAMA_LOOPBACK_ORIGIN } from '../../shared/localModelRuntime.js';

export const OLLAMA_PROBE_TIMEOUT_MS = 1_500;

export interface OllamaVersionInfo {
  version: string;
}

export interface OllamaTag {
  name: string;
  size?: number;
  digest?: string;
}

export interface OllamaShowInfo {
  contextLength?: number;
  capabilities?: string[];
  requires?: string;
}

export interface OllamaPullEvent {
  status: string;
  digest?: string;
  completed?: number;
  total?: number;
  error?: string;
}

export type OllamaFetch = (
  url: string,
  init: RequestInit & { redirect: 'manual'; signal: AbortSignal },
) => Promise<Response>;

export class OllamaHttpError extends Error {
  readonly kind: 'refused' | 'conflict' | 'http' | 'timeout' | 'invalid';

  constructor(kind: OllamaHttpError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

function loopbackUrl(path: string): string {
  return `${OLLAMA_LOOPBACK_ORIGIN}${path}`;
}

async function withTimeout(
  fetchImpl: OllamaFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new OllamaHttpError('timeout', `ollama request timed out: ${url}`);
    }
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
      throw new OllamaHttpError('refused', 'ollama is not reachable');
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/fetch failed|ECONNREFUSED|ECONNRESET/i.test(message)) {
      throw new OllamaHttpError('refused', 'ollama is not reachable');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function assertOllamaResponse(response: Response): void {
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new OllamaHttpError('conflict', 'port 11434 redirected away from Ollama');
  }
}

export async function fetchOllamaVersion(
  fetchImpl: OllamaFetch,
  timeoutMs = OLLAMA_PROBE_TIMEOUT_MS,
): Promise<OllamaVersionInfo> {
  const response = await withTimeout(
    fetchImpl,
    loopbackUrl('/api/version'),
    { method: 'GET' },
    timeoutMs,
  );
  assertOllamaResponse(response);
  if (!response.ok) {
    throw new OllamaHttpError('conflict', `port 11434 is not Ollama (HTTP ${response.status})`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OllamaHttpError('conflict', 'port 11434 did not return Ollama JSON');
  }
  const version =
    body && typeof body === 'object' && typeof (body as { version?: unknown }).version === 'string'
      ? (body as { version: string }).version.trim()
      : '';
  if (!version) {
    throw new OllamaHttpError('conflict', 'port 11434 response is not an Ollama version');
  }
  return { version };
}

export async function fetchOllamaTags(fetchImpl: OllamaFetch): Promise<OllamaTag[]> {
  const response = await withTimeout(fetchImpl, loopbackUrl('/api/tags'), { method: 'GET' }, 8_000);
  assertOllamaResponse(response);
  if (!response.ok) {
    throw new OllamaHttpError('http', `ollama /api/tags failed (${response.status})`);
  }
  const body = (await response.json()) as {
    models?: Array<{ name?: string; size?: number; digest?: string }>;
  };
  return (body.models ?? [])
    .filter(
      (model): model is { name: string; size?: number; digest?: string } =>
        typeof model.name === 'string',
    )
    .map((model) => ({
      name: model.name,
      size: model.size,
      digest: model.digest,
    }));
}

export async function deleteOllamaModel(fetchImpl: OllamaFetch, name: string): Promise<void> {
  const response = await withTimeout(
    fetchImpl,
    loopbackUrl('/api/delete'),
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name, name }),
    },
    8_000,
  );
  assertOllamaResponse(response);
  if (response.status === 404) return;
  if (!response.ok) {
    throw new OllamaHttpError('http', `ollama /api/delete failed (${response.status})`);
  }
}

export async function fetchOllamaShow(
  fetchImpl: OllamaFetch,
  name: string,
): Promise<OllamaShowInfo> {
  const response = await withTimeout(
    fetchImpl,
    loopbackUrl('/api/show'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    },
    8_000,
  );
  assertOllamaResponse(response);
  if (!response.ok) {
    throw new OllamaHttpError('http', `ollama /api/show failed (${response.status})`);
  }
  const body = (await response.json()) as {
    model_info?: Record<string, unknown>;
    details?: { context_length?: number };
    capabilities?: unknown;
    requires?: unknown;
  };
  const capabilities = Array.isArray(body.capabilities)
    ? body.capabilities.filter((value): value is string => typeof value === 'string')
    : undefined;
  const requires = typeof body.requires === 'string' ? body.requires : undefined;
  const fromDetails = body.details?.context_length;
  let contextLength: number | undefined;
  if (typeof fromDetails === 'number' && fromDetails > 0) {
    contextLength = fromDetails;
  } else {
    for (const [key, value] of Object.entries(body.model_info ?? {})) {
      if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
        contextLength = value;
        break;
      }
    }
  }
  return {
    ...(contextLength ? { contextLength } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(requires ? { requires } : {}),
  };
}

export function parseOllamaPullLine(line: string): OllamaPullEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as OllamaPullEvent;
  } catch {
    return null;
  }
}

/** 走 Node http，避免 Electron fetch 把 18GB 流缓冲完才回调。 */
export function streamOllamaPull(
  name: string,
  onEvent: (event: OllamaPullEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    if (signal?.aborted) {
      finish(new OllamaHttpError('invalid', 'aborted'));
      return;
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 11434,
        path: '/api/pull',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (response) => {
        if (!response.statusCode || response.statusCode >= 300) {
          finish(
            new OllamaHttpError('http', `ollama /api/pull failed (${response.statusCode ?? 0})`),
          );
          response.resume();
          return;
        }
        response.setEncoding('utf8');
        let buffer = '';
        let sawSuccess = false;
        const consume = (parsed: OllamaPullEvent) => {
          onEvent(parsed);
          if (parsed.error) {
            req.destroy();
            finish(new OllamaHttpError('invalid', parsed.error));
            return false;
          }
          if ((parsed.status ?? '').toLowerCase() === 'success') sawSuccess = true;
          return true;
        };
        response.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const parsed = parseOllamaPullLine(line);
            if (!parsed) continue;
            if (!consume(parsed)) return;
          }
        });
        response.on('end', () => {
          const parsed = parseOllamaPullLine(buffer);
          if (parsed && !consume(parsed)) return;
          if (signal?.aborted) {
            finish(new OllamaHttpError('invalid', 'aborted'));
            return;
          }
          if (!sawSuccess) {
            finish(new OllamaHttpError('invalid', 'ollama pull ended without success'));
            return;
          }
          finish();
        });
        response.on('error', (error) => {
          finish(
            signal?.aborted
              ? new OllamaHttpError('invalid', 'aborted')
              : new OllamaHttpError('refused', error.message),
          );
        });
      },
    );
    req.on('error', (error) => {
      if (signal?.aborted) {
        finish(new OllamaHttpError('invalid', 'aborted'));
        return;
      }
      const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
      finish(
        new OllamaHttpError(
          code === 'ECONNREFUSED' || code === 'ECONNRESET' ? 'refused' : 'http',
          error.message,
        ),
      );
    });
    const onAbort = () => {
      req.destroy();
      finish(new OllamaHttpError('invalid', 'aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.write(JSON.stringify({ name, stream: true }));
    req.end();
  });
}
