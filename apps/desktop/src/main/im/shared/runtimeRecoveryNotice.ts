import { createRuntimeRecoveryNotices } from '@cindy/im-runtime/runtimeRecoveryNotice';
import { t } from '../../i18n';
export const { advanceRuntimeRecoveryNotice, bindRuntimeRecoveryNotice } = createRuntimeRecoveryNotices(() => t('settings.piPackages.failure.runtimeRetirementFailed'));
