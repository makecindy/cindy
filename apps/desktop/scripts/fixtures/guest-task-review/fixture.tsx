import { sharedTaskHostPeer } from '@cindy/device-link';
import GuestTaskReview from '../../../src/renderer/features/right-sidebar/plugins/review/GuestTaskReview';
import { mountPage } from '../../ui-page/harness';

const peer = sharedTaskHostPeer('share', 'device');
const sessionId = 'shared-task';
const lines = [
  { index: 0, type: 'delete', raw: '-Draft', content: 'Draft', oldLineNumber: 1, newLineNumber: null },
  { index: 1, type: 'add', raw: '+Guest review', content: 'Guest review', oldLineNumber: null, newLineNumber: 1 },
];
const file = {
  id: 'unstaged:other/notes.txt', path: 'other/notes.txt', source: 'unstaged', status: 'modified',
  kind: 'text', additions: 1, deletions: 1, rawPatch: '@@ -1 +1 @@\n-Draft\n+Guest review',
  hunks: [{ index: 0, header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1,
    newLines: 1, section: '', selectableLines: [0, 1], lines }],
};
void mountPage({
  host: { deviceLink: { invoke: async (device: string, channel: string, args: unknown[]) => {
    const request = args[0] as { op: string; payload: { sessionId: string } };
    if (device !== peer || channel !== 'git-review:remote-op' || request.op !== 'get' ||
        request.payload.sessionId !== sessionId) throw new Error('Unexpected read');
    return { ok: true, result: { scope: { disabledReason: null }, summary: { dirty: true },
      diffs: { staged: [], unstaged: [file] } } };
  } } },
  render: () => <GuestTaskReview peer={peer} sessionId={sessionId} />,
});
