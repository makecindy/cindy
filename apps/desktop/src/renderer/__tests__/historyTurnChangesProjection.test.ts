import { describe, expect, it } from 'vitest';
import { HistoryViewController } from '@cindy/maker-shared/message-window';
import { buildMessageStreamRenderProjection } from '../components/chat/MessageStream';
import type { ChatMessage, HistoryChatMessage } from '../lib/makerChatStore';
import type { TurnChangeSetSummary } from '../../shared/turnChangeSet';

// Unit: use MessageStream's production entry so history selection and option
// forwarding are included. Extracting only the callback lost its renderOptions
// binding after refactoring; keep all card content/order/page-boundary assertions.
const changeSet: TurnChangeSetSummary = {
  id: 'changes-1', sessionId: 'session-1', anchorClientId: 'user-1', provider: 'codex',
  providerTurnId: 'turn-1', cwd: 'C:/fixture', state: 'complete', workspaceState: 'applied',
  isReversible: true, incompleteReasons: [], createdAt: 1, completedAt: 2,
  files: Array.from({ length: 5 }, (_, i) => ({ id: `file-${i}`, path: `note-${i}.txt`,
    oldPath: null, status: 'modified' as const, additions: 1, deletions: 1 })),
  fileCount: 5, additions: 5, deletions: 5,
};
async function render(rows: ChatMessage[], streaming = false) {
  const messages: HistoryChatMessage[] = rows.map((row, index) => ({
    ...row, id: row.clientId, createdAt: new Date(index * 1000).toISOString(),
  }));
  const view = new HistoryViewController<HistoryChatMessage>({
    page: async () => ({ version: 1, items: [{ type: 'messages', key: 'page', messages }],
      hasMore: false, nextCursor: null }),
    details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
    expanded: async () => undefined,
  });
  try {
    await view.refresh();
    return buildMessageStreamRenderProjection({
      historyView: view, historySnapshot: view.getSnapshot(), historyLiveMessages: [],
      isSessionStreaming: streaming, generatedFilesItemCache: new Map(),
      renderOptions: { workingDir: 'C:/fixture', turnChangeSets: [changeSet] },
      buildRaw: () => { throw new Error('Ready history must not build raw messages'); },
    }).items;
  } finally {
    view.setActive(false);
  }
}
describe('history-view changed files cards', () => {
  it('keeps the completed five-file card before the next streaming turn', async () => {
    const rows: ChatMessage[] = [
      { clientId: 'user-1', role: 'user', content: 'Edit five files' },
      { clientId: 'answer-1', role: 'assistant', content: 'Done' },
      { clientId: 'user-2', role: 'user', content: 'Continue' },
      { clientId: 'answer-2', role: 'assistant', content: 'Streaming', isStreaming: true },
    ];
    const items = await render(rows, true);
    const cards = items.filter(item => item.type === 'turn_changes');
    expect(cards).toHaveLength(1);
    expect(cards[0].changeSet.files).toHaveLength(5);
    expect(items.map(item => item.key)).toEqual([
      'msg-user-1', 'msg-answer-1', 'turnchanges-changes-1', 'msg-user-2', 'msg-answer-2',
    ]);
    expect((await render(rows.slice(0, 2))).filter(item => item.type === 'turn_changes')).toHaveLength(1);
  });
  it('keeps the review card after the reviewed turn and its changed-files card', async () => {
    const rows: ChatMessage[] = [
      { clientId: 'user-1', role: 'user', content: 'Edit five files' },
      { clientId: 'answer-1', role: 'assistant', content: 'Done' },
      { clientId: 'review:run-1', role: 'assistant', content: 'P1 finding', systemCardType: 'review' },
    ];
    expect((await render(rows)).map(item => item.key)).toEqual([
      'msg-user-1', 'msg-answer-1', 'turnchanges-changes-1', 'msg-review:run-1',
    ]);
  });
  it('does not pull a changed-files card from a turn outside the loaded history', async () => {
    expect((await render([{ clientId: 'user-2', role: 'user', content: 'Another page' }]))
      .filter(item => item.type === 'turn_changes')).toEqual([]);
  });
});
