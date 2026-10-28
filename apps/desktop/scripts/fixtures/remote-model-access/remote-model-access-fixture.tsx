import { AppFrame, mountPage, subscription } from '../../ui-page/harness';
import { RemoteModelAccessDialog, RemoteModelAccessSection } from '../../../src/renderer/features/provider-share/RemoteModelAccessSection';
import type { RemoteModelSelection } from '../../../src/shared/remoteModelAccess';

void mountPage({
  host: (ctx) => {
    let models: RemoteModelSelection = ctx.case === 'member' ? ['small'] : null;
    return {
      providerShare: {
        onOwnedChanged: subscription('ownedShares'),
        command: async (cmd: { action: string; models?: RemoteModelSelection }) => {
          if (cmd.action === 'set-model-access') models = cmd.models ?? null;
          return {
            version: 1, models, providerModels: ctx.case === 'member' ? ['small', 'medium'] : null,
            availableModels: [
              { id: 'small', name: 'Claude Haiku' },
              { id: 'medium', name: 'Claude Sonnet' },
              { id: 'large', name: 'Claude Opus' },
            ],
          };
        },
      },
    };
  },
  render: (ctx) => (
    <AppFrame header={false}>
      <div className="p-6">
        <RemoteModelAccessSection providerId="fixture-provider" />
        {ctx.case === 'member' && <RemoteModelAccessDialog providerId="fixture-provider" memberId="fixture-member" memberName="小林" onClose={() => {}} />}
      </div>
    </AppFrame>
  ),
});
