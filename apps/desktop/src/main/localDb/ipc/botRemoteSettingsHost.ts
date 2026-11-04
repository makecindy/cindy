import type { RemoteActionInvokeRequest, RemoteActionInvokeResponse } from '@cindy/device-link';
import {
  BOT_SETTINGS_HOST_OPS,
  BOT_SETTINGS_PROTOCOL_VERSION,
  isBotSettingsOp,
  type BotSettingsCaps,
  type BotSettingsOp,
  type BotSettingsResult,
} from '../../../shared/botRemoteSettings.js';
import { extractIpcError } from '../../../shared/ipcError.js';
import type { RemoteResourceHostContext } from '../../device-link/remoteResourceRegistry.js';
import { RemoteResourceRegistryError } from '../../device-link/remoteResourceRegistry.js';

/** What an operation sees: the validated teammate (null for host-wide operations) and its arguments. */
export interface BotSettingsCall {
  controllerDeviceId: string;
  botId: string | null;
  args: Record<string, unknown>;
  /** Throws once the account, the controller's authorization or the teammate's visibility changed. */
  assertCurrent(): void;
}
export type BotSettingsOpHandler = (call: BotSettingsCall) => Promise<unknown>;

export interface BotSettingsHostDeps {
  ops: Partial<Record<BotSettingsOp, BotSettingsOpHandler>>;
  owner(): string;
  isOwnerCurrent(owner: string): boolean;
  /** Same-account controller that is still authorized to control this computer. */
  controllerAllowed(controllerDeviceId: string): boolean;
  /** Hidden and archived teammates are recoverable on the local Desktop only. */
  botVisible(botId: string): Promise<boolean>;
}

/** Codes whose message is written for the user's page and is safe to hand to the controller. */
const FORWARDED_CODES = new Set(['PRECONDITION_FAILED', 'INVALID_PARAMS', 'NOT_FOUND', 'ALREADY_EXISTS', 'UNSUPPORTED_CAPABILITY']);
const BOT_ID = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * Host-wide operations that still name a teammate in their arguments. The named teammate is held to
 * the same visibility as a teammate-scoped call, so a controller cannot reach a hidden or archived one
 * through them (e.g. make it the follow-up teammate).
 */
const HOST_OP_BOT_ARGS: Partial<Record<BotSettingsOp, string>> = { 'autonomy.set': 'schedulerBotId' };
const MAX_MESSAGE = 300;

const failure = (code: string, message: string): BotSettingsResult => ({ ok: false, code, message: message.slice(0, MAX_MESSAGE) });

/**
 * Executes the teammate settings pages' operations for a remote Desktop. It owns admission only
 * (authorization, visibility, owner currency, error shape); each operation calls the same service
 * the local IPC handler calls, so validation and side effects are not duplicated here.
 */
export function createBotRemoteSettingsHost(deps: BotSettingsHostDeps) {
  const implemented = (): BotSettingsOp[] => (Object.keys(deps.ops) as BotSettingsOp[]).filter(isBotSettingsOp);
  const caps = (): BotSettingsCaps => ({ version: BOT_SETTINGS_PROTOCOL_VERSION, ops: ['caps', ...implemented().filter(op => op !== 'caps')] });

  async function run(context: RemoteResourceHostContext, request: RemoteActionInvokeRequest): Promise<BotSettingsResult> {
    const input = request.input ?? {};
    const op = input.op;
    if (input.v !== BOT_SETTINGS_PROTOCOL_VERSION || !isBotSettingsOp(op)) return failure('INVALID_PARAMS', 'Unknown settings operation');
    const args = input.args === undefined ? {} : input.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return failure('INVALID_PARAMS', 'Invalid settings arguments');
    if (!deps.controllerAllowed(context.controllerDeviceId)) return failure('PRECONDITION_FAILED', 'Remote control is unavailable');
    const owner = deps.owner();
    const botScoped = !BOT_SETTINGS_HOST_OPS.includes(op);
    let botId: string | null = null;
    if (botScoped) {
      const ref = request.resourceRef;
      if (ref?.collectionId !== 'teammates' || ref.kind !== 'bot' || !BOT_ID.test(ref.id)) return failure('INVALID_PARAMS', 'Teammate required');
      botId = ref.id;
    }
    const assertCurrent = () => {
      if (!deps.isOwnerCurrent(owner) || !deps.controllerAllowed(context.controllerDeviceId))
        throw new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');
    };
    try {
      if (op === 'caps') return { ok: true, value: caps() };
      const handler = deps.ops[op];
      if (!handler) return failure('UNSUPPORTED_CAPABILITY', 'Update Cindy on the teammate’s computer');
      if (botId && !(await deps.botVisible(botId))) {
        assertCurrent();
        return failure('NOT_FOUND', 'Teammate unavailable');
      }
      const namedArg = HOST_OP_BOT_ARGS[op];
      const named = namedArg ? (args as Record<string, unknown>)[namedArg] : null;
      if (typeof named === 'string' && !(BOT_ID.test(named) && await deps.botVisible(named))) {
        assertCurrent();
        return failure('NOT_FOUND', 'Teammate unavailable');
      }
      assertCurrent();
      const value = await handler({ controllerDeviceId: context.controllerDeviceId, botId, args: args as Record<string, unknown>, assertCurrent });
      // A result produced for another account or after a revoke must never be delivered.
      assertCurrent();
      return { ok: true, value };
    } catch (error) {
      if (error instanceof RemoteResourceRegistryError) throw error;
      const ipc = extractIpcError(error);
      // `message` still carries the `[CODE] ` prefix of the IPC error shape; the controller adds its own.
      if (ipc && FORWARDED_CODES.has(ipc.code)) return failure(ipc.code, ipc.message.replace(/^\[[A-Z0-9_]+\]\s*/, ''));
      throw new RemoteResourceRegistryError('INTERNAL', 'Settings operation failed');
    }
  }

  return {
    caps,
    async invoke(context: RemoteResourceHostContext, request: RemoteActionInvokeRequest): Promise<RemoteActionInvokeResponse> {
      return { effects: [], result: await run(context, request) };
    },
  };
}
export type BotRemoteSettingsHost = ReturnType<typeof createBotRemoteSettingsHost>;
