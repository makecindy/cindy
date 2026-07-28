import type { ServerResponse } from 'node:http';

import { ChatSseTranslator } from './chat-sse-translator.js';
import { translateResponsesRequest } from './translate-request.js';
import {
  UnsupportedResponsesFeatureError,
  type ChatBridgeLogger,
  type ChatBridgeProviderConfig,
  type ResponsesChatBridgeHandler,
  type ResponsesRequest,
} from './types.js';

const MAX_ERROR_BODY_CHARS = 16 * 1024;
const MAX_SSE_BUFFER_CHARS = 1024 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * 写一条 OpenAI Responses SSE 事件。协议要求 **`event: <type>` 行 + `data:` 行**,且 data 里带
 * 全响应连续递增的 `sequence_number` —— codex app-server 按 `event:` 行分发事件类型,缺了会
 * 静默丢弃整条流(界面无输出、agent 事件流为空)。sequenceNumber 由 handler 统一维护注入,
 * 保持 translator 纯净。
 */
function writeSse(res: ServerResponse, event: unknown, sequenceNumber: number): void {
  if (!isPlainObject(event) || typeof event.type !== 'string') return;
  const payload = { ...event, sequence_number: sequenceNumber };
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
}

function joinUrl(base: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const queryIndex = normalizedPath.indexOf('?');
  const pathname = queryIndex === -1 ? normalizedPath : normalizedPath.slice(0, queryIndex);
  const hasEncodedPathSeparator = /%(?:2f|5c)/i.test(pathname);
  const hasDotSegment = pathname
    .split('/')
    .some((segment) => {
      const normalizedDots = segment.replace(/%2e/gi, '.');
      return normalizedDots === '.' || normalizedDots === '..';
    });
  if (
    normalizedPath.length > 2_048
    || normalizedPath.startsWith('//')
    || normalizedPath.includes('#')
    || normalizedPath.includes('\\')
    || /[^\u0021-\u007e]/.test(normalizedPath)
    || !/^\/[A-Za-z0-9\-._~%!$&()*+,;=:@/?]*$/.test(normalizedPath)
    || /%(?![0-9A-Fa-f]{2})/.test(normalizedPath)
    || hasEncodedPathSeparator
    || hasDotSegment
  ) {
    throw new TypeError('invalid chat completions path');
  }
  const url = new URL(base);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
  ) {
    throw new TypeError('invalid upstream base URL');
  }
  const pathQuery = queryIndex === -1 ? '' : normalizedPath.slice(queryIndex + 1);
  const baseQuery = url.search.slice(1);
  url.pathname = `${trimTrailingSlashes(url.pathname)}${pathname}`;
  url.search = [baseQuery, pathQuery].filter(Boolean).join('&');
  url.hash = '';
  return url.toString();
}

function responsesError(status: number, code: string, message: string): Record<string, unknown> {
  return {
    error: {
      type: status === 401 || status === 403 ? 'authentication_error' :
        status === 429 ? 'rate_limit_error' :
          status >= 500 ? 'server_error' : 'invalid_request_error',
      code,
      message,
    },
  };
}

async function readErrorText(upstream: Response): Promise<string> {
  try {
    return (await upstream.text()).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return '';
  }
}

export interface ResponsesChatHandlerOptions {
  logger?: ChatBridgeLogger;
  fetchImpl?: typeof fetch;
}

/** Create an in-process Responses-to-Chat handler for one resolved provider runtime. */
export function createResponsesChatHandler(
  provider: ChatBridgeProviderConfig,
  opts: ResponsesChatHandlerOptions = {},
): ResponsesChatBridgeHandler {
  const log = opts.logger ?? {};
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async handle({ parsedBody, res }): Promise<void> {
      if (!isPlainObject(parsedBody) || typeof parsedBody.model !== 'string') {
        writeJson(res, 400, responsesError(400, 'invalid_request', 'invalid Responses request body'));
        return;
      }
      const request = parsedBody as ResponsesRequest;
      const realModel = provider.rewriteModel?.(request.model) ?? request.model;
      let chatRequest;
      try {
        chatRequest = translateResponsesRequest(request, {
          model: realModel,
          capabilities: provider.capabilities,
          onDroppedTool: (type, index) => {
            log.warn?.('responses-chat bridge dropped non-function tool', { type, index });
          },
          onDroppedInputItem: (type, index) => {
            // tool_search_* 是 Codex 每轮重放的历史内建 item，属于预期兼容路径，
            // 不发 warn 避免随会话长度二次增长日志。
            log.debug?.('responses-chat bridge dropped built-in input item', { type, index });
          },
        });
      } catch (error) {
        if (error instanceof UnsupportedResponsesFeatureError) {
          log.warn?.('responses-chat bridge rejected unsupported feature', {
            model: request.model,
            feature: error.feature,
          });
          writeJson(res, 400, responsesError(400, 'unsupported_feature', error.message));
          return;
        }
        throw error;
      }

      let upstreamUrl: string;
      try {
        upstreamUrl = joinUrl(
          provider.upstreamBase,
          provider.chatCompletionsPath ?? '/chat/completions',
        );
      } catch (error) {
        log.error?.('responses-chat bridge invalid upstream configuration', {
          model: request.model,
          error: error instanceof Error ? error.message : String(error),
        });
        writeJson(
          res,
          502,
          responsesError(502, 'invalid_upstream_config', 'provider upstream configuration is invalid'),
        );
        return;
      }

      let providerHeaders: Record<string, string>;
      try {
        providerHeaders = await provider.buildHeaders();
      } catch (error) {
        log.error?.('responses-chat bridge auth unavailable', {
          model: request.model,
          error: error instanceof Error ? error.message : String(error),
        });
        writeJson(res, 502, responsesError(502, 'authentication_unavailable', 'provider authentication is unavailable'));
        return;
      }

      const abort = new AbortController();
      const abortUpstream = (): void => abort.abort();
      res.once('close', abortUpstream);
      let upstream: Response;
      try {
        upstream = await fetchImpl(upstreamUrl, {
          method: 'POST',
          headers: {
            ...providerHeaders,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify(chatRequest),
          signal: abort.signal,
        });
      } catch (error) {
        res.off('close', abortUpstream);
        if (abort.signal.aborted) return;
        log.warn?.('responses-chat bridge upstream unreachable', {
          model: request.model,
          error: error instanceof Error ? error.message : String(error),
        });
        writeJson(res, 502, responsesError(502, 'upstream_unreachable', 'provider upstream is unreachable'));
        return;
      }

      const reportUpstreamError = async (status: number, body: string): Promise<void> => {
        if (!provider.onUpstreamError) return;
        try {
          await provider.onUpstreamError({ status, body, requestHeaders: providerHeaders });
        } catch (error) {
          log.warn?.('responses-chat bridge onUpstreamError failed', {
            model: request.model,
            status,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      if (!upstream.ok || !upstream.body) {
        const text = await readErrorText(upstream);
        await reportUpstreamError(upstream.status, text);
        res.off('close', abortUpstream);
        writeJson(
          res,
          upstream.status,
          responsesError(upstream.status, 'upstream_error', text || `provider returned HTTP ${upstream.status}`),
        );
        return;
      }

      const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('text/event-stream')) {
        const text = await readErrorText(upstream);
        log.warn?.('responses-chat bridge upstream returned non-SSE response', {
          model: request.model,
          status: upstream.status,
          contentType: contentType || 'missing',
        });
        res.off('close', abortUpstream);
        writeJson(
          res,
          502,
          responsesError(502, 'invalid_upstream_response', text || 'provider did not return a streaming SSE response'),
        );
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const translator = new ChatSseTranslator(request.model);
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamFailed = false;
      // 全响应连续递增的 SSE sequence_number（Responses 协议要求）。
      let seq = 0;
      const emit = (output: unknown): void => {
        writeSse(res, output, seq++);
      };
      const parseDataPayload = (payload: string): void => {
        if (!payload) return;
        if (payload === '[DONE]') {
          translator.markTerminal();
          return;
        }
        let event: unknown;
        try {
          event = JSON.parse(payload);
        } catch {
          throw new Error('upstream SSE data frame is malformed');
        }
        const streamedError = isPlainObject(event) && isPlainObject(event.error)
          ? event.error
          : null;
        if (streamedError) {
          const message = typeof streamedError.message === 'string'
            ? streamedError.message
            : 'provider returned an error event';
          void reportUpstreamError(
            typeof streamedError.status === 'number' ? streamedError.status : 502,
            JSON.stringify(streamedError).slice(0, MAX_ERROR_BODY_CHARS),
          );
          for (const output of translator.fail(message)) emit(output);
          return;
        }
        for (const output of translator.push(event)) emit(output);
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let start = 0;
          let newline: number;
          while ((newline = buffer.indexOf('\n', start)) >= 0) {
            const line = buffer.slice(start, newline).replace(/\r$/, '');
            start = newline + 1;
            if (!line.startsWith('data:')) continue;
            parseDataPayload(line.slice(5).trim());
          }
          if (start > 0) buffer = buffer.slice(start);
          if (buffer.length > MAX_SSE_BUFFER_CHARS) {
            throw new Error('upstream SSE line exceeds 1 MiB');
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
          for (const line of buffer.split(/\r?\n/)) {
            if (line.startsWith('data:')) parseDataPayload(line.slice(5).trim());
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          streamFailed = true;
          const message = error instanceof Error ? error.message : String(error);
          log.warn?.('responses-chat bridge stream failed', { model: request.model, error: message });
          for (const output of translator.fail(message)) emit(output);
        }
      } finally {
        res.off('close', abortUpstream);
        if (!streamFailed && !abort.signal.aborted) {
          for (const output of translator.finish(true)) emit(output);
        }
        res.end();
      }
    },
  };
}
