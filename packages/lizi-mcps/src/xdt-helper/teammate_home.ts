import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

/**
 * 伙伴的主力电脑（docs/product-rules/cloud-companions.md §3.1）：伙伴属于账号，主力电脑只决定它在哪台
 * 电脑上运行。用户在任何一台电脑上能看和换的，Agent 也能（agent-user-parity.md）。换电脑会把伙伴的
 * 运行交给另一台电脑，按当前任务的权限档处理（Full Access 不拦，Auto 审阅，Ask 确认）。
 */
export interface TeammateHomeComputerWire {
  deviceId: string;
  name: string;
  /** The computer this tool runs on. */
  isSelf: boolean;
}

export interface TeammateHomeCallbacks {
  get(params: { callerSessionId: string; teammateId: string }): Promise<ControlResult<{
    teammateId: string;
    home: TeammateHomeComputerWire | null;
    /** local: this computer runs it; remote: its home is asked; takeOver: only this computer can continue it; unavailable: see reason. */
    mode: 'local' | 'remote' | 'takeOver' | 'unavailable';
    reason?: string;
    choices: TeammateHomeComputerWire[];
  }, string>>;
  move(params: { callerSessionId: string; teammateId: string; targetDeviceId: string; whenBusy?: 'wait' | 'stop' }): Promise<ControlResult<{
    teammateId: string;
    homeDeviceId: string;
  }, string>>;
}

export function registerTeammateHomeTools(
  registry: XdtHelperToolRegistry,
  deps: { getSessionContext: () => LiziMcpSessionContext; callbacks: TeammateHomeCallbacks },
): void {
  registry.register({
    name: 'get_teammate_home',
    category: 'bots',
    description: 'Read which computer runs a teammate (its main computer) and which computers it can move to. A teammate belongs to the account: its chat and profile are the same on every computer; the main computer only decides where its agent runs. Use the exact teammate id from list_agents (without a device prefix). Cross-computer: answers for teammates running on any of the user\'s computers.',
    inputShape: { teammate_id: z.string().min(1).max(200) },
    handler: async ({ teammate_id }: { teammate_id: string }) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload('NOT_A_BOT_SESSION', 'An active task is required');
      const result = await deps.callbacks.get({ callerSessionId, teammateId: teammate_id.trim() });
      return result.ok ? okPayload(result) : errorPayload(result.errorCode, result.message);
    },
  });
  registry.register({
    name: 'move_teammate_home',
    category: 'bots',
    description: 'Move a teammate to another of the user\'s computers when the user asks (change its main computer). Pick target_device_id from get_teammate_home choices. Its chat history, profile, memories, skills, todos and routines move with it; files and logins stay on their computers. If it is still replying the move fails with BUSY unless when_busy is "wait" (finish the reply first, up to about 4 minutes) or "stop" (stop the reply). A missing answer may still have moved it: read get_teammate_home before retrying. Cross-computer write: follows the task\'s permission mode.',
    inputShape: {
      teammate_id: z.string().min(1).max(200),
      target_device_id: z.string().min(1).max(200),
      when_busy: z.enum(['fail', 'wait', 'stop']).optional(),
    },
    handler: async ({ teammate_id, target_device_id, when_busy }: { teammate_id: string; target_device_id: string; when_busy?: 'fail' | 'wait' | 'stop' }) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload('NOT_A_BOT_SESSION', 'An active task is required');
      const result = await deps.callbacks.move({ callerSessionId, teammateId: teammate_id.trim(), targetDeviceId: target_device_id.trim(),
        ...(when_busy && when_busy !== 'fail' ? { whenBusy: when_busy } : {}) });
      return result.ok ? okPayload({ action: 'moved', ...result }) : errorPayload(result.errorCode, result.message);
    },
  });
}
