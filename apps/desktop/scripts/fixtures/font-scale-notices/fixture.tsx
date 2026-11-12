import { ErrorNotice } from '../../../src/renderer/components/ui/error-notice';
import { DownloadToast } from '../../../src/renderer/components/ui/toast/DownloadToast';
import type { FileTransferToast } from '../../../src/renderer/lib/fileTransferToasts';
import { DEFAULT_APPEARANCE_SETTINGS } from '../../../src/shared/appearanceSettings';
import { mountPage, subscription } from '../../ui-page/harness';

const transfer = (id: string, name: string, message: string): FileTransferToast => ({
  id,
  name,
  message,
  variant: 'info',
  duration: 0,
  createdAt: 1,
  exiting: false,
  action: { label: 'Cancel', onClick: () => {} },
});

const transfers = [
  transfer('a', 'quarterly-design-review-screenshots-light-and-dark-final-export.zip', '38 MB of 120 MB'),
  transfer('b', 'meeting-notes-with-a-long-file-name-that-wraps-to-two-lines.md', 'Waiting for the other computer'),
];

function Fixture({ uiSize }: { uiSize: number }) {
  return (
    <div className="flex w-[420px] flex-col gap-4 p-4" data-ui-size={uiSize}>
      <ErrorNotice
        data-font-scale-error
        message="The model provider rejected this request because the account quota for this billing period is used up."
        description="Switch to another model or wait for the quota to reset. The task keeps its progress and can continue later."
        details={'HTTP 429 Too Many Requests\nretry-after: 3600\nrequest-id: fixture-request'}
      />
      <DownloadToast items={transfers} />
    </div>
  );
}

const uiSizeFor = (testCase: string) => (testCase === 'ui-24' ? 24 : DEFAULT_APPEARANCE_SETTINGS.uiSize);

void mountPage({
  // 字号走产品同一条路径:外观设置快照 → applyFontSettings 改写 --text-*,不改根字号。
  host: (ctx) => ({
    appearanceSettings: {
      getSync: () => ({ ...DEFAULT_APPEARANCE_SETTINGS, uiSize: uiSizeFor(ctx.case) }),
      onChanged: subscription('appearanceSettingsChanged'),
    },
  }),
  render: (ctx) => <Fixture uiSize={uiSizeFor(ctx.case)} />,
});
