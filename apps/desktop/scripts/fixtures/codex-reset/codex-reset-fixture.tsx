import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { mountPage } from '../../ui-page/harness';
import { CodexResetCredits } from '../../../src/renderer/components/status/CodexResetCredits';
import { DEFAULT_CODEX_RESET_AUTO_USE } from '../../../src/main/usage/codexResetAutoUse';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';

const now = Date.now();
let snapshot: MobileCodexRateLimitsResult = {
  providerId: 'openai', account: { email: 'ch***@example.com', accountId: '…123456', planType: 'plus' },
  rateLimits: { secondary: { usedPercent: 77, windowMinutes: 10080, resetsAt: now / 1000 + 4 * 86400 } },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: { availableCount: 2, credits: [1, 2].map(n => ({
    status: 'available', resetType: 'codexRateLimits', grantedAt: 1, expiresAt: now / 1000 + n * 86400,
    title: null, description: null, resetOffer: { idempotencyKey: `fixture-${n}`, expiresAt: now / 1000 + n * 86400, validUntil: now + 600_000 },
  })) },
  resetOffer: { idempotencyKey: 'fixture-1', expiresAt: now / 1000 + 86400, validUntil: now + 600_000 },
  autoUse: { accountKey: 'fixture-account', settings: { ...DEFAULT_CODEX_RESET_AUTO_USE }, customized: false, lastUsedAt: null },
};
function Fixture({ embedded, modal }: { embedded: boolean; modal: boolean }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(snapshot);
  const content = <CodexResetCredits variant={embedded ? 'embedded' : 'dialog'} snapshot={value} busy={false} canReset onReset={() => {}}
    onChanged={() => setValue({ ...snapshot })} />;
  // Regression: TodaySpendChip hosts this list in a modal. The standalone fixture cannot
  // detect a rules portal hidden under that modal's scrim; exercise real pointer hits here.
  if (modal) return <Dialog.Root defaultOpen>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
      <Dialog.Content aria-describedby={undefined} onPointerDownOutside={event => event.preventDefault()}
        className="modal-panel fixed left-1/2 top-1/2 z-[10000] w-[400px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 p-4">
        <Dialog.Title className="sr-only">{t('codexResets.title')}</Dialog.Title>
        <div className="max-h-[60vh] overflow-y-auto">{content}</div>
        <Dialog.Close asChild>
          <button type="button" aria-label={t('common.dismiss')}
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-[var(--confirm-desc)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--confirm-title)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
  return <main className="mx-auto w-full max-w-[580px] p-4"><div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
    {content}
  </div></main>;
}
void mountPage({
  host: { maker: { usage: { setCodexResetAutoUse: async (patch: object | null) => {
    snapshot = { ...snapshot, autoUse: { ...snapshot.autoUse!, customized: patch !== null,
      settings: patch === null ? { ...DEFAULT_CODEX_RESET_AUTO_USE } : { ...snapshot.autoUse!.settings, ...patch } } };
    return snapshot;
  } } } },
  render: ctx => <Fixture embedded={ctx.case === 'embedded'} modal={ctx.case === 'modal'} />,
});
