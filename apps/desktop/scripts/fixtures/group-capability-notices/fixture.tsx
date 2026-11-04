import { AppFrame, mountPage } from '../../ui-page/harness';
import { BotGroupCapabilityNotice } from '../../../src/renderer/features/bots/BotGroupCapabilityNotice';

mountPage({ render: () => <AppFrame header={false}>
  <div className="mx-auto flex max-w-[640px] flex-col gap-8 p-8">
    {['GROUP_AUTHORIZATION_REQUIRED', 'GROUP_AUTHORIZATION_UNAVAILABLE', 'ATTACHMENTS_UNAVAILABLE'].map(code =>
      <BotGroupCapabilityNotice key={code} name="Aster" code={code} />)}
  </div>
</AppFrame> });
