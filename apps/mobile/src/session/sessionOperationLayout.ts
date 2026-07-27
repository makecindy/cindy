import type { SessionComposerDisabledReasonSource } from '@cindy/maker-shared/session-operation';

export {
  buildSessionOperationLayout,
  type SessionComposerDisabledReasonSource,
  type SessionComposerSlot,
  type SessionMessageHistoryMode,
  type SessionOperationLayout,
  type SessionOperationLayoutInput,
} from '@cindy/maker-shared/session-operation';

/**
 * 共享模型自造的禁发理由 → 手机端文案 key。
 *
 * 那两条理由在共享层是中文直出,而手机端会把它读给 composer 与队列行的
 * accessibility hint —— 不翻的话读屏在 en / ja / ko 下念混语(#530 review)。
 * `caller-provided` 的理由已由调用方本地化,返回 null 表示原样使用。
 */
export function composerDisabledReasonI18nKey(
  source: SessionComposerDisabledReasonSource | null | undefined,
): string | null {
  if (source === 'session-syncing') return 'session.screen.composerSessionNotSynced';
  if (source === 'pending-interaction') return 'interaction.panel.composerBlockedByPending';
  return null;
}
