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

const SSH_STATUS_COMMAND = 'uname -sm; nproc 2>/dev/null || sysctl -n hw.ncpu; uptime; free -b 2>/dev/null || vm_stat; df -k ~';

export function registerListMachinesTool(
  registry: XdtHelperToolRegistry,
  deps: { getSessionContext: () => LiziMcpSessionContext; callbacks: ListMachinesCallbacks },
): void {
  registry.register({
    name: LIST_MACHINES_TOOL_NAME,
    category: 'cindy',
    description: "List the machines on this account right now: every computer signed in to it (with live CPU, available memory, disk, idle time, power and running task count) and the SSH hosts configured on this computer. Use it whenever the user mentions their machines, or work may need another computer, more resources, or a different system. Computers that cannot be read stay in the list with an availability reason: offline; remote_control_off (that computer has not allowed control: turn it on there); control_off (this computer turned off controlling it: turn it on here in Settings > Remote connections); update_required (its Cindy is too old to report); unreachable (online, but it did not answer this time). Phones are not included. It reports facts and picks nothing: decide yourself which machine fits. To run work on a computer use create_worker with its device_id; for an SSH host use cindy_ssh ssh_exec.",
    inputShape: {},
    handler: async () => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload('NO_SESSION_CONTEXT', 'An active task is required');
      const result = await deps.callbacks.list({ callerSessionId });
      if (!result.ok) return errorPayload(result.errorCode, result.message);
      return okPayload({
        machines: result.machines,
        ssh_note: `SSH hosts are listed without live resources, because reading them needs a connection that goes through ssh_exec and its permission. To read one: ssh_exec with \`${SSH_STATUS_COMMAND}\`.`,
      });
    },
  });
}
