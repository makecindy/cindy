/**
 * MarketInfoEditDialog — 编辑市场展示信息(显示名/描述/分类)。
 * 列表卡片菜单与详情页「编辑信息」共用;弹窗形态,关闭即回到来源页,
 * 替代旧的整页 SkillhubMarketManageView 跳转(取消固定回详情页的问题)。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';

import { marketActionErrorMessage } from '../lib/marketErrors';
import { PlatformTagSelector } from './PlatformTagSelector';
import type { MarketCategory } from '../../../../shared/skillhubCategory';
import { SUPPORTED_LOCALES, type SupportedLocale } from '../../../../shared/locale';

const DESCRIPTION_LIMIT = 2_000;
const DISPLAY_NAME_LIMIT = 100;

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block px-0.5 text-13 font-medium text-[var(--settings-section-desc)]">
      {children}
    </label>
  );
}

type MarketInfoEditDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 已发布 skill 的 slug */
  skillName: string;
  /** 列表/详情上已经有的当前分类,用于详情接口缺字段时回显兜底 */
  currentCategories?: string[];
  /** 保存成功后回调(来源页刷新数据) */
  onSaved: () => void;
  /** viewer 等无写权限时:弹窗只读打开(输入禁用 + 顶部提示),不能保存。 */
  readOnly?: boolean;
};

export function MarketInfoEditDialog({
  open,
  onOpenChange,
  skillName,
  currentCategories = [],
  onSaved,
  readOnly = false,
}: MarketInfoEditDialogProps) {
  const { t, i18n } = useTranslation();
  // loading 初始为 true,且关闭时复位 —— Dialog 在数据就绪前不挂载,
  // 避免"先弹出矮窗再撑开"的跳变(设计规范:拿到数据后一次成型)。
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [categorySlugs, setCategorySlugs] = useState<string[]>([]);
  const [categories, setCategories] = useState<MarketCategory[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);

  useEffect(() => {
    if (!open) {
      setLoading(true);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setCategoriesLoading(true);
    void Promise.all([
      window.electronAPI.skillhub.info(skillName),
      window.electronAPI.skillhub.listCategories(),
    ]).then(([infoRes, catRes]) => {
      if (cancelled) return;
      setLoading(false);
      setCategoriesLoading(false);
      if (!infoRes.success || !infoRes.info) {
        setLoadError(marketActionErrorMessage(infoRes.error, infoRes.errorCode));
        return;
      }
      setDisplayName(infoRes.info.displayName);
      setDescription(infoRes.info.description);
      const platformBySlug = new Map(
        (catRes.success ? catRes.categories ?? [] : []).map((category) => [category.slug, category]),
      );
      // Preserve current Platform tags that are hidden from this category result
      // so an unrelated metadata edit does not silently clear them.
      for (const tag of infoRes.info.tags ?? []) {
        if (platformBySlug.has(tag.slug)) continue;
        platformBySlug.set(tag.slug, {
          slug: tag.slug,
          name: tag.name,
          count: 0,
          myCount: 1,
          source: 'platform',
        });
      }
      const platformCategories = [...platformBySlug.values()];
      const currentTagSlugs = [...new Set([
        ...(infoRes.info.tags ?? []).map((tag) => tag.slug),
        ...(infoRes.info.categories ?? []),
        ...currentCategories,
      ].filter((slug) => platformBySlug.has(slug)))];
      setCategorySlugs(currentTagSlugs);
      setCategories(platformCategories);
    });
    return () => { cancelled = true; };
  }, [open, skillName, currentCategories]);

  const displayNameMissing = displayName.trim().length === 0;
  const displayNameOverLimit = displayName.length > DISPLAY_NAME_LIMIT;
  const descriptionLength = Array.from(description).length;
  const descriptionOverLimit = descriptionLength > DESCRIPTION_LIMIT;
  const invalid = displayNameMissing || displayNameOverLimit || descriptionOverLimit
    || categorySlugs.length > 50;

  const handleSave = async () => {
    if (invalid || saving) return;
    setSaving(true);
    try {
      const res = await window.electronAPI.skillhub.updatePublished({
        name: skillName,
        fields: {
          displayName: displayName.trim(),
          summary: description,
          description,
          contentLocale: (SUPPORTED_LOCALES as readonly string[]).includes(i18n.resolvedLanguage ?? '')
            ? i18n.resolvedLanguage as SupportedLocale
            : 'en',
          tags: categorySlugs,
        },
      });
      if (!res.success) {
        toast.error(marketActionErrorMessage(res.error, res.errorCode));
        return;
      }
      toast.success(t('skillhub.marketEdit.saved'));
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open && !loading} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'w-full max-w-[480px] rounded-xl',
            'border bg-[var(--cmd-palette-bg)] border-[var(--cmd-palette-border)]',
            'max-h-[85vh] overflow-y-auto',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between px-5 pt-5">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-lg font-medium text-[var(--msg-assistant-text)]">
                {t('skillhub.marketActions.edit')}
              </Dialog.Title>
              <span className="text-xs text-[var(--cmd-palette-item-meta)]">{skillName}</span>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full',
                'text-[var(--settings-theme-icon)] hover:bg-[var(--confirm-btn-secondary-hover)]',
                'transition-colors',
              )}
              aria-label={t('skillhub.publishDialog.closeAria')}
            >
              <X size={15} />
            </button>
          </div>

          <div className="flex flex-col gap-4 px-5 pt-4 pb-1">
            {loadError ? (
              <p className="py-4 text-sm text-[var(--cmd-palette-item-meta)]">{loadError}</p>
            ) : (
              <>
                {readOnly ? (
                  <div className="rounded-lg px-3 py-2 text-xs bg-[var(--chat-input-chip-bg)] text-[var(--settings-section-desc)]">
                    {t('skillhub.market.noManagePermission')}
                  </div>
                ) : null}
                {/* 显示名 */}
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>{t('skillhub.publishDialog.displayNameLabel')}</FieldLabel>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    disabled={readOnly}
                    className={cn(
                      'w-full rounded-full border px-3 py-2 text-sm',
                      'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
                      'border-[var(--settings-input-border)]',
                      'focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)] focus:border-transparent',
                      'transition-colors select-text',
                      'disabled:cursor-not-allowed disabled:opacity-60',
                    )}
                  />
                  {displayNameMissing ? (
                    <p className="px-0.5 text-xs text-[var(--cmd-palette-item-meta)]">
                      {t('skillhub.marketEdit.displayNameRequired')}
                    </p>
                  ) : null}
                </div>

                {/* 描述 — 计数在标签行右侧,与发布弹窗一致 */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <FieldLabel>{t('skillhub.publishDialog.descriptionLabel')}</FieldLabel>
                    <span
                      className={cn(
                        'px-0.5 text-xs tabular-nums',
                        descriptionOverLimit ? 'text-[var(--error-fg)]' : 'text-[var(--settings-source-meta)]',
                      )}
                    >
                      {descriptionLength}/{DESCRIPTION_LIMIT}
                    </span>
                  </div>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={4}
                    disabled={readOnly}
                    className={cn(
                      'w-full resize-none rounded-xl border px-3 py-2 text-sm',
                      'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
                      'border-[var(--settings-input-border)]',
                      'focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)] focus:border-transparent',
                      'transition-colors select-text',
                      'disabled:cursor-not-allowed disabled:opacity-60',
                    )}
                  />
                </div>

                {/* 平台标签 */}
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>{t('skillhub.publishDialog.categoryLabel')}</FieldLabel>
                  <PlatformTagSelector
                    categories={categories}
                    value={categorySlugs}
                    onChange={setCategorySlugs}
                    disabled={readOnly || categoriesLoading || categories.length === 0}
                    ariaLabel={t('skillhub.publishDialog.categoryLabel')}
                    placeholder={t('skillhub.publishDialog.categoryPlaceholder')}
                  />
                  {categoriesLoading ? (
                    <p className="px-0.5 text-xs text-[var(--cmd-palette-item-meta)]">
                      {t('skillhub.publishDialog.categoryLoading')}
                    </p>
                  ) : categories.length === 0 ? (
                    <p className="px-0.5 text-xs text-[var(--cmd-palette-item-meta)]">
                      {t('skillhub.publishDialog.categoryEmpty')}
                    </p>
                  ) : null}
                </div>
              </>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 p-4">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={cn(
                'inline-flex h-8 items-center justify-center rounded-full px-4',
                'text-sm font-normal border bg-[var(--cmd-palette-bg)]',
                'border-[var(--confirm-btn-secondary-border)] text-[var(--settings-btn-secondary-text)]',
                'hover:bg-[var(--surface-hover)] transition-colors',
              )}
            >
              {t('skillhub.publishDialog.cancel')}
            </button>
            <button
              type="button"
              disabled={loading || saving || Boolean(loadError) || invalid || readOnly}
              onClick={() => void handleSave()}
              className={cn(
                'inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-4',
                'text-sm font-medium leading-none',
                'bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)]',
                'hover:bg-[var(--lightbox-cta-hover)] transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {saving ? <Spinner size={14} /> : null}
              {saving ? t('skillhub.visibilityEditor.saving') : t('skillhub.visibilityEditor.save')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
