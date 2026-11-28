import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@/hooks/useCCAgentChat';
import { collectBotStartedTasks, currentBuddyName } from '../BotStartedTasks';

type Bots = Parameters<typeof currentBuddyName>[2];
const bots = (([
  { id: 'bot-1', name: 'Muffin', sessions: [{ id: 'session-1', role: 'canonical' }] },
]) as unknown) as Bots;

describe('currentBuddyName', () => {
  it('uses the current name for a buddy chat on this computer', () => {
    expect(currentBuddyName('session-1', true, bots)).toBe('Muffin');
  });

  it('matches a bare canonical id after a device prefix', () => {
    expect(currentBuddyName('remote-mac::session-1', true, bots)).toBe('Muffin');
  });

  // A remote copy can share the bare id with the local buddy's canonical chat.
  // Borrowing the local name there would label the remote task with the wrong buddy.
  it('keeps the remote title when the session belongs to another computer', () => {
    expect(currentBuddyName('remote-mac::session-1', false, bots)).toBeNull();
    expect(currentBuddyName('session-1', false, bots)).toBeNull();
  });

  it('returns null for an unknown session', () => {
    expect(currentBuddyName('session-other', true, bots)).toBeNull();
    expect(currentBuddyName(undefined, true, bots)).toBeNull();
  });
});

// P1-1 unit: receipts returning wake_kind='provisioning' represent newly created tasks
// whose worktree is preparing in the background; the buddy task strip must mark them created.
describe('collectBotStartedTasks', () => {
  it('marks wake_kind=provisioning receipts as created tasks', () => {
    const turn = [
      {
        role: 'tool_use',
        toolName: 'cindy_helper__send_to_session',
        toolUseId: 'tu-1',
        toolInput: { use_worktree: true },
      },
      {
        role: 'tool_result',
        toolUseId: 'tu-1',
        content: JSON.stringify({
          ok: true,
          target_session_id: 'remote-mac::prov-1',
          target_title: '大仓修复',
          wake_kind: 'provisioning',
          worktree_status: 'provisioning',
        }),
      },
    ] as unknown as ChatMessage[];
    expect(collectBotStartedTasks(turn)).toEqual([
      { sessionId: 'remote-mac::prov-1', title: '大仓修复', created: true },
    ]);
  });
});

