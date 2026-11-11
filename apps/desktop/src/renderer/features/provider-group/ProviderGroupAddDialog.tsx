/**
 * 把电脑加入供应商组(docs/product-rules/provider-groups.md §3、设计稿场景 3)：
 *
 * - 「已经能用的」：这台电脑已经能用的同一个供应商——你的其他电脑(已开「允许被远程调用」)和
 *   别人分享给你的，与模型列表里的远程供应商同一个来源，勾选即可加入，不需要再申请；
 * - 「分享链接」：在组所在电脑走现有申请流程；远程管理时引导去那台电脑申请，避免在查看端领用。
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
import { providerShareComputerName } from '@/features/provider-share/providerShareNames';
import { cn } from '@/lib/utils';
import { providerGroupManagementCommand } from './providerManagement';

import {
  PROVIDER_GROUP_DEFAULT_LIMIT,
  PROVIDER_GROUP_DEFAULT_WEIGHT,
  PROVIDER_GROUP_LOCAL_MEMBER_KEY,
  providerGroupPhysicalDeviceKey,
  type ProviderGroupCandidate,
  type ProviderGroupConfig,
  type ProviderGroupMember,
} from '../../../shared/providerGroup';
import { groupProviderGroupItems } from './providerGroupPresentation';

type Tab = 'available' | 'link';

export function ProviderGroupAddDialog({
  providerId,
  providerName,
  config,
  deviceId,
  onSave,
  onClose,
}: {
  providerId: string;
  providerName: string;
  config: ProviderGroupConfig | null;
  deviceId?: string;
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
    providerGroupManagementCommand({ action: 'candidates', providerId }, deviceId)
      .then((list) => {
        if (alive) setCandidates(list);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [providerId, deviceId]);

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
      providerName: c.providerName,
      ...(c.hostDeviceId ? { hostDeviceId: c.hostDeviceId } : {}),
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
        providerName,
        limit: PROVIDER_GROUP_DEFAULT_LIMIT,
        weight: PROVIDER_GROUP_DEFAULT_WEIGHT,
        paused: false,
      }],
    };
    // 每个都是组里原来没有的电脑才说「N 台电脑」；同一台的几个账号、或已在组里那台电脑的另一个账号，按账号说。
    const present = new Set(base.members.map(providerGroupPhysicalDeviceKey));
    const devices = new Set(added.map(providerGroupPhysicalDeviceKey));
    const newComputers = devices.size === added.length && [...devices].every((key) => !present.has(key));
    setSaving(true);
    try {
      const saved = await onSave(
        { ...base, members: [...base.members, ...added] },
        t(newComputers ? 'providerGroup.toast.added' : 'providerGroup.toast.addedAccounts', {
          count: added.length,
          provider: providerName,
        }),
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
                groupProviderGroupItems(candidates ?? []).map((device, index) => {
                  const first = device.items[0];
                  // 分享来的电脑只用分享者的昵称称呼，不用电脑名(provider-sharing.md §6)。
                  const computer = first.kind === 'share' ? providerShareComputerName(t, first.ownerName) : first.label;
                  const source = first.kind === 'device'
                    ? t('providerGroup.member.sourceDevice')
                    : t('providerGroup.member.sourceShare', { name: first.ownerName ?? '' });
                  const divider = index > 0 && 'border-t border-[var(--border-default)]';
                  const toggle = (key: string) =>
                    setPicked((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    });
                  // 只有一个账号的电脑不分两层：一行写电脑，账号写在来源后面。
                  if (device.items.length === 1) {
                    return (
                      <CandidateRow
                        key={first.key}
                        candidate={first}
                        checked={first.blocked === 'member' || picked.has(first.key)}
                        disabled={saving}
                        title={computer}
                        detail={[source, first.providerName]}
                        onToggle={() => toggle(first.key)}
                        className={divider}
                      />
                    );
                  }
                  return (
                    <div key={device.key} data-testid="provider-group-candidate-device" className={cn(divider)}>
                      {/* 电脑这一层只是标题，勾选的仍是下面每个账号(组里各占一个位置)。 */}
                      <div className="flex items-center gap-3 px-4 py-2.5">
                        <span aria-hidden="true" className="w-5 shrink-0" />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-13 font-medium text-[var(--text-primary)]">{computer}</span>
                          <span className="truncate text-12 text-[var(--text-secondary)]">
                            {[source, t('providerGroup.member.accountCount', { count: device.items.length })].join(' · ')}
                          </span>
                        </span>
                      </div>
                      {device.items.map((candidate) => (
                        <CandidateRow
                          key={candidate.key}
                          nested
                          candidate={candidate}
                          checked={candidate.blocked === 'member' || picked.has(candidate.key)}
                          disabled={saving}
                          title={candidate.providerName}
                          detail={[]}
                          onToggle={() => toggle(candidate.key)}
                        />
                      ))}
                    </div>
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
              {deviceId
                ? t('providerGroup.add.remoteLinkDescription')
                : t('providerGroup.add.linkDescription', { provider: providerName })}
            </p>
            <ProviderShareDialogFooter>
              <Button variant="cta" size="md" disabled={Boolean(deviceId)} onClick={() => setPasteOpen(true)}>
                {t('providerGroup.add.pasteLink')}
              </Button>
              <Button variant="secondary" size="md" onClick={onClose}>
                {t('providerGroup.add.cancel')}
              </Button>
            </ProviderShareDialogFooter>
          </>
        )}
      </ProviderShareDialog>
      {pasteOpen && !deviceId && (
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

/**
 * 可以加入的一个账号。`nested` 时收在电脑标题下面：空出勾选框那一列，分隔线从账号起；
 * 否则就是只有一个账号的电脑那一整行。
 */
function CandidateRow({
  candidate,
  nested = false,
  checked,
  disabled,
  title,
  detail,
  onToggle,
  className,
}: {
  candidate: ProviderGroupCandidate;
  nested?: boolean;
  checked: boolean;
  disabled: boolean;
  title: string;
  detail: readonly string[];
  onToggle: () => void;
  className?: string | false;
}) {
  const { t } = useTranslation();
  const member = candidate.blocked === 'member';
  const lines = [...detail, member ? t('providerGroup.add.alreadyMember') : null].filter(Boolean);
  const content = (
    <>
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
        <span className="truncate text-13 text-[var(--text-primary)]">{title}</span>
        {lines.length > 0 && (
          <span className="truncate text-12 text-[var(--text-secondary)]">{lines.join(' · ')}</span>
        )}
      </span>
    </>
  );
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={member || disabled}
      data-testid="provider-group-candidate"
      onClick={onToggle}
      className={cn(
        'flex w-full text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
        member ? 'cursor-default opacity-60' : 'hover:bg-sidebar-item-hover',
        nested ? 'pl-4' : 'items-center gap-3 px-4 py-2.5',
        className,
      )}
    >
      {nested ? (
        <>
          <span aria-hidden="true" className="w-5 shrink-0" />
          <span className="ml-3 flex min-w-0 flex-1 items-center gap-3 border-t border-[var(--border-default)] py-2.5 pr-4">
            {content}
          </span>
        </>
      ) : content}
    </button>
  );
}
