import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from '@/lib/toast';
import { MarketInfoEditDialog } from '../components/MarketInfoEditDialog';
import { type MarketCardManageAction } from '../components/MarketCard';
import { VisibilityEditorDialog, type VisibilityTier } from '../components/VisibilityEditorDialog';
import { marketActionErrorMessage } from '../lib/marketErrors';
import { refresh as refreshSkillhub } from './useSkillhub';
import type { MarketSkill } from './useMarketList';
import { useSkillhubIdentityPolicy } from './useSkillhubIdentityPolicy';

export interface MarketManagementController {
  editTarget: MarketSkill | null;
  visibilityTarget: MarketSkill | null;
  handleManageAction: (skill: MarketSkill, action: MarketCardManageAction) => void;
  closeEdit: () => void;
  closeVisibility: () => void;
  editSaved: () => void;
  visibilitySaved: () => void;
  isReadOnly: (skill: MarketSkill) => boolean;
}

/** Shares the SkillHub ownership and mutation behavior between both market surfaces. */
export function useMarketManagement(options: {
  active: boolean;
  reload: () => void;
  onClone: (skill: MarketSkill) => void;
  onDeleted?: (skill: MarketSkill) => void;
}): MarketManagementController {
  const { reload, onClone, onDeleted } = options;
  const { t } = useTranslation();
  const { user } = useAuth();
  const identityPolicy = useSkillhubIdentityPolicy(user);
  const { confirm } = useConfirmDialog();
  const [editTarget, setEditTarget] = useState<MarketSkill | null>(null);
  const [visibilityTarget, setVisibilityTarget] = useState<MarketSkill | null>(null);
  const isReadOnly = useCallback(
    (skill: MarketSkill) => !identityPolicy.canWrite || !skill.canManage,
    [identityPolicy.canWrite],
  );

  const handleDelete = useCallback(async (skill: MarketSkill) => {
    const skillName = skill.displayName || skill.name;
    const ok = await confirm({
      title: t('skillhub.marketConfirm.deleteTitle', { name: skillName }),
      description: t('skillhub.marketConfirm.deleteDesc', { name: skillName }),
      confirmText: t('skillhub.marketConfirm.deleteConfirm'),
      cancelText: t('skillhub.publishDialog.cancel'),
    });
    if (!ok) return;

    const res = await window.electronAPI.skillhub.deletePublished(skill.name);
    if (!res.success) {
      toast.error(marketActionErrorMessage(res.error, res.errorCode, t));
      return;
    }
    toast.success(t('skillhub.marketActions.deleteSuccess'));
    onDeleted?.(skill);
    reload();
    void refreshSkillhub();
  }, [confirm, onDeleted, reload, t]);

  const handleManageAction = useCallback((skill: MarketSkill, action: MarketCardManageAction) => {
    if (action !== 'clone' && isReadOnly(skill)) {
      toast.error(t('skillhub.market.noManagePermission'));
      return;
    }
    switch (action) {
      case 'edit':
        setEditTarget(skill);
        break;
      case 'manageVisibility':
        setVisibilityTarget(skill);
        break;
      case 'clone':
        onClone(skill);
        break;
      case 'delete':
        void handleDelete(skill);
        break;
    }
  }, [handleDelete, isReadOnly, onClone, t]);

  return {
    editTarget,
    visibilityTarget,
    handleManageAction,
    closeEdit: () => setEditTarget(null),
    closeVisibility: () => setVisibilityTarget(null),
    editSaved: () => {
      setEditTarget(null);
      reload();
    },
    visibilitySaved: () => {
      setVisibilityTarget(null);
      reload();
      void refreshSkillhub();
    },
    isReadOnly,
  };
}

function visibilityTier(skill: MarketSkill): VisibilityTier {
  const visibility = skill.publishedVisibility
    ?? (skill.visibility === 'PUBLIC' ? 'public' : 'shared');
  return visibility === 'shared' ? 'team' : visibility;
}

export function MarketManagementDialogs({
  controller,
}: {
  controller: MarketManagementController;
}) {
  return (
    <>
      {controller.editTarget ? (
        <MarketInfoEditDialog
          open
          onOpenChange={(open) => { if (!open) controller.closeEdit(); }}
          skillName={controller.editTarget.name}
          currentCategories={controller.editTarget.categories}
          readOnly={controller.isReadOnly(controller.editTarget)}
          onSaved={controller.editSaved}
        />
      ) : null}
      {controller.visibilityTarget ? (
        <VisibilityEditorDialog
          open
          onOpenChange={(open) => { if (!open) controller.closeVisibility(); }}
          skillName={controller.visibilityTarget.name}
          currentTier={visibilityTier(controller.visibilityTarget)}
          currentOwnerType={controller.visibilityTarget.ownerType}
          publicReview={controller.visibilityTarget.visibilityReview}
          readOnly={controller.isReadOnly(controller.visibilityTarget)}
          onSaved={controller.visibilitySaved}
        />
      ) : null}
    </>
  );
}
