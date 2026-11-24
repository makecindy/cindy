// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import GuestTaskReview from '../GuestTaskReview';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Unit: an authorized history page can contain failed and unfinished tool calls.
// Only a completed edit in this task should appear; no workspace API is provided.
it('projects only completed edits from the shared history response', async () => {
  const sessionId = 'task';
  const peer = sharedTaskHostPeer('share', 'device');
  const edit = (id: string) => ({
    id, sessionId, role: 'tool_use', toolUseId: id,
    content: { toolName: 'Edit', input: { file_path: id + '.txt', old_string: 'old', new_string: 'new' } },
  });
  const result = (id: string, content: string) => ({
    id: id + '-result', sessionId, role: 'tool_result', toolUseId: id, content,
  });
  const invoke = vi.fn().mockResolvedValueOnce([
    { ...result('applied', 'Updated successfully'), agentMeta: { remoteRowsTrimmed: true } },
    edit('applied'), result('failed', '<tool_use_error>denied</tool_use_error>'), edit('failed'), edit('pending'),
  ]).mockResolvedValueOnce([result('older', 'Updated successfully'), edit('older')]);
  vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
  render(<GuestTaskReview peer={peer} sessionId={sessionId} />);
  expect(await screen.findByText('applied.txt')).toBeTruthy();
  expect(screen.queryByText('failed.txt')).toBeNull();
  expect(screen.queryByText('pending.txt')).toBeNull();
  expect(invoke).toHaveBeenCalledExactlyOnceWith(peer, 'local-db:messages:list', [sessionId, { limit: 50 }]);
  fireEvent.click(screen.getByRole('button', { name: 'bots.cloud.loadOlder' }));
  expect(await screen.findByText('older.txt')).toBeTruthy();
  expect(invoke).toHaveBeenLastCalledWith(peer, 'local-db:messages:list', [sessionId, { limit: 50, before: 'pending' }]);
  expect(screen.queryByRole('button', { name: 'bots.cloud.loadOlder' })).toBeNull();
});
