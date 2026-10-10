/**
 * 把电脑加入供应商组(docs/product-rules/provider-groups.md §3、设计稿场景 3)：
 *
 * - 「已经能用的」：这台电脑已经能用的同一个供应商——你的其他电脑(已开「允许被远程调用」)和
 *   别人分享给你的，与模型列表里的远程供应商同一个来源，勾选即可加入，不需要再申请；
 * - 「分享链接」：还不能用的别人的电脑，粘贴分享链接走现有申请流程，对方同意后回到这里勾选。
 */
import { Check } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import {
  ProviderShareDialog,
  ProviderShareDialogFooter,
  ProviderShareDialogTitle,
} from '@/features/provider-share/ProviderShareDialog';
import { ProviderSharePasteDialog } from '@/features/provider-share/ProviderSharePasteDialog';
import { cn } from '@/lib/utils';

import {
  PROVIDER_GROUP_DEFAULT_LIMIT,
  PROVIDER_GROUP_DEFAULT_WEIGHT,
  PROVIDER_GROUP_LOCAL_MEMBER_KEY,
  type ProviderGroupCandidate,
  type ProviderGroupConfig,
  type ProviderGroupMember,
} from '../../../shared/providerGroup';

type Tab = 'available' | 'link';

export function ProviderGroupAddDialog({
  providerId,
  providerName,
  config,
  onSave,
  onClose,
}: {
  providerId: string;
  providerName: string;
  config: ProviderGroupConfig | null;
  /** 保存成功返回 true；失败时调用方已提示，弹窗保持打开。 */
  onSave: (config: ProviderGroupConfig, success: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('available');
  const [candidates, setCandidates] = useState<ProviderGroupCandidate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    window.electronAPI.providerGroup
      .command({ action: 'candidates', providerId })
      .then((list) => {
        if (alive) setCandidates(list);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [providerId]);

  const selectable = useMemo(() => (candidates ?? []).filter((c) => !c.blocked), [candidates]);

  const submit = async () => {
    const chosen = selectable.filter((c) => picked.has(c.key));
    if (chosen.length === 0) return;
    const added: ProviderGroupMember[] = chosen.map((c) => ({
      key: c.key,
      kind: c.kind,
      agentDeviceId: c.agentDeviceId,
      providerId: c.providerId,
      label: c.label,
      limit: PROVIDER_GROUP_DEFAULT_LIMIT,
      weight: PROVIDER_GROUP_DEFAULT_WEIGHT,
      paused: false,
    }));
    // 第一次建组：本机默认在组里(可以在组里关掉)。
    const base: ProviderGroupConfig = config ?? {
      strategy: 'least',
      autoSwitch: true,
      members: [{
        key: PROVIDER_GROUP_LOCAL_MEMBER_KEY,
        kind: 'local',
        agentDeviceId: null,
        providerId,
        limit: PROVIDER_GROUP_DEFAULT_LIMIT,
        weight: PROVIDER_GROUP_DEFAULT_WEIGHT,
        paused: false,
      }],
    };
    setSaving(true);
    try {
      const saved = await onSave(
        { ...base, members: [...base.members, ...added] },
        t('providerGroup.toast.added', { count: added.length, provider: providerName }),
      );
      if (saved) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <ProviderShareDialog open onOpenChange={(open) => { if (!open) onClose(); }} busy={saving} maxWidth={520} testId="provider-group-add-dialog">
        <ProviderShareDialogTitle>{t('providerGroup.add.title', { provider: providerName })}</ProviderShareDialogTitle>
        <div className="mt-4">
          <SegmentedControl
            value={tab}
            onValueChange={(next: Tab) => setTab(next)}
            aria-label={t('providerGroup.add.sourceAria')}
            options={[
              { value: 'available', label: t('providerGroup.add.tabAvailable') },
              { value: 'link', label: t('providerGroup.add.tabLink') },
            ]}
          />
        </div>

        {tab === 'available' ? (
          <>
            <p className="mt-3 text-13 leading-[1.5] text-[var(--confirm-desc)]">
              {/* 标题已经写了供应商与供应商组，这里只说来源与「不用再申请」。 */}
              {t('providerGroup.add.availableDescription')}
            </p>
            <div className="mt-3 overflow-hidden rounded-xl border border-[var(--border-default)]">
              {candidates === null && !failed ? (
                <div className="flex items-center justify-center gap-2 px-4 py-7 text-13 text-[var(--text-secondary)]">
                  <Spinner size={14} aria-hidden />
                  {t('providerGroup.add.loading')}
                </div>
              ) : failed ? (
                <p className="px-4 py-7 text-center text-13 text-[var(--text-secondary)]">{t('providerGroup.add.loadFailed')}</p>
              ) : (candidates ?? []).length === 0 ? (
                <p className="px-4 py-7 text-center text-13 leading-[1.5] text-[var(--text-secondary)]">
                  {t('providerGroup.add.empty', { provider: providerName })}
                </p>
              ) : (
                (candidates ?? []).map((candidate, index) => {
                  const member = candidate.blocked === 'member';
                  const checked = member || picked.has(candidate.key);
                  return (
                    <button
                      key={candidate.key}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      disabled={member || saving}
                      data-testid="provider-group-candidate"
                      onClick={() =>
                        setPicked((current) => {
                          const next = new Set(current);
                          if (next.has(candidate.key)) next.delete(candidate.key);
                          else next.add(candidate.key);
                          return next;
                        })
                      }
                      className={cn(
                        'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
                        index > 0 && 'border-t border-[var(--border-default)]',
                        member ? 'cursor-default opacity-60' : 'hover:bg-sidebar-item-hover',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          // 与消息分享选择框同一套圆形勾选(pill 档)。
                          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                          checked
                            ? 'bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]'
                            : 'border border-[var(--border-default)]',
                        )}
                      >
                        {checked && <Check size={12} strokeWidth={2.5} />}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-13 text-[var(--text-primary)]">{candidate.label}</span>
                        <span className="truncate text-12 text-[var(--text-secondary)]">
                          {[
                            candidate.kind === 'device'
                              ? t('providerGroup.member.sourceDevice')
                              : t('providerGroup.member.sourceShare', { name: candidate.ownerName ?? '' }),
                            candidate.providerName,
                            member ? t('providerGroup.add.alreadyMember') : null,
                          ].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            <ProviderShareDialogFooter>
              <Button
                variant="cta"
                size="md"
                loading={saving}
                disabled={saving || selectable.every((c) => !picked.has(c.key))}
                onClick={() => void submit()}
              >
                {t('providerGroup.add.confirm')}
              </Button>
              <Button variant="secondary" size="md" disabled={saving} onClick={onClose}>
                {t('providerGroup.add.cancel')}
              </Button>
            </ProviderShareDialogFooter>
          </>
        ) : (
          <>
            <p className="mt-3 text-13 leading-[1.5] text-[var(--confirm-desc)]">
              {t('providerGroup.add.linkDescription', { provider: providerName })}
            </p>
            <ProviderShareDialogFooter>
              <Button variant="cta" size="md" onClick={() => setPasteOpen(true)}>
                {t('providerGroup.add.pasteLink')}
              </Button>
              <Button variant="secondary" size="md" onClick={onClose}>
                {t('providerGroup.add.cancel')}
              </Button>
            </ProviderShareDialogFooter>
          </>
        )}
      </ProviderShareDialog>
      {pasteOpen && (
        <ProviderSharePasteDialog
          onClose={() => {
            setPasteOpen(false);
            onClose();
          }}
        />
      )}
    </>
  );
}
