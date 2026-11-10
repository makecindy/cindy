/**
 * Chat endpoint: one prompt in, the repo's own agent events out as SSE.
 *
 * Events come from the shared queue and message persistence stream. The stream
 * ends on the product terminal event, so a client reconnect sees a real end
 * rather than a hang.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isSafeSessionPathSegment } from '../../desktop/src/main/sessionIds.ts';
import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';
import { isTerminalTurnErrorEvent } from '../../desktop/src/main/maker-ipc/sessionTurnActivityTracker.ts';
import { clientErrorMessage } from './client-error.mjs';

const MAX_PROMPT_CHARS = 100_000;

class BadRequest extends Error {}

function parseChatBody(raw) {
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    throw new BadRequest('body must be JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('body must be an object');
  const prompt = body.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new BadRequest('prompt is required');
  if (prompt.length > MAX_PROMPT_CHARS) throw new BadRequest('prompt is too long');
  if (body.agentKind !== undefined && body.agentKind !== 'claude-code' && body.agentKind !== 'codex' && body.agentKind !== 'pi' && body.agentKind !== 'cc') {
    throw new BadRequest('unsupported_agent');
  }
  const allowed = new Set(['prompt', 'sessionId', 'clientId', 'workDir', 'model', 'title', 'agentKind']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new BadRequest(`unknown field: ${key}`);
  }
  for (const key of ['sessionId', 'clientId']) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || !body[key] || body[key].length > 256)) {
      throw new BadRequest(`invalid ${key}`);
    }
  }
  if (body.sessionId && !isSafeSessionPathSegment(body.sessionId)) throw new BadRequest('invalid sessionId');
  if (body.workDir !== undefined && (typeof body.workDir !== 'string' || !path.isAbsolute(body.workDir))) {
    throw new BadRequest('workDir must be absolute');
  }
  return body;
}

/** Read the request body with a hard cap; the API is loopback-only and JSON. */
async function readBody(request, limitBytes = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw new BadRequest('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The streaming compatibility entry uses the same durable input service as the UI. */
export function createChatHandler(deps) {
  return async function handleChat(request, response) {
    let payload;
    try { payload = parseChatBody(await readBody(request)); }
    catch (error) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error instanceof BadRequest ? error.message : 'bad_request' }));
      return;
    }
    const sessionId = payload.sessionId ?? randomUUID();
    const clientId = payload.clientId ?? randomUUID();
    let unsubscribe = () => {};
    const cleanup = () => { unsubscribe(); unsubscribe = () => {}; };
    response.once('close', cleanup);
    const write = event => {
      if (!response.destroyed && !response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const end = () => {
      cleanup();
      if (!response.destroyed && !response.writableEnded) response.end('event: end\ndata: {}\n\n');
    };
    try {
      const stored = await deps.readSession(sessionId);
      if (!stored) await deps.createSession({ id: sessionId,
        ...(payload.workDir ? { workingDir: payload.workDir, workspaceKind: 'project' } : { workspaceKind: 'dialogue' }),
        model: payload.model ?? deps.defaultModel,
        agentKind: payload.agentKind ?? 'claude-code', title: payload.title,
      });
      else if (stored.status === 'deleted') throw new Error('session not found');
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store', connection: 'keep-alive',
      });
      write({ type: 'session', sessionId, clientId });
      unsubscribe = deps.events.subscribe(event => {
        if (event.type === 'auth_changed' && event.canEnterApp === false) { end(); return; }
        if (event.sessionId !== sessionId) return;
        // Queue projections and questions remain task-wide; model events must
        // belong to this exact input, not the turn ahead of it in the queue.
        if (event.inputClientId && event.inputClientId !== clientId) return;
        write(event);
        // Dispatch can fail after admission (session start, pre-send preparation).
        // The queue then keeps this input as the recoverable head and publishes
        // only a projection with an error: no agent terminal event will follow,
        // so release the stream with the same receipt a reconnect would get.
        const recovery = event.type === 'input_projection' ? event.projection?.recovery : null;
        if (recovery?.kind === 'queue-head' && recovery.clientId === clientId) {
          write({ type: 'input_receipt', sessionId, clientId, status: 'interrupted' });
          end();
          return;
        }
        if (event.inputClientId === clientId && event.turnScope !== 'background'
          && !isTurnContinuationBoundaryEvent(event)
          && (event.type === 'done' || isTerminalTurnErrorEvent(event))) end();
      });
      const projection = await deps.enqueue(sessionId, { clientId, text: payload.prompt });
      write({ type: 'input_projection', sessionId, projection });
      // A reconnect with the same clientId is idempotent. Previously recorded
      // input is not evidence of successful completion; history holds its result.
      const status = await deps.inputStatus(sessionId, clientId);
      if (status === 'recorded' || status === 'interrupted') {
        write({ type: 'input_receipt', sessionId, clientId, status });
        end();
      }
      // Return after durable admission. The SSE subscription owns the response,
      // and disconnecting the caller never aborts the accepted background work.
      if (response.destroyed || response.writableEnded) cleanup();
    } catch (error) {
      cleanup();
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/event-stream; charset=utf-8' });
      write({ type: 'error', reason: 'chat_failed', message: clientErrorMessage(error) });
      end();
    }
  };
}
