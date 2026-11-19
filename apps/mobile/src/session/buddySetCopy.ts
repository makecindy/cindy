import type { TFunction } from 'i18next';

/** A buddy private-chat row that can be put into a buddy set. */
export interface BuddySetCandidate {
  id: string;
  name: string;
}

/**
 * 「伙伴集」文案:稳定 i18n key + 英文内联默认(缺 key 时仍可渲染)。
 * 12 语言与 `buddy-set` proposed 词条由 LQA 助手补,见 PR 说明。
 * 单独成文件以保持零重依赖:首页组件与表单都能引用而不拖入原生表单链。
 */
export function mobileBuddySetCopy(t: TFunction) {
  return {
    new: t('devices.companions.buddySets.new', { defaultValue: 'New buddy set' }),
    createTitle: t('devices.companions.buddySets.createTitle', { defaultValue: 'New buddy set' }),
    renameTitle: t('devices.companions.buddySets.renameTitle', { defaultValue: 'Rename buddy set' }),
    nameLabel: t('devices.companions.buddySets.nameLabel', { defaultValue: 'Name' }),
    namePlaceholder: t('devices.companions.buddySets.namePlaceholder', { defaultValue: 'Name this buddy set' }),
    membersLabel: t('devices.companions.buddySets.membersLabel', { defaultValue: 'Buddies' }),
    save: t('devices.companions.buddySets.save', { defaultValue: 'Save buddy set' }),
    close: t('devices.companions.buddySets.close', { defaultValue: 'Cancel' }),
    delete: t('devices.companions.buddySets.deleteBuddySet', { defaultValue: 'Delete buddy set' }),
    collapse: t('devices.companions.buddySets.collapse', { defaultValue: 'Collapse buddy set' }),
    expand: t('devices.companions.buddySets.expand', { defaultValue: 'Expand buddy set' }),
  };
}
