import { Button } from '@/components/ui/button';
/**
 * ContactsImportDialog — 通讯录批量导入流程(三步: 选来源 → 预览勾选 → 结果)。
 *
 * 来源: macOS 系统通讯录(IPC 触发 JXA 只读拉取, 首次弹系统授权)/ vCard 文件
 * (跨平台, renderer 直接读文件文本用 maker-core 的 parseVCards 解析)。
 * 导入执行走 main 侧管道(identity 撞档自动并入 / 名字相似进 needsReview /
 * 全新创建), 本组件只做预览与勾选, 不实现归并逻辑。
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { FileText, Users, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import {
  contactsService,
  contactsErrorI18nKey,
  isContactsIpcCode,
  type ImportContactRecord,
  type ImportSummary,
} from '@/lib/contactsService';

const log = createLogger('ContactsImportDialog');

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = 'pick' | 'preview' | 'done';

export function ContactsImportDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const isMac = window.electronAPI?.platform === 'darwin';
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('pick');
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<ImportContactRecord[]>([]);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const reset = () => {
    setStep('pick');
    setLoading(false);
    setRecords([]);
    setChecked(new Set());
    setGroupName('');
    setSummary(null);
  };

  const handleOpenChange = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const enterPreview = (recs: ImportContactRecord[]) => {
    if (recs.length === 0) {
      toast.error(t('settings.contacts.import.emptySource'));
      return;
    }
    setRecords(recs);
    setChecked(new Set(recs.map((_, i) => i)));
    setStep('preview');
  };

  const loadSystem = async () => {
    setLoading(true);
    try {
      enterPreview(await contactsService.systemRead());
    } catch (err) {
      log.warn('system contacts read failed', err);
      // 规则 13: IPC 错误统一 extractIpcError 解码, 不手写 message 字符串匹配
      toast.error(
        isContactsIpcCode(err, 'PERMISSION_DENIED')
          ? t('settings.contacts.import.permissionDenied')
          : t('settings.contacts.import.systemReadFailed'),
      );
    } finally {
      setLoading(false);
    }
  };

  const loadVcf = async (file: File) => {
    setLoading(true);
    try {
      // 解析在 main 侧做 — renderer runtime import maker-core 会把 node 内置模块
      // 拉进浏览器 bundle 直接白屏(barrel 含 agents/fs/child_process)
      enterPreview(await contactsService.parseVcf(await file.text()));
    } catch (err) {
      log.warn('vcf parse failed', err);
      toast.error(t('settings.contacts.import.vcfParseFailed'));
    } finally {
      setLoading(false);
    }
  };

  const runImport = async () => {
    const selected = records.filter((_, i) => checked.has(i));
    if (selected.length === 0) return;
    setLoading(true);
    try {
      let groupId: string | undefined;
      let createdGroupId: string | undefined;
      const name = groupName.trim();
      if (name) {
        const groups = await contactsService.groupsList();
        const existing = groups.find((g) => g.name === name);
        if (existing) {
          groupId = existing.id;
        } else {
          groupId = (await contactsService.groupsCreate(name)).id;
          createdGroupId = groupId;
        }
      }
      try {
        const result = await contactsService.import(selected, groupId ? { groupId } : undefined);
        setSummary(result);
        setStep('done');
      } catch (err) {
        // 导入失败时清掉本次刚建的空分组, 不留孤儿组
        if (createdGroupId) await contactsService.groupsDelete(createdGroupId).catch(() => undefined);
        throw err;
      }
    } catch (err) {
      log.warn('contacts import failed', err);
      toast.error(t(contactsErrorI18nKey(err)));
    } finally {
      setLoading(false);
    }
  };

  const checkedCount = checked.size;
  const allChecked = checkedCount === records.length;
  const sourceBtnCls = cn(
    'flex flex-1 flex-col items-center gap-2 rounded-xl border border-[var(--settings-theme-card-border)] p-5 transition-colors',
    'text-[var(--settings-section-title)] hover:bg-[var(--settings-input-bg)]',
    'disabled:cursor-not-allowed disabled:opacity-50',
  );

  const needsReviewNames = useMemo(
    () => summary?.needsReview.map((r) => r.displayName).join('、') ?? '',
    [summary],
  );
  const identityConflictNames = useMemo(
    () => [...new Set(summary?.identityConflicts.map((c) => c.displayName) ?? [])].join('、'),
    [summary],
  );
  const relationErrorNames = useMemo(
    () => [...new Set(summary?.relationErrors.map((r) => r.displayName) ?? [])].join('、'),
    [summary],
  );

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10001] bg-[var(--overlay-modal)]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(e) => e.preventDefault()}
          className={cn(
            'fixed left-1/2 top-1/2 z-[10001] -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[76vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-xl',
            'border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <header className="flex shrink-0 items-center justify-between py-3.5 pl-5 pr-3.5">
            <Dialog.Title className="text-15 font-medium text-[var(--settings-section-title)]">
              {t('settings.contacts.import.title')}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={t('settings.contacts.manager.closeAria')}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--settings-section-desc)] hover:bg-[var(--settings-input-bg)]"
              >
                <X size={15} />
              </button>
            </Dialog.Close>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-5">
            {step === 'pick' && (
              <>
                <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
                  {t('settings.contacts.import.pickHint')}
                </p>
                <div className="flex gap-3">
                  {isMac && (
                    <button type="button" disabled={loading} onClick={() => void loadSystem()} className={sourceBtnCls}>
                      <Users size={22} />
                      <span className="text-13 font-medium">{t('settings.contacts.import.sourceSystem')}</span>
                      <span className="text-11 text-[var(--settings-section-desc)]">
                        {t('settings.contacts.import.sourceSystemDesc')}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => fileRef.current?.click()}
                    className={sourceBtnCls}
                  >
                    <FileText size={22} />
                    <span className="text-13 font-medium">{t('settings.contacts.import.sourceVcf')}</span>
                    <span className="text-11 text-[var(--settings-section-desc)]">
                      {t('settings.contacts.import.sourceVcfDesc')}
                    </span>
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".vcf,text/vcard"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) void loadVcf(f);
                    }}
                  />
                </div>
              </>
            )}

            {step === 'preview' && (
              <>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-12 text-[var(--settings-section-desc)]">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={() =>
                        setChecked(allChecked ? new Set() : new Set(records.map((_, i) => i)))
                      }
                    />
                    {t('settings.contacts.import.selectedCount', { checked: checkedCount, total: records.length })}
                  </label>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--settings-theme-card-border)]">
                  {records.map((r, i) => (
                    <label
                      key={i}
                      className="flex cursor-pointer items-center gap-2.5 border-b border-[var(--settings-theme-card-border)] px-3 py-2 last:border-b-0 hover:bg-[var(--settings-input-bg)]"
                    >
                      <input
                        type="checkbox"
                        checked={checked.has(i)}
                        onChange={() =>
                          setChecked((prev) => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          })
                        }
                      />
                      <span className="w-[140px] shrink-0 truncate text-13 font-medium text-[var(--settings-section-title)]">
                        {r.displayName}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-12 text-[var(--settings-section-desc)]">
                        {r.emails[0]?.value ?? r.phones[0]?.value ?? ''}
                      </span>
                      {r.org && (
                        <span className="max-w-[120px] shrink-0 truncate text-11 text-[var(--settings-section-desc)]">
                          {r.org}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <input
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    placeholder={t('settings.contacts.import.groupPlaceholder')}
                    className={cn(
                      'h-8 min-w-0 flex-1 rounded-lg bg-[var(--settings-input-bg)] px-2.5 text-13 outline-none',
                      'text-[var(--settings-input-text)] placeholder:text-[var(--settings-section-desc)]',
                    )}
                  />
                  <Button
                    variant="cta"
                    size="md"
                    compact
                    loading={loading}
                    type="button"
                    disabled={loading || checkedCount === 0}
                    onClick={() => void runImport()}
                  >
                    {loading
                      ? t('settings.contacts.import.running')
                      : t('settings.contacts.import.run', { count: checkedCount })}
                  </Button>
                </div>
              </>
            )}

            {step === 'done' && summary && (
              <div className="flex flex-col gap-2.5">
                <p className="text-13 leading-[1.6] text-[var(--settings-section-title)]">
                  {t('settings.contacts.import.doneSummary', {
                    created: summary.created,
                    enriched: summary.enriched,
                    orgs: summary.orgsCreated,
                  })}
                </p>
                {summary.needsReview.length > 0 && (
                  <p className="rounded-lg bg-[var(--warning-bg-soft)] px-3 py-2 text-12 leading-[1.5] text-[var(--settings-section-title)]">
                    {t('settings.contacts.import.needsReview', {
                      count: summary.needsReview.length,
                      names: needsReviewNames,
                    })}
                  </p>
                )}
                {summary.identityConflicts.length > 0 && (
                  <p className="rounded-lg bg-[var(--warning-bg-soft)] px-3 py-2 text-12 leading-[1.5] text-[var(--settings-section-title)]">
                    {t('settings.contacts.import.identityConflicts', {
                      count: summary.identityConflicts.length,
                      names: identityConflictNames,
                    })}
                  </p>
                )}
                {summary.relationErrors.length > 0 && (
                  <p className="text-12 text-[var(--settings-section-desc)]">
                    {t('settings.contacts.import.relationErrors', {
                      count: summary.relationErrors.length,
                      names: relationErrorNames,
                    })}
                  </p>
                )}
                {summary.skipped.length > 0 && (
                  <p className="text-12 text-[var(--settings-section-desc)]">
                    {t('settings.contacts.import.skipped', { count: summary.skipped.length })}
                  </p>
                )}
                <Button
                  variant="secondary"
                  size="md"
                  compact
                  type="button"
                  onClick={() => handleOpenChange(false)}
                  className="self-end"
                >
                  {t('settings.contacts.manager.closeAria')}
                </Button>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
