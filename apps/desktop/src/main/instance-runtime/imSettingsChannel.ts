import {
  CLOUD_IM_SETTINGS_CHANNEL,
  CLOUD_IM_SETTINGS_MAX_BYTES,
  cloudImSettingsRequestSchema,
  type CloudImSettingsReply,
} from '../../shared/cloudImSettings.js';
import type { SettingsOwnerStamp } from '../../shared/hostSettings.js';
import type { ManagementExecution } from '../host-settings/management.js';

export interface ImSettingsChannelDeps {
  /** The managed instance exists and its signed-in member is the instance owner. */
  isInstanceOwner(): boolean;
  owner(): SettingsOwnerStamp | null;
  /** Native IM handlers through the closed cloud management call set. */
  call(channel: string, args: unknown[], execution: ManagementExecution): Promise<unknown>;
  timeoutMs?: number;
}

const fail = (code: string, message: string): never => {
  throw new Error(`[${code}] ${message}`);
};

/** Saved credentials never leave the instance: status replies keep only `has…` facts. */
const SECRET_KEY = /secret|token|password|webhook/i;
function redactSecrets(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) =>
      SECRET_KEY.test(key) && !/^has[A-Z]/.test(key) && typeof entry === 'string' ? [key, null] : [key, entry],
    ),
  );
}

/**
 * The owner's cloud settings page runs the local IM settings handlers of this instance. The
 * request names one call from the shared closed list; handler errors keep their `[CODE]`, and
 * the reply carries the owner generation so the page drops answers for a previous account.
 */
export function createImSettingsChannel(deps: ImSettingsChannelDeps) {
  const ownerAtIngress = (): SettingsOwnerStamp => {
    if (!deps.isInstanceOwner()) fail('PERMISSION_DENIED', 'not the instance owner');
    return deps.owner() ?? fail('OWNER_CHANGED', 'the instance account is changing');
  };
  const execution = (owner: SettingsOwnerStamp): ManagementExecution => {
    const signal = AbortSignal.timeout(deps.timeoutMs ?? 30_000);
    return {
      signal,
      assertCurrent() {
        if (signal.aborted) fail('TIMEOUT', 'request timed out');
        const now = deps.isInstanceOwner() ? deps.owner() : null;
        if (
          !now ||
          now.dataOwnerId !== owner.dataOwnerId ||
          now.ownerGeneration !== owner.ownerGeneration
        )
          fail('OWNER_CHANGED', 'the instance account changed');
      },
      prompt() {
        fail('UNSUPPORTED', 'IM authorization uses the cloud authorization page');
      },
      onCancel(cancel) {
        signal.addEventListener('abort', cancel, { once: true });
      },
    };
  };
  return {
    channel: CLOUD_IM_SETTINGS_CHANNEL,
    async handle(_controller: string, raw: unknown): Promise<CloudImSettingsReply> {
      const owner = ownerAtIngress();
      const parsed = cloudImSettingsRequestSchema.safeParse(raw);
      if (!parsed.success) fail('INVALID_PARAMS', 'invalid IM settings request');
      const request = parsed.data!;
      // Turning Slack on starts an authorization; that runs as a cloud authorization ticket.
      if (
        request.call === 'maker:hook-control:set-enabled' &&
        (request.args[0] as { enabled?: unknown } | undefined)?.enabled !== false
      )
        fail('UNSUPPORTED', 'connect Slack from the cloud authorization page');
      if (
        request.call === 'telegramBot:set-online' &&
        (request.args[0] as { online?: unknown } | undefined)?.online !== false
      )
        fail('UNSUPPORTED', 'bring the bot online from the cloud authorization page');
      const run = execution(owner);
      let result: unknown;
      try {
        result = await deps.call(request.call, request.args, run);
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        const message = error instanceof Error ? error.message : '';
        if (/^\[[A-Z_]+\]/.test(message)) throw error;
        // Native IPC errors carry a code; their message is the localized-free English text.
        if (typeof code === 'string' && /^[A-Z_]+$/.test(code))
          fail(code, message.slice(0, 300) || 'IM settings request failed');
        if (message === 'MANAGEMENT_UNAVAILABLE') fail('UNAVAILABLE', 'this IM setting is not available');
        fail('INTERNAL', 'IM settings request failed');
      }
      run.assertCurrent();
      const reply: CloudImSettingsReply = {
        ownerGeneration: owner.ownerGeneration,
        result: redactSecrets(result ?? null),
      };
      if (Buffer.byteLength(JSON.stringify(reply)) > CLOUD_IM_SETTINGS_MAX_BYTES)
        fail('TOO_LARGE', 'IM settings reply exceeds the transfer limit');
      return reply;
    },
  };
}
