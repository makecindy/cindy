/**
 * Chat endpoint: one prompt in, the repo's own agent events out as SSE.
 *
 * Events are forwarded verbatim from `Session.onEvent` (the same projection the
 * Desktop consumes); this module adds no second event vocabulary. The stream
 * ends on the product terminal event, so a client reconnect sees a real end
 * rather than a hang.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

const MAX_PROMPT_CHARS = 100_000;

class BadRequest extends Error {}

function toMakerAgentKind(kind) {
  if (kind === 'codex') return 'codex';
  if (kind === 'pi') return 'pi';
  return 'claude-code';
}

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
  const allowed = new Set(['prompt', 'sessionId', 'workDir', 'model', 'title', 'agentKind']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new BadRequest(`unknown field: ${key}`);
  }
  return body;
}

/** Read the request body with a hard cap; the API is loopback-only and JSON. */
function readBody(request, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new BadRequest('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * @param {{maker: any, defaultWorkDir: string}} deps
 */
export function createChatHandler(deps) {
  return async function handleChat(request, response) {
    let payload;
    try {
      payload = parseChatBody(await readBody(request));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error instanceof BadRequest ? error.message : 'bad_request' }));
      return;
    }

    const sessionId = typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId : randomUUID();
    // Only absolute, existing directories are accepted as a workdir; the host
    // never invents one from a request-supplied relative path.
    const workDir = typeof payload.workDir === 'string' && path.isAbsolute(payload.workDir)
      ? payload.workDir
      : deps.defaultWorkDir;

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const write = (event) => {
      if (response.writableEnded) return;
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    let session;
    let unsubscribe = () => {};
    try {
      const stored = deps.readSession ? await deps.readSession(sessionId) : null;
      const rawKind = stored?.agentKind || payload.agentKind || 'claude-code';
      session = deps.maker.getSession(sessionId) ?? await deps.maker.createSession({
        agentKind: toMakerAgentKind(rawKind),
        id: sessionId,
        workingDir: stored?.workingDir || workDir,
        model: stored?.model || (typeof payload.model === 'string' ? payload.model : deps.defaultModel),
        providerId: stored?.providerId ?? undefined,
        resumeSessionId: stored?.sdkSessionId || undefined,
        effort: stored?.effort || undefined,
        permissionMode: stored?.permissionMode || undefined,
        fastMode: stored?.fastMode ?? undefined,
        planMode: stored?.planModeEnabled ?? undefined,
        title: typeof payload.title === 'string' ? payload.title : undefined,
      });
      // Tool calls need a resolver: without one the session denies every request
      // as `no_listener_attached`. The broker publishes it on the event stream and
      // resolves it from `POST /api/interactions/respond`.
      deps.interactions?.attach(session, session.id);
      write({ type: 'session', sessionId: session.id });

      let finished = false;
      const done = new Promise((resolve) => {
        unsubscribe = session.onEvent((event) => {
          write(event);
          const terminal = event.type === 'done' || (event.type === 'error' && event.turnScope !== 'background');
          if (terminal && !finished) {
            finished = true;
            resolve();
          }
        });
      });

      const result = await session.send(payload.prompt);
      // Session accepts with `{ accepted: true }`; anything else means the turn
      // never started and the client must see that instead of an empty stream.
      if (!result || result.accepted !== true) {
        write({ type: 'error', reason: 'send_rejected', detail: result ?? null });
        unsubscribe();
        response.end();
        return;
      }
      deps.onSessionSent?.(sessionId);
      await done;
      unsubscribe();
      response.write('event: end\ndata: {}\n\n');
      response.end();
    } catch (error) {
      unsubscribe();
      write({ type: 'error', reason: 'chat_failed', message: error instanceof Error ? error.message : String(error) });
      response.end();
    }
  };
}
