import { describe, expect, it } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { CAPABILITIES } from '../xdt-helper/capabilities.js';
import { registerGetChatHistoryTool } from '../xdt-helper/get_chat_history.js';
import type { XdtHelperHistoryDeps } from '../xdt-helper/_history_types.js';

describe('get_chat_history published contract', () => {
  it('uses the runtime schema field names in tool discovery and capability examples', () => {
    const registry = new XdtHelperToolRegistry();
    registerGetChatHistoryTool(registry, {
      history: {} as XdtHelperHistoryDeps,
    });

    const tool = registry.get('get_chat_history');
    expect(tool).toBeDefined();
    expect(Object.keys(tool!.inputShape)).toContain('session_ids');
    expect(tool!.description).toContain('session_ids');
    expect(tool!.description).toContain('agent_kind');
    expect(tool!.description).not.toContain('按 sessionIds / workdir');
    expect(tool!.description).not.toContain('时间段 / agentKind / roles');

    const capability = CAPABILITIES.find((entry) => entry.key === 'chat-history-query');
    expect(capability).toBeDefined();
    expect(capability!.detail).toContain('【六个工具】');
    for (const name of [
      'list_workdirs',
      'list_sessions',
      'list_session_queue',
      'get_chat_history',
      'search_chat_history',
      'list_history_devices',
    ]) {
      expect(capability!.detail).toContain(name);
    }
    expect(capability!.detail).toContain('get_chat_history({session_ids: [...]})');
    expect(capability!.detail).not.toContain('get_chat_history({sessionIds: [...]})');
  });
});
