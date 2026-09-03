/**
 * VisibilityEditorDialog — 「管理可见性」弹窗,对齐 SkillHub 工作台同名能力。
 *
 * 归属由新服务根据当前 membership 固定：个人 Skill 只允许
 * public/private，组织 Skill 只允许 public/shared。客户端不再提供归属转移。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { Globe, Lock, Users, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { useAuth } from '@/contexts/AuthContext';
import { useSkillhubIdentityPolicy } from '../hooks/useSkillhubIdentityPolicy';

import { VisibilityCard } from '../PublishDialog';
import { marketActionErrorMessage } from '../lib/marketErrors';

export type VisibilityTier = 'public' | 'team' | 'private';

type VisibilityEditorDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 已发布 skill 的 slug */
  skillName: string;
  /** 当前可见档位(回显「当前」徽标) */
  currentTier: VisibilityTier;
  /** 当前归属:org = 团队归属 */
  currentOwnerType?: string;
  publicReview?: { status: 'pending' | 'rejected'; reason?: string };
  /** 保存成功后回调(父组件刷新详情) */
  onSaved: () => void;
  /** viewer 等无写权限时:弹窗只读打开(控件禁用 + 顶部提示),不能保存。 */
  readOnly?: boolean;
};

export function VisibilityEditorDialog({
  open,
  onOpenChange,
  skillName,
  currentTier,
  currentOwnerType,
  publicReview,
  onSaved,
  readOnly = false,
}: VisibilityEditorDialogProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const identityPolicy = useSkillhubIdentityPolicy(user);
  const currentOwnerIsTeam = currentOwnerType === 'org';

  // loading 初始为 true,且关闭时复位 —— Dialog 在数据就绪前不挂载,
  // 避免"先弹出矮窗再撑开"的跳变(设计规范:拿到数据后一次成型)。
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tier, setTier] = useState<VisibilityTier>(currentTier);

  useEffect(() => {
    if (!open) {
      setLoading(true);
      return;
    }
    // 每次打开都从当前状态重置(避免上次编辑残留)
    setTier(currentTier);
    setLoadError(null);
    setLoading(false);
  }, [open, currentTier]);

  // ── 校验(对齐 SkillHub StepMeta/管理弹窗规则) ──────────────────────────
  // ── 影响提示(SkillHub origin/main 同款文案) ───────────────────────────
  const tierChanged = tier !== currentTier;
  const leavingMarket = currentTier === 'public' && tier !== 'public';
  const teamOwnedToPrivate = currentOwnerIsTeam && tier === 'private';
  const tierAllowed = identityPolicy.allowedVisibilities.includes(
    tier === 'team' ? 'DEPARTMENT_SCOPED' : tier.toUpperCase() as 'PUBLIC' | 'PRIVATE',
  );
  const impactText = useMemo(() => {
    if (tier === 'private') {
      if (teamOwnedToPrivate) {
        return leavingMarket
          ? t('skillhub.visibilityEditor.impactPrivateTeamLeavingMarket')
          : t('skillhub.visibilityEditor.impactPrivateTeam');
      }
      if (leavingMarket) return t('skillhub.visibilityEditor.impactPrivateLeavingMarket');
      return tierChanged ? t('skillhub.visibilityEditor.impactPrivate') : null;
    }
    if (tier === 'team') {
      if (leavingMarket) return t('skillhub.visibilityEditor.impactTeamLeavingMarket');
      return tierChanged ? t('skillhub.visibilityEditor.impactTeam') : null;
    }
    return tierChanged ? t('skillhub.visibilityEditor.impactPublic') : null;
  }, [tier, tierChanged, leavingMarket, teamOwnedToPrivate, t]);

  const chooseTier = (next: VisibilityTier) => {
    setTier(next);
  };

  const handleSave = async () => {
    const publishVisibility = tier === 'team' ? 'DEPARTMENT_SCOPED' : tier.toUpperCase();
    if (!identityPolicy.allowedVisibilities.includes(publishVisibility as 'PUBLIC' | 'DEPARTMENT_SCOPED' | 'PRIVATE')) return;
    setSaving(true);
    try {
      const visibility = tier === 'team' ? 'shared' as const : tier;
      const previousCatalogScope = currentTier === 'public'
        ? 'market' as const
        : currentTier === 'team'
          ? 'team' as const
          : undefined;
      // 归属由服务端根据当前 membership 固定，客户端只修改可见性。
      const visRes = await window.electronAPI.skillhub.setPublishedVisibility({
        name: skillName,
        visibility,
        previousCatalogScope,
      });
      if (!visRes.success) {
        toast.error(marketActionErrorMessage(visRes.error, visRes.errorCode));
        return;
      }
      toast.success(visRes.result?.reviewStatus === 'pending'
        ? t('skillhub.visibilityEditor.publicReviewSubmitted')
        : t('skillhub.visibilityEditor.saved'));
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
                {t('skillhub.visibilityEditor.title')}
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
                {publicReview ? (
                  <div className="rounded-lg px-3 py-2 text-xs bg-[var(--chat-input-chip-bg)] text-[var(--settings-section-desc)]">
                    {publicReview.status === 'pending'
                      ? t('skillhub.visibilityEditor.publicReviewPending')
                      : t('skillhub.visibilityEditor.publicReviewRejected', { reason: publicReview.reason || '—' })}
                  </div>
                ) : null}
                {/* 可见范围三卡(与发布弹窗共用 VisibilityCard) */}
                <div className="flex flex-col gap-1.5">
                  <span className="block px-0.5 text-13 font-medium text-[var(--settings-section-desc)]">
                    {t('skillhub.visibilityEditor.tierLabel')}
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    <VisibilityCard
                      value="PUBLIC"
                      label={t('skillhub.visibilityEditor.tierPublic')}
                      description={t('skillhub.visibilityEditor.tierPublicDesc')}
                      icon={<Globe size={14} strokeWidth={1.75} />}
                      disabled={readOnly}
                      selected={tier === 'public'}
                      onSelect={() => chooseTier('public')}
                    />
                    {identityPolicy.ownerType === 'organization' ? (
                      <VisibilityCard
                        value="DEPARTMENT_SCOPED"
                        label={t('skillhub.visibilityEditor.tierTeam')}
                        description={t('skillhub.visibilityEditor.tierTeamDesc')}
                        icon={<Users size={14} strokeWidth={1.75} />}
                        disabled={readOnly}
                        selected={tier === 'team'}
                        onSelect={() => chooseTier('team')}
                      />
                    ) : (
                      <VisibilityCard
                        value="PRIVATE"
                        label={t('skillhub.visibilityEditor.tierPrivate')}
                        description={t('skillhub.visibilityEditor.tierPrivateDesc')}
                        icon={<Lock size={14} strokeWidth={1.75} />}
                        disabled={readOnly}
                        selected={tier === 'private'}
                        onSelect={() => chooseTier('private')}
                      />
                    )}
                  </div>
                </div>

                {/* 影响提示 */}
                {impactText ? (
                  <div
                    className={cn(
                      'rounded-xl px-3.5 py-3 text-xs leading-[1.6]',
                      teamOwnedToPrivate
                        ? 'bg-[var(--error-bg)] text-[var(--error-fg)]'
                        : 'bg-[var(--chat-input-chip-bg)] text-[var(--settings-source-meta)]',
                    )}
                  >
                    {impactText}
                  </div>
                ) : null}
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
              disabled={loading || saving || Boolean(loadError) || !tierAllowed || readOnly
                || (tier === 'public' && currentTier !== 'public' && publicReview?.status === 'pending')}
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
              {saving
                ? t('skillhub.visibilityEditor.saving')
                : tier === 'public' && currentTier !== 'public'
                  ? publicReview?.status === 'pending'
                    ? t('skillhub.visibilityEditor.waitingReview')
                    : t('skillhub.visibilityEditor.submitReview')
                  : t('skillhub.visibilityEditor.save')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
