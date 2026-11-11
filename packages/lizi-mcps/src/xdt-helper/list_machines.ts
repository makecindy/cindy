import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

/**
 * 账号下有哪些机器、各自此刻的情况（docs/product-rules/cindy-machines.md）。只暴露事实，由 Agent 自己决定
 * 把活放哪台。结果里的电脑含离线与连不上的，并写明原因；手机不在其中。
 */
export const LIST_MACHINES_TOOL_NAME = 'list_machines';
export const REQUEST_REMOTE_CONTROL_TOOL_NAME = 'request_remote_control';

export interface ListMachinesCallbacks {
  requestRemoteControl?(params: { callerSessionId: string; deviceId: string; purpose: string }): Promise<ControlResult<{ status: string }, string>>;
  list(params: { callerSessionId: string }): Promise<ControlResult<{ machines: unknown }, string>>;
}

export function registerListMachinesTool(
  registry: XdtHelperToolRegistry,
  deps: { getSessionContext: () => LiziMcpSessionContext; callbacks: ListMachinesCallbacks },
): void {
  registry.register({
    name: LIST_MACHINES_TOOL_NAME,
    category: 'cindy',
    description: "List the machines on this account right now: every computer signed in to it (with live CPU, available memory, disk, idle time, power and running task count) and the SSH hosts configured on this computer (with live CPU count, load, available memory and disk). Use it first whenever the user asks about their machines or SSH hosts (online status, memory, disk, load), or work may need another computer, more resources, or a different system; it already reads all of them in one call, so do not run ssh or read ~/.ssh yourself for this. Computers that cannot be read stay in the list with an availability reason: offline; remote_control_off (that computer has not allowed control: use request_remote_control to ask its user to enable it in a local dialog); control_off (this computer turned off controlling it: turn it on here in Settings > Remote connections); update_required (its Cindy is too old to report); unreachable (online, but it did not answer this time). SSH hosts report availability reachable; unreachable (see errorCode); unreadable (connected, but it cannot run the status command, e.g. Windows); host_key_changed (its key differs from the trusted one and the connection was refused: tell the user to verify the fingerprint through a trusted console, never remove the record or report it as a password problem); unverified (its key has never been trusted, so it was not connected: ask the user before connecting). sameAddressAs lists entries at the same address: one failing does not mean that machine is down, so check them together. Phones are not included. It reports facts and picks nothing: decide yourself which machine fits. To run work on a computer use create_worker with its device_id; for an SSH host use cindy_ssh ssh_exec.",
    inputShape: {},
    handler: async () => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload('NO_SESSION_CONTEXT', 'An active task is required');
      const result = await deps.callbacks.list({ callerSessionId });
      if (!result.ok) return errorPayload(result.errorCode, result.message);
      return okPayload({ machines: result.machines });
    },
  });
}

/** Requesting a dialog never grants control; only the target computer's user can approve. */
export function registerRemoteControlRequestTool(
  registry: XdtHelperToolRegistry,
  deps: { getSessionContext: () => LiziMcpSessionContext; callbacks: ListMachinesCallbacks },
): void {
  if (!deps.callbacks.requestRemoteControl) return;
  registry.register({
    name: REQUEST_REMOTE_CONTROL_TOOL_NAME,
    category: 'cindy',
    description: 'Ask an online same-account computer to enable remote control in a local confirmation dialog. Use the exact device ID from list_machines and explain the user-requested purpose. This enables the persistent remote-control setting only if the person at that computer approves. Waits up to 47 seconds. Continue the original operation only after status enabled; declined/expired/busy/unavailable/failed/no_response do not grant permission. no_response can mean an older Cindy or an unreachable computer: do not automatically repeat the prompt. No SSH, phone, shared-task or cross-account targets.',
    inputShape: { device_id: z.string().min(1).max(256), purpose: z.string().trim().min(1).max(500) },
    handler: async ({ device_id, purpose }) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload('NO_SESSION_CONTEXT', 'An active task is required');
      const result = await deps.callbacks.requestRemoteControl!({ callerSessionId, deviceId: device_id, purpose });
      return result.ok ? okPayload({ device_id, status: result.status }) : errorPayload(result.errorCode, result.message);
    },
  });
}
