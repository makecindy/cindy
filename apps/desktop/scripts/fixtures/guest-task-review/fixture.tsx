import { sharedTaskHostPeer } from '@cindy/device-link';
import GuestTaskReview from '../../../src/renderer/features/right-sidebar/plugins/review/GuestTaskReview';
import { mountPage } from '../../ui-page/harness';

const peer = sharedTaskHostPeer('share', 'device');
const sessionId = 'shared-task';
void mountPage({
  host: { deviceLink: { invoke: async (device: string, channel: string, args: unknown[]) => {
    if (device !== peer || channel !== 'local-db:messages:list' || args[0] !== sessionId) throw new Error('Unexpected read');
    return [
      { id: 'edit', role: 'tool_use', sessionId, toolUseId: 'edit', content: {
        toolName: 'Edit', input: { file_path: 'notes.txt', old_string: 'Draft', new_string: 'Guest review' },
      } },
      { id: 'result', role: 'tool_result', sessionId, toolUseId: 'edit', content: 'Updated successfully' },
    ];
  } } },
  render: () => <GuestTaskReview peer={peer} sessionId={sessionId} />,
});
