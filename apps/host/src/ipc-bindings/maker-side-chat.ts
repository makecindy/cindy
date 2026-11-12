import { listSideChats } from '../../../desktop/src/main/maker-orchestration/side-chat-list.js';
import type { HostIpcBinding, HostIpcResultFields, ResultFields } from './index.js';

type SideChatRow = Awaited<ReturnType<typeof listSideChats>>[number];

/** Result objects of this family, keyed by the handler's return type (see index.ts). */
export const MAKER_SIDE_CHAT_RESULT_FIELDS = {
  'maker:side-chat:list:v1': {
    'result[]': { id: 'required' } satisfies ResultFields<SideChatRow>,
  },
} as const satisfies HostIpcResultFields;

/** Registry family `maker-side-chat`. */
export function makerSideChatIpcBindings(): Record<string, HostIpcBinding> {
  return {
    'maker:side-chat:list:v1': ([sourceSessionId]) => listSideChats(sourceSessionId as string),
  };
}
