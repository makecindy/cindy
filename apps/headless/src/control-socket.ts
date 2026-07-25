import fs from 'node:fs/promises';
import net from 'node:net';
import type { ControlRequest, ControlResponse, HeadlessControlService } from './control-service.js';
import type { HeadlessSessionEvent, HeadlessSessionEventSource, HeadlessSessionEventStorage } from './session-types.js';

const MAX_REQUEST_BYTES = 1024 * 1024;

export class ControlSocketServer {
  private server: net.Server | null = null;

  constructor(
    private readonly socketFile: string,
    private readonly service: HeadlessControlService,
    private readonly events: HeadlessSessionEventStorage & HeadlessSessionEventSource,
  ) {}

  async start(): Promise<void> {
    await removeStaleSocket(this.socketFile);
    this.server = net.createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketFile, () => resolve());
    });
    await fs.chmod(this.socketFile, 0o600);
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
      this.server = null;
    }
    await removeStaleSocket(this.socketFile);
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
        socket.end(JSON.stringify(errorResponse('', 'REQUEST_TOO_LARGE', 'Control request exceeds 1 MiB')) + '\n');
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = '';
      void this.respond(socket, line);
    });
  }

  private async respond(socket: net.Socket, line: string): Promise<void> {
    let request: ControlRequest;
    try {
      request = JSON.parse(line) as ControlRequest;
      if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') throw new Error('Invalid request');
    } catch {
      socket.end(JSON.stringify(errorResponse('', 'INVALID_REQUEST', 'Control request must be JSON with id and method')) + '\n');
      return;
    }
    if (request.method === 'session.stream') {
      await this.streamSession(socket, request);
      return;
    }
    const response = await this.service.handle(request);
    socket.end(`${JSON.stringify(response)}\n`);
  }

  /**
   * Durable replay followed by live events for the terminal renderer.  The
   * event database remains the source of truth; the live listener only closes
   * the gap after the requested sequence cursor.
   */
  private async streamSession(socket: net.Socket, request: ControlRequest): Promise<void> {
    const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params as Record<string, unknown> : {};
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const afterSequence = typeof params.afterSequence === 'number' && Number.isInteger(params.afterSequence)
      && params.afterSequence >= 0 ? params.afterSequence : 0;
    if (!sessionId) {
      socket.end(`${JSON.stringify(errorResponse(request.id, 'BAD_REQUEST', 'sessionId is required for session.stream'))}\n`);
      return;
    }
    const session = await this.service.handle({ id: request.id, method: 'session.get', params: { sessionId } });
    if (!session.ok || !session.result) {
      socket.end(`${JSON.stringify(session.ok ? errorResponse(request.id, 'NOT_FOUND', `Unknown session: ${sessionId}`) : session)}\n`);
      return;
    }

    let lastSequence = afterSequence;
    let ready = false;
    const pending: HeadlessSessionEvent[] = [];
    const emit = (event: HeadlessSessionEvent): void => {
      if (event.sessionId !== sessionId || event.sequence <= lastSequence || socket.destroyed) return;
      lastSequence = event.sequence;
      socket.write(`${JSON.stringify({ type: 'event', event })}\n`);
    };
    const unsubscribe = this.events.onEvent((event) => {
      if (event.sessionId !== sessionId || event.sequence <= lastSequence) return;
      if (ready) emit(event); else pending.push(event);
    });
    const close = (): void => unsubscribe();
    socket.once('close', close);
    socket.once('error', close);
    try {
      const history = await this.events.listEvents(sessionId, afterSequence, 1_000);
      socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { stream: true } })}\n`);
      for (const event of history) emit(event);
      ready = true;
      pending.sort((a, b) => a.sequence - b.sequence).forEach(emit);
    } catch (error) {
      unsubscribe();
      if (!socket.destroyed) socket.end(`${JSON.stringify(errorResponse(request.id, 'STREAM_FAILED', error instanceof Error ? error.message : String(error)))}\n`);
    }
  }
}

export async function requestControl(socketFile: string, request: ControlRequest): Promise<ControlResponse> {
  return new Promise<ControlResponse>((resolve, reject) => {
    const socket = net.createConnection(socketFile);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as ControlResponse);
      } catch (error) {
        reject(error);
      }
      socket.end();
    });
  });
}

export type SessionEventSubscription = { close: () => void };
export type SessionEventSubscriptionHandlers = {
  onReady?: () => void;
  onEvent: (event: HeadlessSessionEvent) => void;
  onDisconnect: (error?: Error) => void;
};

/** Subscribe to the daemon's durable replay + live session event stream. */
export function subscribeSessionEvents(
  socketFile: string,
  sessionId: string,
  afterSequence: number,
  handlers: SessionEventSubscriptionHandlers,
): SessionEventSubscription {
  const socket = net.createConnection(socketFile);
  let buffer = '';
  let acknowledged = false;
  let closed = false;
  let notified = false;
  const disconnect = (error?: Error): void => {
    if (closed || notified) return;
    notified = true;
    handlers.onDisconnect(error);
  };
  socket.setEncoding('utf8');
  socket.on('connect', () => socket.write(`${JSON.stringify({
    id: `stream:${sessionId}`, method: 'session.stream', params: { sessionId, afterSequence },
  })}\n`));
  socket.on('error', (error) => disconnect(error));
  socket.on('close', () => disconnect());
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (!acknowledged) {
          if (frame.ok !== true) {
            const message = frame.error && typeof frame.error === 'object'
              ? (frame.error as { message?: unknown }).message : 'Session event stream was rejected';
            disconnect(new Error(typeof message === 'string' ? message : 'Session event stream was rejected'));
            socket.destroy();
            return;
          }
          acknowledged = true;
          handlers.onReady?.();
          continue;
        }
        if (frame.type === 'event' && frame.event && typeof frame.event === 'object') {
          handlers.onEvent(frame.event as HeadlessSessionEvent);
        }
      } catch (error) {
        disconnect(error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
        return;
      }
    }
  });
  return {
    close: () => {
      closed = true;
      socket.destroy();
    },
  };
}

async function removeStaleSocket(socketFile: string): Promise<void> {
  try {
    const entry = await fs.lstat(socketFile);
    if (!entry.isSocket()) throw new Error(`Refusing to remove non-socket control path: ${socketFile}`);
    await fs.unlink(socketFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function errorResponse(id: string, code: string, message: string): ControlResponse {
  return { id, ok: false, error: { code, message } };
}
