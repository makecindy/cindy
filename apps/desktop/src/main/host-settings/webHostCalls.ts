import type { DesktopIceServer } from '@cindy/device-link';
import { SETTINGS_WEB_CHANNELS, type SettingsWebEnvelope, type SettingsWebResult } from '../../shared/settingsWeb.js';
import { isProviderManagementRequest } from '../../shared/providerManagement.js';
import { runReportedRemoteChange } from '../instance-runtime/maintenance.js';

/**
 * The calls a browser page of the cloud instance service makes where the native client
 * uses DeviceLink. CIS delivers them only from the instance owner's signed-in
 * browser; here they reach the same handlers a same-account DeviceLink controller reaches.
 */
type Channel = (typeof SETTINGS_WEB_CHANNELS)[number];
type HostCall = Extract<SettingsWebEnvelope['command'], { kind: 'channel' | 'desktop' | 'desktopIce' }>;
export interface WebHostCallDeps {
  /** The cloud runtime's private DeviceLink handler for a `cloud:*` channel, if registered. */
  privateHandler(channel: Channel): Promise<{ handle(controller: string, raw: unknown): Promise<unknown> } | undefined>;
  /** An ordinary allowlisted IPC handler, called as DeviceLink calls it. */
  invoke(channel: Channel, args: unknown[]): Promise<unknown>;
  /** The `provider-group:remote` handler a same-account DeviceLink controller reaches. */
  providerGroup(controller: string, raw: unknown): Promise<unknown>;
  /** Runs a call with the DeviceLink invoke context the handlers already read. */
  inContext<T>(controller: string, channel: string, run: () => Promise<T>): Promise<T>;
  desktop(controller: string, request: unknown): Promise<unknown>;
  ice(): Promise<DesktopIceServer[]>;
}

const PRIVATE_CHANNELS: ReadonlySet<Channel> = new Set([
  'cloud:provider-settings:v1',
  'cloud:im-settings:v1',
  'cloud:storage-usage:v1',
]);

export function isWebHostCall(command: SettingsWebEnvelope['command']): command is HostCall {
  return command.kind === 'channel' || command.kind === 'desktop' || command.kind === 'desktopIce';
}

/** Handlers report `[CODE] message`; desktop requests throw a bare code. */
function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const code = /^\[([A-Z_]{1,64})\]/u.exec(message)?.[1] ?? (/^[A-Z_]{1,64}$/u.test(message) ? message : undefined);
  return code ?? 'SETTINGS_REQUEST_FAILED';
}

export async function executeWebHostCall(
  request: SettingsWebEnvelope & { command: HostCall },
  deps: WebHostCallDeps,
): Promise<SettingsWebResult> {
  // One stable controller per browser session, never a device another account could own.
  const controller = `web:${request.sessionKey}`;
  const command = request.command;
  try {
    if (command.kind === 'desktopIce') return { ok: true, ice: await deps.ice() };
    if (command.kind === 'desktop') {
      // As over DeviceLink: the desktop controller keys its lease and revocation on the peer.
      const value = await deps.desktop(controller, command.request);
      return { ok: true, desktop: value ?? null };
    }
    const channel = command.channel;
    if (PRIVATE_CHANNELS.has(channel)) {
      const handler = await deps.privateHandler(channel);
      if (!handler) return { ok: false, code: 'SETTINGS_UNSUPPORTED' };
      const value = await deps.inContext(controller, channel, () => handler.handle(controller, command.args[0]));
      return { ok: true, channel: value ?? null };
    }
    if (channel === 'provider-group:remote') {
      // The owner's provider management only (group and share settings of this instance's
      // providers); group scheduling and continuity stay between the owner's computers.
      if (!isProviderManagementRequest(command.args[0])) return { ok: false, code: 'INVALID_PARAMS' };
      // The management handler counts group and share changes as maintenance work, as it does
      // over DeviceLink, and still answers reads; the cloud channels count their own.
      const value = await deps.inContext(controller, channel, () => deps.providerGroup(controller, command.args[0]));
      return { ok: true, channel: value ?? null };
    }
    // As over DeviceLink, provider:list's argument only negotiates tunnel features.
    const args = channel === 'maker:provider:list' ? [] : command.args;
    const call = () => deps.inContext(controller, channel, () => deps.invoke(channel, args));
    const value = channel === 'maker:model-favorites:apply' ? await runReportedRemoteChange(call) : await call();
    return { ok: true, channel: value ?? null };
  } catch (error) {
    return { ok: false, code: failureCode(error) };
  }
}
