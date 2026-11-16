import { Download, X } from 'lucide-react';
import { useState } from 'react';
import HookTaskCard from '../../../src/renderer/components/chat/HookTaskCard';
import { PreviewButton } from '../../../src/renderer/components/chat/PreviewChrome';
import { Toast } from '../../../src/renderer/components/ui/toast/Toast';
import { MailConversationView } from '../../../src/renderer/features/right-sidebar/plugins/mail-preview/MailConversationView';
import { WebhookEventSelect } from '../../../src/renderer/features/scheduler/components/WebhookEventSelect';
import { mountPage } from '../../ui-page/harness';

const mail = {
  accountId: 'fixture-account',
  messageId: 'fixture-message',
  from: 'Cindy <cindy@example.test>',
  to: 'Alex <alex@example.test>',
  cc: '',
  bcc: '',
  subject: 'Weekly design update',
  date: '2026-10-25T09:00:00+13:00',
  bodyText: 'The new mail reader is ready for review.',
  bodyHtml: '',
  attachments: [],
};

function WebhookFixture() {
  const [value, setValue] = useState('');
  return (
    <div className="w-[360px] p-6">
      <WebhookEventSelect preset="github" value={value} onChange={setValue} />
    </div>
  );
}

function Fixture({ kind }: { kind: string }) {
  switch (kind) {
    case 'preview-button':
      return (
        <div className="flex items-center gap-1 p-6">
          <PreviewButton label="Download" onClick={() => {}}>
            <Download className="h-4 w-4" />
          </PreviewButton>
          <PreviewButton label="Close" onClick={() => {}}>
            <X className="h-4 w-4" />
          </PreviewButton>
        </div>
      );
    case 'mail-row':
      return (
        <div className="w-[420px] p-6">
          <MailConversationView mail={mail} read={async () => ({ message: mail })} retry={() => {}} openMailbox={null} />
        </div>
      );
    case 'webhook-event':
      return <WebhookFixture />;
    case 'hook-task-card':
      return (
        <div className="w-[420px] p-6">
          <HookTaskCard
            im="slack"
            userText="Can you check the release notes?"
            replyContext={'[A] Quoted message\nSecond line'}
            replyMessageCount={1}
            groupContext={'[B] Earlier message'}
            groupMessageCount={1}
          />
        </div>
      );
    default:
      return (
        <div className="p-6">
          <Toast
            item={{
              id: 'fixture-toast',
              variant: 'info',
              title: 'Update ready',
              message: 'Restart Cindy to finish installing the new version.',
              dismissLabel: 'Later',
              duration: 0,
              createdAt: 1,
              exiting: false,
            }}
          />
        </div>
      );
  }
}

void mountPage({ render: (ctx) => <Fixture kind={ctx.case} /> });
