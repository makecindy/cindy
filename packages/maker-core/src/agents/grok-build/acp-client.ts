/**
 * ACP JSON-RPC 2.0 NDJSON client for Grok Build.
 *
 * Modeled on Codex app-server/client.ts but **includes** `jsonrpc: "2.0"`.
 * Incoming:
 *   - id + method  → agent→client request (`session/request_permission`)
 *   - method only  → notification (`session/update`)
 *   - id + result/error → response to our request
 */

import type { Logger } from '../../interfaces/logger.js';
import type { AcpTransport } from './stdio-transport.js';
import {
  ACP_JSONRPC_VERSION,
  ACP_PROTOCOL_VERSION,
  parseIncomingMessage,
  type AcpInitializeParams,
  type AcpInitializeResult,
  type AcpJsonRpcId,
  type AcpPermissionRequest,
  type AcpPermissionResponse,
  type AcpSessionNewParams,
  type AcpSessionNewResult,
  type AcpSessionPromptParams,
  type AcpSessionPromptResult,
  type AcpSessionUpdateNotification,
} from './types.js';

const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const INITIALIZE_TIMEOUT_MS = 15_000;

export class AcpRequestTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(`grok ACP ${method} timed out after ${timeoutMs}ms`);
    this.name = 'AcpRequestTimeoutError';
  }
}

export class AcpRpcError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number,
    message: string,
  ) {
    super(`grok ACP ${method} failed (${code}): ${message}`);
    this.name = 'AcpRpcError';
  }
}

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
};

export type AcpRequestHandler = (
  method: string,
  params: unknown,
  id: AcpJsonRpcId,
) => Promise<unknown>;

export type AcpNotificationHandler = (method: string, params: unknown) => void;

export interface AcpClientOptions {
  transport: AcpTransport;
  logger?: Logger;
  maxLineBytes?: number;
  defaultTimeoutMs?: number;
}

export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<AcpJsonRpcId, Pending>();
  private requestHandler: AcpRequestHandler | undefined;
  private notificationHandler: AcpNotificationHandler | undefined;
  private started = false;
  private closed = false;
  private readonly maxLineBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly logger?: Logger;
  private readonly transport: AcpTransport;

  constructor(opts: AcpClientOptions) {
    this.transport = opts.transport;
    this.logger = opts.logger;
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  start(): void {
    if (this.started) throw new Error('AcpClient: already started');
    if (this.closed) throw new Error('AcpClient: cannot start after close()');
    this.started = true;
    this.transport.onLine((line) => this.handleLine(line));
    this.transport.onStderr((line) => {
      this.logger?.debug('grok ACP stderr', { line: line.slice(0, 2_000) });
    });
    this.transport.onClose((info) => {
      void this.failAll(new Error(`grok ACP transport closed: ${info.reason}`));
    });
  }

  setRequestHandler(handler: AcpRequestHandler): void {
    this.requestHandler = handler;
  }

  onNotification(handler: AcpNotificationHandler): void {
    this.notificationHandler = handler;
  }

  async initialize(
    params: AcpInitializeParams = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: 'cindy', version: '0.0.0' },
    },
    timeoutMs = INITIALIZE_TIMEOUT_MS,
  ): Promise<AcpInitializeResult> {
    return this.request('initialize', params, timeoutMs) as Promise<AcpInitializeResult>;
  }

  async sessionNew(params: AcpSessionNewParams, timeoutMs?: number): Promise<AcpSessionNewResult> {
    return this.request('session/new', params, timeoutMs) as Promise<AcpSessionNewResult>;
  }

  async sessionPrompt(params: AcpSessionPromptParams, timeoutMs?: number): Promise<AcpSessionPromptResult> {
    return this.request('session/prompt', params, timeoutMs ?? 10 * 60_000) as Promise<AcpSessionPromptResult>;
  }

  async sessionCancel(sessionId: string): Promise<void> {
    await this.notify('session/cancel', { sessionId });
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) throw new Error(`AcpClient closed; cannot ${method}`);
    const id = this.nextId++;
    const wait = timeoutMs ?? this.defaultTimeoutMs;
    const payload = {
      jsonrpc: ACP_JSONRPC_VERSION,
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    const result = new Promise<unknown>((resolve, reject) => {
      const timeoutId = wait > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new AcpRequestTimeoutError(method, wait));
          }, wait)
        : null;
      this.pending.set(id, { method, resolve, reject, timeoutId });
    });
    try {
      await this.transport.writeLine(JSON.stringify(payload));
    } catch (err) {
      this.takePending(id);
      throw err;
    }
    return result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return;
    const payload = {
      jsonrpc: ACP_JSONRPC_VERSION,
      method,
      ...(params === undefined ? {} : { params }),
    };
    await this.transport.writeLine(JSON.stringify(payload));
  }

  async respond(id: AcpJsonRpcId, result: unknown): Promise<void> {
    if (this.closed) return;
    await this.transport.writeLine(JSON.stringify({
      jsonrpc: ACP_JSONRPC_VERSION,
      id,
      result,
    }));
  }

  async respondError(id: AcpJsonRpcId, code: number, message: string): Promise<void> {
    if (this.closed) return;
    await this.transport.writeLine(JSON.stringify({
      jsonrpc: ACP_JSONRPC_VERSION,
      id,
      error: { code, message },
    }));
  }

  async close(reason = 'client close'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error(`grok ACP closed: ${reason}`));
    await this.transport.close(reason);
  }

  private failAll(err: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    if (this.closed) return;
    if (line.length > this.maxLineBytes) {
      this.logger?.error('grok ACP line exceeded max size; closing', { bytes: line.length });
      void this.close('max line size exceeded');
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      this.logger?.warn('grok ACP ignored non-JSON line', {
        line: trimmed.slice(0, 200),
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const message = parseIncomingMessage(parsed);
    if (!message) {
      this.logger?.warn('grok ACP ignored malformed message', { line: trimmed.slice(0, 200) });
      return;
    }
    if ('method' in message && 'id' in message) {
      void this.dispatchRequest(message.method, message.params, message.id);
      return;
    }
    if ('method' in message) {
      this.notificationHandler?.(message.method, message.params);
      return;
    }
    if ('error' in message) {
      const pending = this.takePending(message.id);
      if (!pending) return;
      pending.reject(new AcpRpcError(pending.method, message.error.code, message.error.message));
      return;
    }
    const pending = this.takePending(message.id);
    pending?.resolve(message.result);
  }

  private takePending(id: AcpJsonRpcId): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    return pending;
  }

  private async dispatchRequest(method: string, params: unknown, id: AcpJsonRpcId): Promise<void> {
    const handler = this.requestHandler;
    if (!handler) {
      await this.respondError(id, -32601, `method not found: ${method}`);
      return;
    }
    try {
      const result = await handler(method, params, id);
      await this.respond(id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.respondError(id, -32000, message);
    }
  }
}

export type {
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpSessionUpdateNotification,
};
