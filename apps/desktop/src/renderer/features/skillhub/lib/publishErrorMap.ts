/**
 * publishErrorMap.ts — errorCode → UI 文案 + 按钮 (R5)
 *
 * Publish errorCode → UI copy/action map. Keep this exhaustive with
 * SkillhubPublishErrorCode so new main-process failures cannot silently fall
 * back to generic copy.
 */

import { i18n } from '@/i18n';

export type PublishActionType =
  | 'retry'
  | 'retry-upload'      // 重试（不重审核不重打包）
  | 'republish'         // 重新发布（重走 init）
  | 'go-settings'       // 去设置页
  | 'rename'            // 去改名
  | 'close';            // 仅关闭

export interface PublishErrorAction {
  label: string;
  type: PublishActionType;
}

export interface PublishErrorCopy {
  title: string;
  message: string;
  primaryAction: PublishErrorAction;
  secondaryAction?: PublishErrorAction;
}

type PublishActionLabelKey =
  | 'cancel'
  | 'retry'
  | 'openSettings'
  | 'rename'
  | 'fix'
  | 'republish'
  | 'abandonPending';

interface PublishErrorActionSpec {
  labelKey: PublishActionLabelKey;
  type: PublishActionType;
}

interface PublishErrorSpec {
  primaryAction: PublishErrorActionSpec;
  secondaryAction?: PublishErrorActionSpec;
}

const CLOSE_ACTION: PublishErrorActionSpec = { labelKey: 'cancel', type: 'close' };
const RETRY_ACTION: PublishErrorActionSpec = { labelKey: 'retry', type: 'retry' };

const errorMap: Record<SkillhubPublishErrorCode, PublishErrorSpec> = {
  API_KEY_MISSING: {
    primaryAction: { labelKey: 'openSettings', type: 'go-settings' },
    secondaryAction: CLOSE_ACTION,
  },
  CATEGORY_REQUIRED: {
    primaryAction: CLOSE_ACTION,
  },
  NAME_TAKEN: {
    primaryAction: { labelKey: 'rename', type: 'rename' },
  },
  INVALID_DEPT: {
    primaryAction: CLOSE_ACTION,
  },
  INVALID_NAME: {
    primaryAction: { labelKey: 'fix', type: 'rename' },
  },
  OSS_PUT_FAILED: {
    primaryAction: { labelKey: 'retry', type: 'retry-upload' },
    secondaryAction: CLOSE_ACTION,
  },
  OSS_PUT_EXPIRED: {
    primaryAction: { labelKey: 'republish', type: 'republish' },
    secondaryAction: CLOSE_ACTION,
  },
  VERSION_RACE: {
    primaryAction: RETRY_ACTION,
    secondaryAction: CLOSE_ACTION,
  },
  CHECKSUM_MISMATCH: {
    primaryAction: RETRY_ACTION,
    secondaryAction: CLOSE_ACTION,
  },
  NOT_AUTHOR: {
    primaryAction: CLOSE_ACTION,
  },
  PACK_FAILED: {
    primaryAction: RETRY_ACTION,
    secondaryAction: CLOSE_ACTION,
  },
  OSS_OBJECT_NOT_FOUND: {
    primaryAction: RETRY_ACTION,
    secondaryAction: CLOSE_ACTION,
  },
  MANIFEST_INVALID: {
    primaryAction: CLOSE_ACTION,
  },
  CANCELLED: {
    primaryAction: CLOSE_ACTION,
  },
  SKILL_HUB_READ_ONLY: {
    primaryAction: CLOSE_ACTION,
  },
  INVALID_VISIBILITY: {
    primaryAction: CLOSE_ACTION,
  },
  INTERNAL: {
    primaryAction: RETRY_ACTION,
    secondaryAction: CLOSE_ACTION,
  },
};

function toAction(spec: PublishErrorActionSpec): PublishErrorAction {
  return {
    label: i18n.t(`skillhub.publishError.actions.${spec.labelKey}`),
    type: spec.type,
  };
}

export function getPublishErrorCopy(errorCode: SkillhubPublishErrorCode): PublishErrorCopy {
  const spec = errorMap[errorCode];
  if (!spec) {
    return {
      title: i18n.t('skillhub.publishError.UNKNOWN.title'),
      message: i18n.t('skillhub.publishError.UNKNOWN.message', { code: errorCode }),
      primaryAction: toAction(RETRY_ACTION),
      secondaryAction: toAction(CLOSE_ACTION),
    };
  }
  return {
    title: i18n.t(`skillhub.publishError.${errorCode}.title`),
    message: i18n.t(`skillhub.publishError.${errorCode}.message`),
    primaryAction: toAction(spec.primaryAction),
    secondaryAction: spec.secondaryAction ? toAction(spec.secondaryAction) : undefined,
  };
}
