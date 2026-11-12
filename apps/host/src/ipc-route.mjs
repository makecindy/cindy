/**
 * Generic route for registered desktop IPC channels: `POST /api/ipc/<channel>`.
 *
 * The registry (`@cindy/maker-shared/host-ipc-registry`) is the contract; this
 * module binds it to Node handlers and enforces admission in a fixed order:
 * caller audience, Host instance, registration, contract fingerprint, owner,
 * arguments. Results are dropped when the owner changes while a handler runs.
 * A result that does not match the registered shape is still returned but
 * logged as `result_mismatch`, so a handler that quietly grows a field shows up.
 * The log detail is the checker's position string, which names object property
 * keys (`result[0].title is not part of the contract`) but never values. That
 * is safe only while no registered schema has an object keyed by user data
 * (ids, paths, names as keys); an entry that adds one must log the position
 * without those keys.
 *
 * Handlers get the checked arguments only; a proxy timeout does not cancel
 * them. Add a handler context before binding writes or long reads.
 *
 * Deliberately served by the HTTP server only. Device Link dispatches through
 * `service.mjs` and never reaches this table, so remote callers stay out of it
 * until remote admission exists on the Host.
 */

import {
  HOST_INSTANCE_HEADER,
  HOST_IPC_CONTRACT_HEADER,
  HOST_IPC_ENTRIES,
  HOST_IPC_PROTOCOL,
  HOST_IPC_REJECTION,
  checkHostIpcArgs,
  checkHostIpcValue,
  hostIpcFingerprint,
  isHostIpcOwnerStamp,
} from '@cindy/maker-shared/host-ipc-registry';

const CODED_ERROR = /^\[([A-Z][A-Z0-9_]*)\] ([\s\S]*)$/;
const STATUS_BY_CODE = {
  INVALID_PARAMS: 400, PERMISSION_DENIED: 403, NOT_FOUND: 404, PRECONDITION_FAILED: 409,
  OWNER_CHANGED: 409, UNSUPPORTED_CAPABILITY: 501,
};

const reject = (status, code, message) => ({ status, body: { ok: false, error: { code, message } } });

/** Caller category from the credential, never from the request. */
function callerAudience(caller) {
  return typeof caller === 'string' && caller.startsWith('local-api:') ? 'local' : 'other';
}

const sameOwner = (a, b) => a.dataOwnerId === b.dataOwnerId && a.ownerGeneration === b.ownerGeneration;

/** Typed `[CODE] message` errors keep their contract; anything else is not serialised. */
function handlerFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  const match = error instanceof Error ? CODED_ERROR.exec(error.message) : null;
  if (code && match && match[1] === code) return reject(STATUS_BY_CODE[code] ?? 500, code, match[2]);
  return reject(500, 'INTERNAL', 'Host handler failed');
}

/**
 * @param {{
 *   instanceId?: string,
 *   bindings: Record<string, (args: unknown[]) => unknown>,
 *   unsupported?: readonly string[],
 *   entries?: readonly import('@cindy/maker-shared/host-ipc-registry').HostIpcEntry[],
 *   readOwnerStamp: () => { dataOwnerId: string | null, ownerGeneration: number },
 *   isOwnerBoundaryPending?: () => boolean,
 *   log?: (event: { channel: string, caller: string, outcome: string, ms: number, detail?: string }) => void,
 *   now?: () => number,
 * }} deps
 */
export function createHostIpcRoute(deps) {
  const entries = deps.entries ?? HOST_IPC_ENTRIES;
  const byChannel = new Map(entries.map(entry => [entry.channel, entry]));
  const unsupported = new Set(deps.unsupported ?? []);
  // Every registered entry is either bound here or declared unsupported (and
  // answers UNSUPPORTED); an empty success is never an option.
  for (const entry of entries) {
    const bound = Object.prototype.hasOwnProperty.call(deps.bindings, entry.channel);
    if (bound === unsupported.has(entry.channel)) {
      throw new Error(`Host IPC entry ${entry.channel} must be bound or declared unsupported, not ${bound ? 'both' : 'neither'}`);
    }
  }
  for (const channel of [...Object.keys(deps.bindings), ...unsupported]) {
    if (!byChannel.has(channel)) throw new Error(`Host IPC binding ${channel} is not a registered entry`);
  }
  const fingerprints = new Map(entries.map(entry => [entry.channel, hostIpcFingerprint(entry)]));
  const now = deps.now ?? Date.now;
  const ownerStamp = () => (deps.isOwnerBoundaryPending?.() ? null : deps.readOwnerStamp());

  async function admit({ channel, caller, headers, body }) {
    // Before any lookup: a caller outside every audience learns nothing about
    // which channels exist.
    if (callerAudience(caller) !== 'local') return reject(403, HOST_IPC_REJECTION.audienceDenied, 'Caller is not allowed');
    const instance = headers[HOST_INSTANCE_HEADER];
    if (typeof instance !== 'string' || !instance) {
      return reject(428, HOST_IPC_REJECTION.instanceRequired, 'Host instance header is required');
    }
    if (!deps.instanceId || instance !== deps.instanceId) {
      return reject(409, HOST_IPC_REJECTION.instanceChanged, 'Host instance changed');
    }
    const entry = byChannel.get(channel);
    if (!entry) return reject(404, HOST_IPC_REJECTION.channelUnknown, 'Channel is not registered');
    if (!entry.audience.includes('local')) return reject(403, HOST_IPC_REJECTION.audienceDenied, 'Caller is not allowed');
    if (unsupported.has(channel)) return reject(501, HOST_IPC_REJECTION.channelUnsupported, 'Channel is not served by this Host');
    if (headers[HOST_IPC_CONTRACT_HEADER] !== fingerprints.get(channel)) {
      return reject(409, HOST_IPC_REJECTION.contractMismatch, 'Channel contract differs on this Host');
    }
    if (!isHostIpcOwnerStamp(body?.owner)) return reject(400, 'INVALID_PARAMS', 'owner stamp is required');
    const ingress = ownerStamp();
    if (!ingress || !sameOwner(ingress, body.owner)) {
      return reject(409, HOST_IPC_REJECTION.ownerScopeChanged, 'Active account changed');
    }
    const problem = checkHostIpcArgs(entry, body.args);
    if (problem) return reject(400, 'INVALID_PARAMS', problem);
    let result;
    try {
      result = await deps.bindings[channel](body.args);
    } catch (error) {
      return handlerFailure(error);
    }
    // A read that straddled an account switch belongs to neither account.
    const egress = ownerStamp();
    if (!egress || !sameOwner(ingress, egress)) {
      return reject(409, HOST_IPC_REJECTION.ownerScopeChanged, 'Active account changed');
    }
    // Names the field, never the value.
    const mismatch = checkHostIpcValue(entry.result, result, 'result');
    return { status: 200, body: { ok: true, result }, ...(mismatch ? { mismatch } : {}) };
  }

  return {
    /** Negotiation only: Host-side admission still applies to every call. */
    manifest() {
      return {
        protocol: HOST_IPC_PROTOCOL,
        instanceId: deps.instanceId ?? '',
        entries: entries
          .filter(entry => !unsupported.has(entry.channel) && entry.audience.includes('local'))
          .map(entry => ({ channel: entry.channel, fingerprint: fingerprints.get(entry.channel) })),
      };
    },
    /** Never logs arguments or results. */
    async handle(request) {
      const started = now();
      const { mismatch, ...response } = await admit(request);
      deps.log?.({
        channel: byChannel.has(request.channel) ? request.channel : '(unregistered)',
        caller: callerAudience(request.caller),
        outcome: mismatch ? 'result_mismatch' : response.body.ok ? 'ok' : response.body.error.code,
        ms: now() - started,
        ...(mismatch ? { detail: mismatch } : {}),
      });
      return response;
    },
  };
}
