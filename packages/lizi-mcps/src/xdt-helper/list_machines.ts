import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

/**
 * 账号下有哪些机器、各自此刻的情况（docs/product-rules/cindy-machines.md）。只暴露事实，由 Agent 自己决定
 * 把活放哪台。结果里的电脑含离线与连不上的，并写明原因；手机不在其中。
 */
export const LIST_MACHINES_TOOL_NAME = 'list_machines';

export interface ListMachinesCallbacks {
  list(params: { callerSessionId: string }): Promise<ControlResult<{ machines: unknown }, string>>;
}

export function registerListMachinesTool(
  registry: XdtHelperToolRegistry,
  deps: { getSessionContext: () => LiziMcpSessionContext; callbacks: ListMachinesCallbacks },
): void {
  registry.register({
    name: LIST_MACHINES_TOOL_NAME,
    category: 'cindy',
    description: "List the machines on this account right now: every computer signed in to it (with live CPU, available memory, disk, idle time, power and running task count) and the SSH hosts configured on this computer (with live CPU count, load, available memory and disk). Use it first whenever the user asks about their machines or SSH hosts (online status, memory, disk, load), or work may need another computer, more resources, or a different system; it already reads all of them in one call, so do not run ssh or read ~/.ssh yourself for this. Computers that cannot be read stay in the list with an availability reason: offline; remote_control_off (that computer has not allowed control: turn it on there); control_off (this computer turned off controlling it: turn it on here in Settings > Remote connections); update_required (its Cindy is too old to report); unreachable (online, but it did not answer this time). SSH hosts report availability reachable; unreachable (see errorCode); unreadable (connected, but it cannot run the status command, e.g. Windows); host_key_changed (its key differs from the trusted one and the connection was refused: tell the user to verify the fingerprint through a trusted console, never remove the record or report it as a password problem); unverified (its key has never been trusted, so it was not connected: ask the user before connecting). sameAddressAs lists entries at the same address: one failing does not mean that machine is down, so check them together. Phones are not included. It reports facts and picks nothing: decide yourself which machine fits. To run work on a computer use create_worker with its device_id; for an SSH host use cindy_ssh ssh_exec.",
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
