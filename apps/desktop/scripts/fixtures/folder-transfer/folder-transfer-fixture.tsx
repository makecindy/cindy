import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { mountPage } from '../../ui-page/harness';
import { ComposerFolderTransfers } from '../../../src/renderer/components/new-chat/ComposerFolderTransfers';

function Fixture() {
  const { t } = useTranslation();
  const [removed, setRemoved] = useState<string[]>([]);
  const rows: ComponentProps<typeof ComposerFolderTransfers>['rows'] = [
    {
      id: 'pack',
      source: '/example',
      name: 'Project materials — design and reference documents',
      message: t('chat.remoteFile.folderPacking', { size: '12.4 MB' }),
      failed: false,
      cancelled: false,
      cancel() {},
      done: Promise.resolve(false),
    },
    {
      id: 'failed',
      source: '/other',
      name: 'Documents',
      message: t('chat.remoteFile.folderFailed'),
      failed: true,
      cancelled: false,
      cancel() {},
      done: Promise.resolve(false),
    },
  ];
  return (
    <main className="p-4">
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3">
        <ComposerFolderTransfers
          rows={rows.filter((row) => !removed.includes(row.id))}
          onRemove={(id) => setRemoved((value) => [...value, id])}
        />
      </div>
    </main>
  );
}
void mountPage({ render: () => <Fixture /> });
