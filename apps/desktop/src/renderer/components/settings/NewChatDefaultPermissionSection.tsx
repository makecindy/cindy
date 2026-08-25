/**
 * Settings -> General 的「新建对话默认权限」设置。
 *
 * 控制所有新 Maker 对话的默认权限模式:auto(自动审批)或 bypassPermissions(完全访问)。
 * override 存在时(用户显式选择),未在新建页显式选过权限的 vendor 一律用这个默认;
 * 已在某次新建里显式选过权限的 vendor 保留用户自己的那次选择(不被顶掉)。
 *
 * 纯 renderer 本地偏好,数据正本在 newMakerDraft store(localStorage,按 owner 分区),
 * 不走 main 进程 IPC —— 与 IM 默认权限(server prefs)是两套独立机制。
 * 有效值 = newChatDefaultPermissionMode(override) ?? seed auto;「恢复默认」= 清 override。
 */

import { useTranslation } from 'react-i18next';

import { PermissionSelector } from '@/components/new-chat/PermissionSelector';
import type { PermissionMode } from '@/lib/userPreferences.types';
import {
  setNewChatDefaultPermissionMode,
  useNewMakerDraft,
} from '@/state/newMakerDraft';
import { DefaultOverrideControls } from './DefaultOverrideControls';

/** 设置项允许的档位:仅暴露产品批准的 auto(自动审批)/ bypassPermissions(完全访问)。 */
const ALLOWED_MODES = ['auto', 'bypassPermissions'] as const;

export function NewChatDefaultPermissionSection() {
  const { t } = useTranslation();
  const draft = useNewMakerDraft();
  const override = draft.newChatDefaultPermissionMode;
  const isCustomized = override != null;
  // 有 override 用 override;否则展示系统默认(auto 自动审批)。
  const effective = override ?? 'auto';

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="select-none text-14 font-medium leading-[1.2] text-[var(--settings-section-title)]">
            {t('settings.newChatDefaults.title')}
          </h3>
          <p className="mt-1 select-none text-12 leading-[1.45] text-[var(--settings-section-desc)]">
            {t('settings.newChatDefaults.description')}
          </p>
        </div>
        <DefaultOverrideControls
          isCustomized={isCustomized}
          onReset={() => setNewChatDefaultPermissionMode(null)}
        />
      </div>

      <PermissionSelector
        permissionMode={effective}
        vendorKey="cc"
        triggerVariant="field"
        allowedModes={ALLOWED_MODES}
        ariaContext={t('settings.newChatDefaults.title')}
        onPermissionModeChange={(mode: PermissionMode) => {
          setNewChatDefaultPermissionMode(mode);
        }}
      />

      <p className="select-none text-12 leading-[1.45] text-[var(--settings-section-sublabel)]">
        {t('settings.newChatDefaults.hint')}
      </p>
    </div>
  );
}
