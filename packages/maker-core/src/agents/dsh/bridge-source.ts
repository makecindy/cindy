/** Runtime-only Cordis plugin. It replaces the upstream server to own resume/cancel state. */
export const DSH_BRIDGE_SOURCE = String.raw`import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
export const name = 'cindy-dsh-bridge';
export const inject = ['agents'];
export function apply(ctx) {
  const handles = new Map(); let route = null; let shuttingDown = false; const disposers = [];
  const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  const notify = (method, params) => send({ method, params });
  disposers.push(ctx.on('session/event', (session, event) => notify('session.event', { sessionId: String(session.id), event })));
  disposers.push(ctx.on('agent/status', ({ agent, status }) => notify('session.status', { sessionId: String(agent.session.id), status })));
  const agentOptions = () => ({ provider: route.provider, model: route.model, ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }) });
  const getOrCreate = async (sessionId) => {
    if (shuttingDown) throw new Error('dsh bridge is shutting down');
    const known = handles.get(sessionId); if (known) return known;
    const handle = await ctx.agents.create({ sessionId, meta: { cwd: route.cwd }, agentOptions: agentOptions() }); handles.set(sessionId, handle); return handle;
  };
  const request = async (method, params) => {
    if (method === 'initialize') { if (route) throw new Error('dsh bridge does not support reinitialize'); if (!params || typeof params.cwd !== 'string' || typeof params.provider !== 'string' || typeof params.model !== 'string') throw new Error('invalid initialize params'); route = params; return { serverInfo: { name: 'cindy-dsh-bridge', version: '0.1.0' } }; }
    if (!route) throw new Error('initialize must be called first');
    if (method === 'session/prompt') { const handle = await getOrCreate(params.sessionId); const message = { id: randomUUID(), role: 'user', content: params.contentBlocks, source: { kind: 'user' } }; handle.agent.followup(message); return { messageId: message.id }; }
    if (method === 'session/resume') { const id = params.sessionId; if (handles.has(id)) return { sessionId: id }; const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: agentOptions() }); handles.set(id, handle); return { sessionId: id }; }
    if (method === 'session/cancel') { const handle = handles.get(params.sessionId); if (!handle) return { accepted: false, wasRunning: false }; const wasRunning = handle.agent.status === 'running'; await handle.agent.cancel({ kind: 'user' }, { keepInbox: false }); return { accepted: true, wasRunning }; }
    if (method === 'shutdown') { shuttingDown = true; for (const dispose of disposers.splice(0)) dispose(); const all = [...handles.values()]; handles.clear(); await Promise.allSettled(all.map((handle) => handle.dispose())); return {}; }
    throw new Error('unknown dsh bridge method: ' + method);
  };
  let decoder = new StringDecoder('utf8'); let buffer = '';
  const onData = (chunk) => { buffer += decoder.write(chunk); for (;;) { const newline = buffer.indexOf('\n'); if (newline < 0) return; const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; let frame; try { frame = JSON.parse(line); } catch { continue; } if (!frame || typeof frame.id !== 'string' || typeof frame.method !== 'string') continue; Promise.resolve(request(frame.method, frame.params)).then((result) => { send({ id: frame.id, result }); if (frame.method === 'shutdown') setImmediate(() => { void ctx.root.fiber.dispose().finally(() => process.exit(0)); }); }, (error) => send({ id: frame.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })); } };
  process.stdin.on('data', onData); process.stdin.resume();
  ctx.effect(() => () => { process.stdin.off('data', onData); for (const dispose of disposers.splice(0)) dispose(); }, 'cindy-dsh-bridge');
}`;
