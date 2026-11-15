#!/usr/bin/env node
/** Standalone Node 22+ example. Uses only the published discovery file and HTTP API. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export class LocalAgentApiError extends Error {
  constructor(code, message) { super(message); this.name = 'LocalAgentApiError'; this.code = code; }
}

/** The code is an ephemeral loopback locator, never an application grant. */
export function parseConnectionCode(input) {
  if (typeof input !== 'string' || input.length > 256) throw new LocalAgentApiError('CONNECTION_CODE_INVALID', 'Invalid connection code.');
  const code = input.trim();
  if (/^cindy-local:v[0-9]+:/.test(code) && !code.startsWith('cindy-local:v1:'))
    throw new LocalAgentApiError('CONNECTION_CODE_UNSUPPORTED', 'Unsupported connection code version.');
  const match = /^cindy-local:v1:([1-9][0-9]{0,4}):([A-Za-z0-9_-]{43})$/.exec(code);
  if (!match || Number(match[1]) > 65535) throw new LocalAgentApiError('CONNECTION_CODE_INVALID', 'Invalid connection code.');
  return { protocol: 1, port: Number(match[1]), instance: match[2] };
}

async function readCapabilities(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new LocalAgentApiError('INVALID_REPLY', 'Missing capabilities reply.');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32 * 1024) throw new LocalAgentApiError('TOO_LARGE', 'Capabilities reply exceeds the limit.');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

/** Intentionally independent of Cindy/HHH packages; credentials live only in this process. */
export class LocalAgentClient {
  #base; #instance; #identity; #token; #development = false; #prefix = randomUUID(); #sequence = 0;
  constructor(discovery, identity) {
    if (discovery.protocol !== 1 || !Number.isInteger(discovery.port) || discovery.port < 1 || discovery.port > 65535
      || typeof discovery.instance !== 'string' || !discovery.instance) {
      throw new LocalAgentApiError('DISCOVERY_INVALID', 'Invalid v1 discovery file.');
    }
    this.#base = `http://127.0.0.1:${discovery.port}`;
    this.#instance = discovery.instance;
    this.#identity = identity;
  }
  static async discover(file, identity) {
    return new LocalAgentClient(JSON.parse(await fs.readFile(file, 'utf8')), identity);
  }
  static fromConnectionCode(code, identity) {
    const client = new LocalAgentClient(parseConnectionCode(code), identity);
    client.#development = true;
    return client;
  }
  async request(method, params = {}, { signal } = {}) {
    let response;
    try {
      response = await fetch(`${this.#base}/rpc`, {
        method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(method === 'capabilities' ? 750 : 30_000)]) : AbortSignal.timeout(method === 'capabilities' ? 750 : 30_000),
        headers: { 'Content-Type': 'application/json', ...(this.#token && method !== 'capabilities' ? { Authorization: `Bearer ${this.#token}` } : {}) },
        body: JSON.stringify({ version: 1, instance: this.#instance, id: `${this.#prefix}:${++this.#sequence}`, method, params }),
      });
      const reply = method === 'capabilities' ? await readCapabilities(response) : await response.json();
      if (reply.error) throw new LocalAgentApiError(reply.error.code, reply.error.message);
      if (!response.ok || !Object.hasOwn(reply, 'result')) throw new LocalAgentApiError('INVALID_REPLY', 'Invalid API reply.');
      if (method === 'capabilities') {
        if (reply.result?.protocol !== 1 || reply.result.instance !== this.#instance)
          throw new LocalAgentApiError('INSTANCE_CHANGED', 'The endpoint changed. Copy a new connection code.');
        if (this.#development) {
          const info = reply.result.instanceInfo;
          if (reply.result.features?.instanceMetadata !== true || !info)
            throw new LocalAgentApiError('INSTANCE_METADATA_UNSUPPORTED', 'This endpoint cannot identify its build.');
          if (info.kind !== 'development' || !['global', 'cn', 'dev'].includes(info.region))
            throw new LocalAgentApiError('INSTANCE_METADATA_MISMATCH', 'This connection code is not for a development build.');
        }
      }
      return reply.result;
    } catch (error) {
      if (error instanceof LocalAgentApiError) throw error;
      if (method === 'capabilities') throw new LocalAgentApiError('CONNECTION_UNAVAILABLE', 'The selected endpoint could not be verified.');
      // Never automatically resubmit a possibly accepted send/tool/control request.
      throw new LocalAgentApiError('RESULT_UNKNOWN', `The ${method} reply was not received. The request may have been accepted; it was not resent.`);
    }
  }
  async connect({ signal } = {}) {
    const caps = await this.request('capabilities', {}, { signal });
    if (!caps.features?.clientIdentity || !caps.features?.isolatedSessions) {
      throw new LocalAgentApiError('CAPABILITY_UNSUPPORTED', 'This example requires the generic local-client API.');
    }
    const pair = await this.request('connect/start', { client: this.#identity }, { signal });
    let claimed = false;
    try {
      const expires = Date.now() + 120_000;
      while (Date.now() < expires) {
        const reply = await this.request('connect/poll', { id: pair.id, claim: pair.claim }, { signal });
        if (reply.state === 'approved' && typeof reply.token === 'string') {
          this.#token = reply.token; claimed = true; return;
        }
        if (reply.state === 'denied') throw new LocalAgentApiError('CONNECTION_DENIED', 'Connection was not approved in Cindy.');
        await delay(200, undefined, { signal });
      }
      throw new LocalAgentApiError('PAIR_EXPIRED', 'Approve the connection in Cindy, then run the example again.');
    } finally {
      if (!claimed) await this.request('connect/cancel', { id: pair.id, claim: pair.claim }).catch(() => {});
    }
  }
  async disconnect() {
    if (!this.#token) return;
    await this.request('connect/revoke');
    this.#token = undefined;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    help: { type: 'boolean' }, discovery: { type: 'string' }, 'connection-code': { type: 'string' }, model: { type: 'string' }, provider: { type: 'string' },
    engine: { type: 'string' }, cwd: { type: 'string' }, prompt: { type: 'string' }, 'list-models': { type: 'boolean' },
    'native-tools': { type: 'boolean' }, 'client-id': { type: 'string' }, 'client-name': { type: 'string' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/examples/local-agent-client.mjs (--discovery <profile>/local-agent/discovery.json | --connection-code <code>) [--list-models] [--provider <id>] [--engine pi|codex|claude-code] [--model <opaque-id>] [--prompt <text>] [--cwd <folder>] [--native-tools] [--client-id <id>] [--client-name <name>]');
    return;
  }
  if (Boolean(values.discovery) === Boolean(values['connection-code'])) throw new LocalAgentApiError('DISCOVERY_REQUIRED', 'Pass exactly one of --discovery or --connection-code. No profiles are scanned.');
  const identity = {
    id: values['client-id'] ?? 'org.example.cindy-client', name: values['client-name'] ?? 'Independent API example', version: '1.0',
  };
  const client = values['connection-code'] ? LocalAgentClient.fromConnectionCode(values['connection-code'], identity)
    : await LocalAgentClient.discover(values.discovery, identity);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  const sessionId = 'example';
  let opened = false, finished = false;
  try {
    console.error('Approve this application in Cindy. The example does not save the connection token.');
    await client.connect({ signal: controller.signal });
    const { models } = await client.request('models', {}, { signal: controller.signal });
    const choices = models.filter(model => (!values.provider || model.provider === values.provider) && (!values.engine || model.engine === values.engine));
    if (values['list-models']) {
      for (const model of choices) console.log(JSON.stringify({ id: model.id, provider: model.provider, providerLabel: model.providerLabel, label: model.label, engine: model.engine }));
      return;
    }
    const model = values.model ? choices.find(model => model.id === values.model) : choices[0];
    if (!model) throw new LocalAgentApiError('MODEL_UNAVAILABLE', 'No model matches the requested source. List models and choose an available ID.');
    await client.request('session/open', {
      sessionId, cwd: path.resolve(values.cwd ?? process.cwd()), model: model.id,
      toolPolicy: values['native-tools'] ? 'native' : 'client-only',
      instructions: 'You are assisting an independent client. Use client_echo once, then explain its returned text.',
      tools: [{ name: 'client_echo', description: 'Echo text inside the calling application. No file or network side effects.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }],
    }, { signal: controller.signal });
    opened = true;
    await client.request('send', { sessionId, parts: [{ type: 'text', text: values.prompt ?? 'Call client_echo with text "Hello from an independent app", then quote its returned text.' }] }, { signal: controller.signal });
    let cursor = 0;
    while (!finished) {
      const batch = await client.request('events', { sessionId, cursor }, { signal: controller.signal });
      for (const entry of batch.events) {
        const event = entry.event;
        if (event.type === 'text') process.stdout.write(event.data);
        if (event.type === 'host_tool') {
          const call = event.data;
          const valid = call.name === 'client_echo' && typeof call.arguments?.text === 'string';
          await client.request('tool/reply', { sessionId, callId: call.id,
            text: valid ? JSON.stringify({ text: call.arguments.text }) : 'Unsupported client tool or arguments.', isError: !valid }, { signal: controller.signal });
        }
        if (event.type === 'turn_end') {
          finished = true;
          if (event.data.status !== 'completed') throw new LocalAgentApiError('TURN_INCOMPLETE', event.data.message || `Turn ${event.data.status}.`);
        }
      }
      cursor = batch.cursor;
    }
    process.stdout.write('\n');
  } finally {
    process.removeListener('SIGINT', stop);
    if (opened && !finished) await client.request('interrupt', { sessionId }).catch(() => {});
    if (opened) await client.request('session/close', { sessionId }).catch(() => {});
    // A one-shot example must not leave an unused persistent application grant.
    await client.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`${error.code ?? 'CLIENT_FAILED'}: ${error.message}`); process.exitCode = 1; });
}
