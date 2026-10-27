import { ErrorNotice, ErrorNoticeAction } from '@/components/ErrorNotice';
/**
 * 会话尾部收尾提示条(error-tail / interrupted)—— 对齐桌面 ErrorTailErrorBanner /
 * InterruptedTurnBanner 的核心语义,状态推导在 sessionTailBanner.ts(纯函数),
 * 本组件只渲染 + 回调。与实时、历史错误共用 ErrorNotice 中性卡片，
 * 渲染位置在消息列表 footer(队列区上方)。
 *
 * 操作语义(与桌面一致):
 *  - 主按钮(重试 / 继续任务)→ 父屏发隐藏续跑指令(带 [UI_ACTION_TRIGGER] 前缀,
 *    消息流不渲染,用户只看到任务继续跑);
 *  - 右上角关闭 → error-tail 持久化 dismiss / interrupted 写 ack,不再提示。
 */
import { AgentErrorDetails } from './AgentErrorDetails';
import { ReadableHistoryRecovery } from './ReadableHistoryRecovery';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionTailBannerState } from '@/session/sessionTailBannerModel';
import type { ErrorDiagnosisSource } from '@/session/errorDiagnosisPrompt';

import { spacing } from '@/theme/tokens';

export interface SessionTailBannerProps {
  state: NonNullable<SessionTailBannerState>;
  busy?: boolean;
  onRecoverHistory?: () => void;
  /** 展开详情后的「诊断」：上层带着错误与出错任务去新任务里排查。 */
  onDiagnose?: (error: ErrorDiagnosisSource) => void;
  onContinue(): void;
  onDismiss(): void;
}

export function SessionTailBanner({
  state,
  busy,
  onContinue,
  onDismiss,
  onRecoverHistory,
  onDiagnose,
}: SessionTailBannerProps) {
  const { t } = useTranslation();
  const isInterrupted =
    state.kind === 'interrupted' || state.continueKind === 'interrupted';
  const text =
    state.kind === 'error-tail' && state.continueKind === 'error'
      ? state.summaryKey
        ? t(state.summaryKey)
        : state.text
      : t('session.tail.interrupted');
  const showContinue = state.kind === 'interrupted' || state.retryable;
  const actions = (
    <>
      {showContinue ? (
        <ErrorNoticeAction
          primary
          disabled={busy}
          busy={busy}
          label={
            isInterrupted
              ? t('session.tail.continueTask')
              : t('session.tail.retry')
          }
          onPress={onContinue}
          testID="session.tailBanner.continue"
        />
      ) : null}
      {onRecoverHistory ? (
        <ReadableHistoryRecovery onRecover={onRecoverHistory} busy={busy} />
      ) : null}
    </>
  );
  return (
    <ErrorNotice
      style={styles.box}
      testID="session.tailBanner"
      message={text}
      messageTestID="session.tailBanner.text"
      description={
        onRecoverHistory
          ? t('session.tail.readableHistoryRecoveryDescription')
          : undefined
      }
      onDismiss={onDismiss}
      dismissLabel={t('session.tail.dismissNotice')}
      dismissTestID="session.tailBanner.dismiss"
      dismissDisabled={busy}
      dismissBusy={busy}
    >
      {state.kind === 'error-tail' && state.rawError && !isInterrupted ? (
        <AgentErrorDetails
          message={state.rawError}
          actions={actions}
          onDiagnose={
            onDiagnose
              ? () => onDiagnose({ message: text, details: state.rawError ?? '', reason: state.reason })
              : undefined
          }
        />
      ) : (
        <View style={styles.actions}>{actions}</View>
      )}
    </ErrorNotice>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: spacing.sm, width: '100%' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
});
