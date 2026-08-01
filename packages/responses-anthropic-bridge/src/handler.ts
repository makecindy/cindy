import type { ServerResponse } from 'node:http';

import { normalizeAnthropicImages, requestHasInlineImage } from './anthropic-images.js';
import { AnthropicSseTranslator } from './responses-sse-translator.js';
import { translateResponsesRequest } from './translate-request.js';
import {
  InvalidResponsesRequestError,
  type ResponsesAnthropicHandler,
  type ResponsesAnthropicLogger,
  type ResponsesAnthropicProviderConfig,
  type ResponsesRequest,
  UnsupportedResponsesFeatureError,
} from './types.js';

const MAX_ERROR_BODY_BYTES = 16 * 1024;
const MAX_STREAM_BUFFER_BYTES = 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
}

export function joinAnthropicMessagesUrl(base: string, requestPath: string): string {
  const url = new URL(base);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
  ) {
    throw new TypeError('invalid upstream base URL');
  }
  const path = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  if (
    path.length > 2048
    || path.startsWith('//')
    || path.includes('\\')
    || path.includes('#')
    || /[^\u0021-\u007e]/.test(path)
    || /%(?:2f|5c)/i.test(path)
    || /%(?![0-9A-Fa-f]{2})/.test(path)
    || path.split('/').some((segment) => segment.replace(/%2e/gi, '.') === '..')
  ) {
    throw new TypeError('invalid Anthropic messages path');
  }
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const pathQuery = queryIndex === -1 ? '' : path.slice(queryIndex + 1);
  const baseQuery = url.search.slice(1);
  // Provider forms commonly store an Anthropic base as either `https://host` or
  // `https://host/v1`. The default `/v1/messages` path must not become `/v1/v1/messages`;
  // preserve other base path prefixes (for example `/api/v1`) when joining.
  const basePath = pathname.startsWith('/v1/')
    || pathname === '/v1'
    ? url.pathname.replace(/\/v1\/?$/, '')
    : url.pathname;
  url.pathname = `${trimTrailingSlashes(basePath)}${pathname}`;
  url.search = [baseQuery, pathQuery].filter(Boolean).join('&');
  url.hash = '';
  return url.toString();
}

function responsesError(status: number, code: string, message: string): Record<string, unknown> {
  return {
    error: {
      type: status === 401 || status === 403
        ? 'authentication_error'
        : status === 429
          ? 'rate_limit_error'
          : status >= 500 ? 'server_error' : 'invalid_request_error',
      code,
      message,
    },
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function writeSse(res: ServerResponse, event: unknown, sequenceNumber: number): void {
  if (!isObject(event) || typeof event.type !== 'string') return;
  const payload = { ...event, sequence_number: sequenceNumber };
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function readBody(response: Response): Promise<string> {
  try {
    return await readBodyWithLimit(response, MAX_ERROR_BODY_BYTES);
  } catch {
    return '';
  }
}

async function readBodyWithLimit(
  response: Response,
  limitBytes: number,
  limitMessage?: string,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limitBytes - bytesRead;
      if (value.byteLength > remaining) {
        if (limitMessage) throw new Error(limitMessage);
        if (remaining > 0) {
          body += decoder.decode(value.subarray(0, remaining), { stream: true });
        }
        await reader.cancel();
        body += decoder.decode();
        return body;
      }
      bytesRead += value.byteLength;
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Best effort only: preserve the original parse/limit failure.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): unknown | null {
  const data: string[] = [];
  let eventName = '';
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    else if (line.startsWith('event:')) eventName = line.slice(6).trim();
  }
  if (data.length === 0) return null;
  const payload = data.join('\n').trim();
  if (!payload || payload === '[DONE]') return null;
  const parsed = JSON.parse(payload) as unknown;
  if (eventName && isObject(parsed) && typeof parsed.type !== 'string') {
    return { ...parsed, type: eventName };
  }
  return parsed;
}

function upstreamRequestHeaders(providerHeaders: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(providerHeaders)) {
    normalized[name.toLowerCase()] = value;
  }
  normalized['anthropic-version'] ??= '2023-06-01';
  normalized['content-type'] = 'application/json';
  // Native Anthropic SDKs request application/json even when stream:true; the body
  // flag selects SSE. Strict Messages gateways reject event-stream Accept with 406.
  normalized.accept = 'application/json';
  return normalized;
}

export interface ResponsesAnthropicHandlerOptions {
  logger?: ResponsesAnthropicLogger;
  fetchImpl?: typeof fetch;
}

export function createResponsesAnthropicHandler(
  provider: ResponsesAnthropicProviderConfig,
  options: ResponsesAnthropicHandlerOptions = {},
): ResponsesAnthropicHandler {
  const log = options.logger ?? {};
  const fetchImpl = options.fetchImpl ?? fetch;
  const upstreamBase = trimTrailingSlashes(provider.upstreamBase);

  return {
    async handle({ parsedBody, res }): Promise<void> {
      if (!isObject(parsedBody) || typeof parsedBody.model !== 'string') {
        writeJson(res, 400, responsesError(400, 'invalid_request', 'invalid Responses request body'));
        return;
      }
      const incoming = parsedBody as ResponsesRequest;
      const realModel = provider.rewriteModel?.(incoming.model) ?? incoming.model;
      let translated;
      try {
        translated = translateResponsesRequest(incoming, {
          model: realModel,
          defaultMaxTokens: provider.defaultMaxTokens,
          supportsAdaptiveThinking: provider.supportsAdaptiveThinking,
          supportsThinking: provider.supportsThinking,
          promptCaching: provider.promptCaching,
          automaticPromptCaching: provider.automaticPromptCaching,
          strictTools: provider.strictTools,
          authMode: provider.authMode,
        });
      } catch (error) {
        if (error instanceof UnsupportedResponsesFeatureError || error instanceof InvalidResponsesRequestError) {
          log.warn?.('responses-anthropic bridge rejected unsupported feature', {
            model: incoming.model,
            feature: error instanceof UnsupportedResponsesFeatureError ? error.feature : 'invalid_request',
          });
          writeJson(
            res,
            400,
            responsesError(
              400,
              error instanceof InvalidResponsesRequestError
                ? 'invalid_request'
                : 'unsupported_feature',
              error.message,
            ),
          );
          return;
        }
        throw error;
      }

      let upstreamUrl: string;
      try {
        upstreamUrl = joinAnthropicMessagesUrl(upstreamBase, provider.requestPath ?? '/v1/messages');
      } catch (error) {
        log.error?.('responses-anthropic bridge invalid upstream configuration', {
          model: incoming.model,
          error: error instanceof Error ? error.message : String(error),
        });
        writeJson(res, 502, responsesError(502, 'invalid_upstream_config', 'provider upstream configuration is invalid'));
        return;
      }

      const abort = new AbortController();
      const abortUpstream = (): void => abort.abort();
      res.once('close', abortUpstream);
      let providerHeaders: Record<string, string> = {};
      let upstream: Response | null = null;
      let imageTierBias = 0;
      let imageRetried = false;
      let authRetried = false;
      let retryHeaders: Record<string, string> | null = null;
      const hasInlineImage = requestHasInlineImage(translated.request.messages);

      for (;;) {
        if (imageTierBias > 0) {
          translated = translateResponsesRequest(incoming, {
            model: realModel,
            defaultMaxTokens: provider.defaultMaxTokens,
            supportsAdaptiveThinking: provider.supportsAdaptiveThinking,
            supportsThinking: provider.supportsThinking,
            promptCaching: provider.promptCaching,
            automaticPromptCaching: provider.automaticPromptCaching,
            strictTools: provider.strictTools,
            authMode: provider.authMode,
          });
        }
        await normalizeAnthropicImages(translated.request.messages, {
          codec: provider.imageCodec,
          tierBias: imageTierBias,
        });
        try {
          providerHeaders = retryHeaders ?? await provider.buildHeaders();
        } catch (error) {
          res.off('close', abortUpstream);
          log.error?.('responses-anthropic bridge auth unavailable', {
            model: incoming.model,
            error: error instanceof Error ? error.message : String(error),
          });
          writeJson(res, 502, responsesError(502, 'authentication_unavailable', 'provider authentication is unavailable'));
          return;
        }
        try {
          upstream = await fetchImpl(upstreamUrl, {
            method: 'POST',
            headers: upstreamRequestHeaders(providerHeaders),
            body: JSON.stringify(translated.request),
            signal: abort.signal,
          });
        } catch (error) {
          res.off('close', abortUpstream);
          if (abort.signal.aborted) return;
          log.warn?.('responses-anthropic bridge upstream unreachable', {
            model: incoming.model,
            error: error instanceof Error ? error.message : String(error),
          });
          writeJson(res, 502, responsesError(502, 'upstream_unreachable', 'provider upstream is unreachable'));
          return;
        }

        if (
          upstream.status === 401
          || upstream.status === 403
        ) {
          const body = await readBody(upstream);
          if (
            !authRetried
            && provider.refreshHeaders
          ) {
            authRetried = true;
            let refreshed: Record<string, string> | null = null;
            try {
              refreshed = await provider.refreshHeaders({
                status: upstream.status,
                body,
                requestHeaders: providerHeaders,
              });
            } catch (error) {
              log.warn?.('responses-anthropic bridge auth refresh failed', {
                model: incoming.model,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            if (refreshed) {
              // Keep the rotated credential for any subsequent image-size retry in
              // this same request. Falling back to buildHeaders() could re-read the
              // stale route snapshot and turn a 401→413 recovery into a final 401.
              retryHeaders = refreshed;
              continue;
            }
          }
          // The final error path below reports the already-consumed body.
          upstream = new Response(body, { status: upstream.status, headers: upstream.headers });
        } else if (
          upstream.status === 413
          && !imageRetried
          && hasInlineImage
          && provider.imageCodec
        ) {
          await readBody(upstream);
          imageRetried = true;
          imageTierBias = 1;
          continue;
        }
        break;
      }
      if (!upstream) {
        res.off('close', abortUpstream);
        writeJson(res, 502, responsesError(502, 'upstream_unreachable', 'provider request did not return a response'));
        return;
      }

      const reportUpstreamError = async (status: number, body: string): Promise<void> => {
        if (!provider.onUpstreamError) return;
        try {
          await provider.onUpstreamError({ status, body, requestHeaders: providerHeaders });
        } catch (error) {
          log.warn?.('responses-anthropic bridge onUpstreamError failed', {
            model: incoming.model,
            status,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      if (!upstream.ok || !upstream.body) {
        const body = await readBody(upstream);
        await reportUpstreamError(upstream.status, body);
        res.off('close', abortUpstream);
        const status = upstream.ok ? 502 : upstream.status;
        writeJson(
          res,
          status,
          responsesError(
            status,
            upstream.ok ? 'upstream_empty_response' : 'upstream_error',
            body || (
              upstream.ok
                ? 'provider returned a successful response without a body'
                : `provider returned HTTP ${upstream.status}`
            ),
          ),
        );
        return;
      }

      const translator = new AnthropicSseTranslator(incoming.model, translated.toolContext);
      let sequence = 0;
      const collected: unknown[] = [];
      const emit = (event: unknown): void => {
        if (incoming.stream === false) collected.push(event);
        else writeSse(res, event, sequence++);
      };
      if (incoming.stream !== false) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
      }
      const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? '';

      try {
        if (contentType.includes('application/json')) {
          const body = await readBodyWithLimit(
            upstream,
            MAX_STREAM_BUFFER_BYTES,
            'upstream JSON response exceeds 1 MiB',
          );
          const json = JSON.parse(body) as unknown;
          for (const event of translator.pushJson(json)) emit(event);
        } else if (incoming.stream === false) {
          // Some Anthropic-compatible gateways omit Content-Type. Buffering is already
          // required for a non-streaming caller, so sniff JSON first and otherwise
          // aggregate the unmarked Anthropic SSE body, with the same hard cap used
          // while sniffing streaming responses.
          const body = await readBodyWithLimit(
            upstream,
            MAX_STREAM_BUFFER_BYTES,
            'upstream response exceeds 1 MiB',
          );
          const trimmed = body.trimStart();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            const json = JSON.parse(body) as unknown;
            for (const event of translator.pushJson(json)) emit(event);
          } else {
            let buffer = body;
            let terminal = false;
            const consume = (block: string): void => {
              let event: unknown;
              try {
                event = parseSseBlock(block);
              } catch {
                throw new Error('upstream SSE frame is malformed');
              }
              if (!event) return;
              if (isObject(event) && event.type === 'message_stop') terminal = true;
              for (const output of translator.push(event)) emit(output);
            };
            let boundary: number;
            while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
              const block = buffer.slice(0, boundary);
              if (utf8ByteLength(block) > MAX_STREAM_BUFFER_BYTES) {
                throw new Error('upstream SSE frame exceeds 1 MiB');
              }
              const separator = buffer.slice(boundary).startsWith('\r\n\r\n') ? 4 : 2;
              buffer = buffer.slice(boundary + separator);
              consume(block);
            }
            if (utf8ByteLength(buffer) > MAX_STREAM_BUFFER_BYTES) {
              throw new Error('upstream SSE frame exceeds 1 MiB');
            }
            if (buffer.trim()) consume(buffer);
            if (!terminal) for (const output of translator.finish()) emit(output);
          }
        } else {
          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let receivedBytes = 0;
          let terminal = false;
          let bodyKind: 'unknown' | 'json' | 'sse' = 'unknown';
          const consume = (block: string): void => {
            let event: unknown;
            try {
              event = parseSseBlock(block);
            } catch {
              throw new Error('upstream SSE frame is malformed');
            }
            if (!event) return;
            if (isObject(event) && event.type === 'message_stop') terminal = true;
            for (const output of translator.push(event)) emit(output);
          };
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              receivedBytes += value.byteLength;
              buffer += decoder.decode(value, { stream: true });
              if (bodyKind === 'unknown') {
                const trimmed = buffer.trimStart();
                if (trimmed.startsWith('{') || trimmed.startsWith('[')) bodyKind = 'json';
                else if (trimmed.length > 0) bodyKind = 'sse';
              }
              if (bodyKind === 'json') {
                if (receivedBytes > MAX_STREAM_BUFFER_BYTES) {
                  throw new Error('upstream JSON response exceeds 1 MiB');
                }
                continue;
              }
              let boundary: number;
              while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
                const block = buffer.slice(0, boundary);
                if (utf8ByteLength(block) > MAX_STREAM_BUFFER_BYTES) {
                  throw new Error('upstream SSE frame exceeds 1 MiB');
                }
                const separator = buffer.slice(boundary).startsWith('\r\n\r\n') ? 4 : 2;
                buffer = buffer.slice(boundary + separator);
                consume(block);
              }
              if (utf8ByteLength(buffer) > MAX_STREAM_BUFFER_BYTES) {
                throw new Error('upstream SSE frame exceeds 1 MiB');
              }
            }
            buffer += decoder.decode();
          } catch (error) {
            try {
              await reader.cancel();
            } catch {
              // Preserve the original parse/limit failure.
            }
            throw error;
          }
          if (bodyKind === 'unknown') {
            const trimmed = buffer.trimStart();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) bodyKind = 'json';
            else if (trimmed.length > 0) bodyKind = 'sse';
          }
          if (bodyKind === 'json') {
            if (receivedBytes > MAX_STREAM_BUFFER_BYTES) {
              throw new Error('upstream JSON response exceeds 1 MiB');
            }
            const json = JSON.parse(buffer) as unknown;
            for (const output of translator.pushJson(json)) emit(output);
          } else {
            if (utf8ByteLength(buffer) > MAX_STREAM_BUFFER_BYTES) {
              throw new Error('upstream SSE frame exceeds 1 MiB');
            }
            if (buffer.trim()) consume(buffer);
            if (!terminal) for (const output of translator.finish()) emit(output);
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          log.warn?.('responses-anthropic bridge stream failed', {
            model: incoming.model,
            error: message,
          });
          if (incoming.stream === false && !res.headersSent) {
            writeJson(res, 502, responsesError(502, 'upstream_stream_error', message));
            return;
          }
          for (const output of translator.fail(message)) emit(output);
        }
      } finally {
        res.off('close', abortUpstream);
        if (incoming.stream === false && !res.headersSent) {
          const terminal = [...collected].reverse().find((event) => (
            isObject(event)
            && (
              event.type === 'response.completed'
              || event.type === 'response.incomplete'
              || event.type === 'response.failed'
            )
          ));
          if (isObject(terminal) && terminal.response) {
            writeJson(res, 200, terminal.response);
          } else {
            writeJson(res, 502, responsesError(502, 'upstream_empty_response', 'provider returned no Responses result'));
          }
        }
        if (incoming.stream !== false || !res.headersSent) res.end();
      }
    },
  };
}
