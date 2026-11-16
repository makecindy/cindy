import { useEffect } from 'react';
import { mountPage } from '../../ui-page/harness';
import { fillGhostCardTaskAutoArchiveHint } from '../../../src/renderer/cindy-brain/ghostCardPrStatus';
import { Toast } from '../../../src/renderer/components/ui/toast/Toast';
import { Button } from '../../../src/renderer/components/ui/button';
import i18n from '../../../src/renderer/i18n';

const title = 'PR #9375 手机任务栏与聊天切换优化';
function Preview({ blocked }: { blocked: boolean }) {
  useEffect(() => {
    const fill = (state: 'pending' | 'cancelled') => fillGhostCardTaskAutoArchiveHint(document, state, {
      pending: i18n.t('chat.ghostCall.taskAutoArchivePending'),
      cancel: i18n.t('chat.ghostCall.taskAutoArchiveCancel'),
      cancelled: i18n.t('chat.ghostCall.taskAutoArchiveCancelled'),
    }, () => fill('cancelled'));
    if (!blocked) fill('pending');
  }, [blocked]);
  return <div className="p-6">
    {blocked ? <Toast item={{ id: 'dirty', variant: 'info',
      message: i18n.t('chat.ghostCall.taskAutoArchiveBlockedDirty', { title }),
      duration: 8000, createdAt: Date.now(), exiting: false,
    }} /> : <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      <div className="p-4">
        <div className="text-sm font-medium">#9375 perf(mobile): 统一任务栏与聊天切换，减少重复渲染和缓存读写</div>
        <div className="mt-1 text-xs text-[var(--text-secondary)]">makecindy/cindy · {i18n.t('chat.ghostCall.prStatus.merged')}</div>
      </div>
      <div className="flex flex-wrap items-center gap-4 border-t border-[var(--border-default)] px-4 py-3">
        <span className="flex-1 min-w-0 break-words text-xs text-[var(--text-secondary)]">cindy/mobile-interaction-beta-20261108 → main</span>
        <div className="flex items-center ml-auto"><Button variant="secondary" data-ghost-task-archive="makecindy/cindy#9375" data-ghost-task-archive-auto="">{i18n.t('chat.ghostCall.taskArchiveNow')}</Button></div>
      </div>
    </section>}
  </div>;
}
mountPage({ render: (ctx) => <Preview blocked={ctx.case === 'blocked'} /> });
