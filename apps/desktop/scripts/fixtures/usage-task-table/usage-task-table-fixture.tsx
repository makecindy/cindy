import { MemoryRouter } from 'react-router-dom';
import { mountPage } from '../../ui-page/harness';
import { UsageTaskTable } from '../../../src/renderer/components/settings/usage/UsageTaskTable';

void mountPage({
  render: () => (
    <MemoryRouter>
      <main className="mx-auto w-full max-w-[1000px] p-4">
        <UsageTaskTable rangeLabel="2026-10-24" rows={[{
          taskKey: 'local:model-switch', deviceId: 'local', sessionId: 'model-switch',
          title: 'Model switch fixture', model: 'gpt-6.1-sol', providerId: 'openai',
          tokens: 123456, contextTokens: 0, contextWindow: 0, lastActiveAt: 0,
        }]} />
      </main>
    </MemoryRouter>
  ),
});
