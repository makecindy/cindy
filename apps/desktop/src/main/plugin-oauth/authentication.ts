import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import {
  PLUGIN_OAUTH_TTL_MS,
  oauthExact,
  oauthNonce,
  parsePluginOauthHello,
  parsePluginOauthHelloReply,
  parsePluginOauthRequest,
  type PluginOauthAction,
  type PluginOauthHello,
  type PluginOauthHelloReply,
  type PluginOauthPublicIdentity,
  type PluginOauthPeerIdentity,
  type PluginOauthRequest,
} from '@cindy/device-link';
import { OauthBox } from './box.js';
import type { OauthCardBinding } from './transactions.js';
import type { OauthIdentityScope, OauthSigningKey } from './identityStore.js';

const fail = () => new Error('OAUTH_BRIDGE_UNAVAILABLE');
const nonce = () => randomBytes(32).toString('base64url');
const sameAction = (a: PluginOauthAction, b: PluginOauthAction) =>
  a.requestId === b.requestId &&
  a.actionId === b.actionId &&
  a.expectedRevision === b.expectedRevision;
const domain = (id: string) => `authenticated-plugin-oauth-v3:${id}`;

/** Persistent signing key with a new boot identifier; ephemeral keys remain per handshake. */
export class OauthHostIdentity {
  private readonly pair;
  readonly descriptor: PluginOauthPublicIdentity;
  constructor(stored?: OauthSigningKey) {
    // Production supplies the secure store key. In-memory identities are useful to protocol tests.
    this.pair = stored
      ? {
          privateKey: createPrivateKey({
            key: Buffer.from(stored.privateKey, 'base64url'),
            type: 'pkcs8',
            format: 'der',
          }),
          publicKey: createPublicKey({
            key: Buffer.from(stored.publicKey, 'base64url'),
            type: 'spki',
            format: 'der',
          }),
        }
      : generateKeyPairSync('ed25519');
    this.descriptor = {
      version: 1,
      bootId: randomUUID(),
      publicKey: this.pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    };
  }
  sign(transcript: Buffer): string {
    return sign(null, transcript, this.pair.privateKey).toString('base64url');
  }
}
function transcript(
  hello: PluginOauthHello,
  reply: Omit<PluginOauthHelloReply, 'signature'>,
  target: OauthIdentityScope & { publicKey: string },
  peer: string,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      'cindy-plugin-oauth-authentication-v3',
      target.realm,
      target.membershipId,
      target.deviceId,
      peer,
      target.publicKey,
      reply.bootId,
      hello.nonce,
      hello.publicKey,
      reply.publicKey,
      reply.id,
      reply.expiresAtMs,
      hello.action.requestId,
      hello.action.actionId,
      hello.action.expectedRevision,
      reply.ghostId,
    ]),
  );
}
interface Connection {
  id: string;
  peer: string;
  owner: string;
  hello: PluginOauthHello;
  key: OauthBox;
  expiresAtMs: number;
  binding: OauthCardBinding;
  started: boolean;
  finished: boolean;
  innerId?: string;
  messages: Map<string, { box: string; promise: Promise<unknown> }>;
}
export class AuthenticatedOauthHost {
  private readonly connections = new Map<string, Connection>();
  private generation = 0;
  private readonly peerGenerations = new Map<string, number>();
  constructor(
    private readonly deps: {
      owner(): string | null;
      available(peer: string): boolean;
      identity():
        | (OauthIdentityScope & { key: OauthHostIdentity })
        | null
        | Promise<(OauthIdentityScope & { key: OauthHostIdentity }) | null>;
      bind(action: PluginOauthAction): Promise<OauthCardBinding | null>;
      request(peer: string, raw: unknown): Promise<unknown>;
      now?: () => number;
    },
  ) {}
  invalidate(peer?: string): void {
    if (peer) this.peerGenerations.set(peer, (this.peerGenerations.get(peer) ?? 0) + 1);
    else {
      this.generation++;
      this.peerGenerations.clear();
    }
    for (const [id, c] of this.connections)
      if (!peer || c.peer === peer) this.connections.delete(id);
  }
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private assertCurrent(c: Connection): void {
    if (
      this.connections.get(c.id) !== c ||
      c.owner !== this.deps.owner() ||
      !this.deps.available(c.peer) ||
      this.now() >= c.expiresAtMs
    )
      throw fail();
  }
  async request(peer: string, raw: unknown): Promise<unknown> {
    const owner = this.deps.owner(),
      startGeneration = this.generation,
      startPeer = this.peerGenerations.get(peer) ?? 0;
    if (!owner || !this.deps.available(peer)) throw fail();
    const identity = await this.deps.identity();
    if (
      !owner ||
      !identity ||
      this.deps.owner() !== owner ||
      !this.deps.available(peer) ||
      startGeneration !== this.generation ||
      startPeer !== (this.peerGenerations.get(peer) ?? 0)
    )
      throw fail();
    if ((raw as { op?: unknown })?.op === 'identity') {
      const request = oauthExact(raw, ['op', 'version']);
      if (request.version !== 3) throw fail();
      const observedAtMs = this.now();
      return {
        ...identity.key.descriptor,
        realm: identity.realm,
        deviceId: identity.deviceId,
        membershipId: identity.membershipId,
        observedAtMs,
        expiresAtMs: observedAtMs + 60_000,
      };
    }
    for (const [id, c] of this.connections)
      if (this.now() >= c.expiresAtMs || c.owner !== owner) this.connections.delete(id);
    if ((raw as { op?: unknown })?.op === 'hello') {
      const hello = parsePluginOauthHello(raw);
      for (const [id, c] of this.connections) if (c.finished) this.connections.delete(id);
      if (
        this.connections.size >= 16 ||
        [...this.connections.values()].filter((c) => c.peer === peer).length >= 4
      )
        throw fail();
      const generation = this.generation,
        peerGeneration = this.peerGenerations.get(peer) ?? 0;
      const binding = await this.deps.bind(hello.action);
      const currentIdentity = await this.deps.identity();
      if (
        !binding?.current() ||
        this.deps.owner() !== owner ||
        !this.deps.available(peer) ||
        generation !== this.generation ||
        peerGeneration !== (this.peerGenerations.get(peer) ?? 0) ||
        currentIdentity?.key !== identity.key ||
        this.connections.size >= 16 ||
        [...this.connections.values()].filter((c) => c.peer === peer).length >= 4
      )
        throw fail();
      const key = new OauthBox(),
        id = randomUUID(),
        expiresAtMs = this.now() + PLUGIN_OAUTH_TTL_MS;
      key.seal(hello.publicKey, domain(id), 'offer', {}); // validate X25519 before any authorization side effect
      const reply = {
        version: 3 as const,
        id,
        publicKey: key.publicKey,
        bootId: identity.key.descriptor.bootId,
        ghostId: binding.ghostId,
        expiresAtMs,
      };
      this.connections.set(id, {
        id,
        peer,
        owner,
        hello,
        key,
        expiresAtMs,
        binding,
        started: false,
        finished: false,
        messages: new Map(),
      });
      return {
        ...reply,
        signature: identity.key.sign(
          transcript(
            hello,
            reply,
            { ...identity, publicKey: identity.key.descriptor.publicKey },
            peer,
          ),
        ),
      };
    }
    const v = oauthExact(raw, ['op', 'id', 'box']);
    if (v.op !== 'exchange' || typeof v.id !== 'string' || typeof v.box !== 'string') throw fail();
    const c = this.connections.get(v.id);
    if (!c || c.peer !== peer) throw fail();
    this.assertCurrent(c);
    const payload = oauthExact(c.key.open(c.hello.publicKey, domain(c.id), 'callback', v.box), [
      'nonce',
      'request',
    ]);
    const request = parsePluginOauthRequest(payload.request);
    if (!oauthNonce(payload.nonce) || !request) throw fail();
    const prior = c.messages.get(payload.nonce);
    if (prior) {
      if (prior.box !== v.box) throw fail();
      return prior.promise;
    }
    if (c.messages.size >= 1024) throw fail();
    if (request.op === 'start') {
      if (c.started || !sameAction(request, c.hello.action) || !c.binding.current()) throw fail();
      c.started = true;
    } else if (request.op !== 'capabilities' && (!c.innerId || request.id !== c.innerId))
      throw fail();
    const requestNonce = payload.nonce;
    const promise = (async () => {
      try {
        this.assertCurrent(c);
        const result = await this.deps.request(peer, request);
        this.assertCurrent(c);
        if (request.op === 'start') {
          const id = (result as { id?: unknown })?.id;
          if (typeof id !== 'string') throw fail();
          c.innerId = id;
        }
        if (
          request.op === 'cancel' ||
          ['succeeded', 'failed', 'cancelled', 'expired'].includes(
            String((result as { phase?: unknown })?.phase),
          )
        )
          c.finished = true;
        return {
          box: c.key.seal(c.hello.publicKey, domain(c.id), 'offer', {
            nonce: requestNonce,
            ok: true,
            result,
          }),
        };
      } catch {
        this.assertCurrent(c);
        return {
          box: c.key.seal(c.hello.publicKey, domain(c.id), 'offer', {
            nonce: requestNonce,
            ok: false,
          }),
        };
      }
    })();
    c.messages.set(requestNonce, { box: v.box, promise });
    return promise;
  }
}

/** Verify the signed handshake before sending start or opening any authorization page. No legacy identity/channel fallback. */
export async function authenticateOauthController(deps: {
  target: PluginOauthPeerIdentity;
  trustIdentity(target: PluginOauthPeerIdentity, assertCurrent: () => void): Promise<void>;
  peer: string;
  action: PluginOauthAction;
  ghostId: string;
  invoke(raw: unknown): Promise<unknown>;
  assertCurrent(): void;
  now?: () => number;
}): Promise<(request: PluginOauthRequest) => Promise<unknown>> {
  const now = deps.now ?? Date.now;
  deps.assertCurrent();
  if (
    deps.target.observedAtMs > now() + 1000 ||
    now() - deps.target.observedAtMs > 60_000 ||
    deps.target.expiresAtMs <= now() ||
    deps.target.expiresAtMs > deps.target.observedAtMs + 60_000
  )
    throw fail();
  const key = new OauthBox();
  const hello: PluginOauthHello = {
    op: 'hello',
    version: 3,
    nonce: nonce(),
    publicKey: key.publicKey,
    action: deps.action,
  };
  const reply = parsePluginOauthHelloReply(await deps.invoke(hello));
  deps.assertCurrent();
  const pub = createPublicKey({
    key: Buffer.from(deps.target.publicKey, 'base64url'),
    type: 'spki',
    format: 'der',
  });
  if (
    deps.target.expiresAtMs <= now() ||
    pub.asymmetricKeyType !== 'ed25519' ||
    reply.bootId !== deps.target.bootId ||
    reply.ghostId !== deps.ghostId ||
    reply.expiresAtMs <= now() ||
    reply.expiresAtMs > now() + PLUGIN_OAUTH_TTL_MS + 1000 ||
    !verify(
      null,
      transcript(hello, reply, deps.target, deps.peer),
      pub,
      Buffer.from(reply.signature, 'base64url'),
    )
  )
    throw fail();
  await deps.trustIdentity(deps.target, deps.assertCurrent);
  deps.assertCurrent();
  return async (request) => {
    if (request.op !== 'cancel') deps.assertCurrent();
    if (now() >= reply.expiresAtMs) throw fail();
    const requestNonce = nonce();
    const response = oauthExact(
      await deps.invoke({
        op: 'exchange',
        id: reply.id,
        box: key.seal(reply.publicKey, domain(reply.id), 'callback', {
          nonce: requestNonce,
          request,
        }),
      }),
      ['box'],
    );
    if (request.op !== 'cancel') deps.assertCurrent();
    if (typeof response.box !== 'string') throw fail();
    const opened = key.open(reply.publicKey, domain(reply.id), 'offer', response.box) as {
      ok?: unknown;
    };
    const value = oauthExact(
      opened,
      opened?.ok === true ? ['nonce', 'ok', 'result'] : ['nonce', 'ok'],
    );
    if (value.nonce !== requestNonce || value.ok !== true) throw fail();
    return value.result;
  };
}
