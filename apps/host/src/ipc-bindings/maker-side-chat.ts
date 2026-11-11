import { listSideChats } from '../../../desktop/src/main/maker-orchestration/side-chat-list.js';
import type { HostIpcBinding } from './index.js';

/** Registry family `maker-side-chat`. */
export function makerSideChatIpcBindings(): Record<string, HostIpcBinding> {
  return {
    'maker:side-chat:list:v1': ([sourceSessionId]) => listSideChats(sourceSessionId as string),
  };
}
