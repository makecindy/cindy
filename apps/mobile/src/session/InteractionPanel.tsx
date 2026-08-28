import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  CornerDownLeft,
  Maximize2,
  Minimize2,
  Minus,
  Pencil,
  Plus,
} from 'lucide-react-native';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Text, TextInput } from '@/components/AppText';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { useMobileMakerTransport } from '@/device-link/useMobileMakerTransport';
import {
  answerKey,
  buildAskQuestionReviewPresentation,
  buildAskUserQuestionDecision,
  buildMobilePermissionCardState,
  buildPendingInteractionQueuePresentation,
  buildPermissionDecision,
  buildPermissionReviewPresentation,
  buildPlanReviewEvidencePresentation,
  buildInteractionResolveActionPresentation,
  buildPluginSetupCancelDecision,
  buildPlanReviewDecision,
  buildRemotePluginSetupPresentation,
  buildCollapsedPendingInteractionPresentation,
  canCollapsePendingInteraction,
  canStartInteractionResolve,
  encodeMultiSelectAnswer,
  resolveInteractionResilient,
  isPendingInteractionCollapsed,
  isPlanReviewResolveBusy,
  interactionKind,
  normalizeAskQuestions,
  planReviewFilePath,
  planReviewPlan,
  readRequestId,
  remoteInteractionHandling,
  selectionFromAnswer,
  sessionScopedPermissionSuggestions,
  sortPendingInteractions,
  type AskQuestion,
  type PermissionReviewPresentation,
  type PlanReviewEvidencePresentation,
  type RemotePluginSetupPhase,
  type RemotePluginSetupStep,
} from '@/session/interactionModel';
import {
  clearAskUserDraft,
  clearPlanReviewDraft,
  readAskUserDraft,
  readPlanReviewDraft,
  saveAskUserDraft,
  savePlanReviewDraft,
} from '@/session/interactionDraftStore';
import {
  buildInteractionTouchLayout,
  type InteractionTouchLayout,
} from '@/session/interactionTouchLayout';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { PendingInteraction } from '@/session/types';
import { fontWeight, iconStroke, lineHeight, monoFont, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { iconSize, radius, spacing, typeScale } from '@/theme/tokens';
import { contentToPreview } from '@/utils/contentPreview';

const PLAN_PREVIEW_LINE_HEIGHT = 20;

/** 未受控(没接会话页收起态)时的空集合,常量化避免每帧换引用。 */
const EMPTY_COLLAPSED_REQUEST_IDS: readonly string[] = [];

/**
 * 有本地化文案的 interaction kind 白名单(与 interaction.json 的 `kinds` 键一一对应)。
 *
 * kind 来自远端请求、可以是任意字符串,不能直接拼进 i18next 的 key 路径:带 `.` 的值
 * 会改变路径解析,`__proto__` 这类还会牵扯原型链(#530 review)。白名单外一律归到
 * `fallback`。
 */
const LOCALIZED_INTERACTION_KINDS = new Set([
  'permission',
  'ask_user_question',
  'plan_review',
  'issue_confirm',
  'plugin_setup',
]);

function localizedInteractionKindKey(kind: string): string {
  return LOCALIZED_INTERACTION_KINDS.has(kind) ? kind : 'fallback';
}

export type MobilePlanViewerState = 'half' | 'expanded' | 'minimized' | 'edit';
type RestorablePlanViewerState = Exclude<MobilePlanViewerState, 'minimized'>;

export function InteractionPanel({
  safeAreaBottomInset = 0,
  collapse,
  deviceId,
  fillAvailableHeight = false,
  sessionId,
  interactions,
  activeRequestId: controlledActiveRequestId,
  onActiveRequestIdChange,
  planViewerState,
  onPlanViewerStateChange,
  onError,
  readOnlyReason,
}: {
  safeAreaBottomInset?: number;
  /**
   * 收起能力:整组给或整组不给。
   *
   * 合成一个对象而不是两个可选 prop —— 只传状态不传回调会得到一个「显示为收起但点不开」
   * 的死界面,类型上就该表达不出来(#1493 review)。不传 = 该放置点不提供收起(如贴在
   * 输入框上方的 plugin_setup 卡)。
   */
  collapse?: {
    /** 已收起的 requestId(会话页持有,见 interactionModel 的收起态注释)。 */
    requestIds: readonly string[];
    onToggle(requestId: string): void;
  };
  deviceId: string;
  fillAvailableHeight?: boolean;
  sessionId: string;
  interactions: PendingInteraction[];
  activeRequestId?: string | null;
  onActiveRequestIdChange?(requestId: string | null): void;
  planViewerState?: MobilePlanViewerState;
  onPlanViewerStateChange?(state: MobilePlanViewerState): void;
  readOnlyReason?: string | null;
  onError(message: string | null): void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const sortedInteractions = useMemo(
    () => sortPendingInteractions(interactions),
    [interactions],
  );
  const [localActiveRequestId, setLocalActiveRequestId] = useState<string | null>(null);
  const activeRequestId = controlledActiveRequestId !== undefined
    ? controlledActiveRequestId
    : localActiveRequestId;
  const setActiveRequestId = (requestId: string | null) => {
    if (controlledActiveRequestId !== undefined) onActiveRequestIdChange?.(requestId);
    else setLocalActiveRequestId(requestId);
  };
  const fallbackInteraction = sortedInteractions[0] ?? null;
  const activeInteraction = useMemo(() => {
    if (!activeRequestId) return fallbackInteraction;
    return sortedInteractions.find((item) => readRequestId(item) === activeRequestId) ?? fallbackInteraction;
  }, [activeRequestId, fallbackInteraction, sortedInteractions]);
  const { width: screenWidth } = useWindowDimensions();
  useEffect(() => {
    if (!activeRequestId) return;
    if (!sortedInteractions.some((item) => readRequestId(item) === activeRequestId)) {
      setActiveRequestId(null);
    }
  }, [activeRequestId, sortedInteractions]);
  if (!activeInteraction) return null;
  const kind = interactionKind(activeInteraction);
  const queuePresentation = buildPendingInteractionQueuePresentation(sortedInteractions, {
    maxVisible: sortedInteractions.length || 1,
    readOnly: !!readOnlyReason,
  });
  const activeRequestIdForPresentation = readRequestId(activeInteraction);
  const selectedQueueItem = queuePresentation.items.find((item) => item.requestId === activeRequestIdForPresentation)
    ?? queuePresentation.active;
  // 共享层的 title / label 是中文直出(desktop 时代留下的),控制端要按当前 locale
  // 翻译后再渲染,否则这些队列文案在 en / ja / ko 下仍是中文(#530 review)。
  const localizedKindText = (itemKind: string, field: 'title' | 'label') => t(
    `interaction.kinds.${localizedInteractionKindKey(itemKind)}.${field}`,
  );
  // positionLabel 同样是中文直出,且会被插进队列切换的 accessibility 文案 —— 不翻的话
  // VoiceOver / TalkBack 在 en / ja / ko 下会念出混语(#530 review)。
  const localizedPositionLabel = (index: number) => {
    if (index === 0) return t('interaction.panel.queuePositionCurrent');
    if (index === 1) return t('interaction.panel.queuePositionNext');
    return t('interaction.panel.queuePositionNth', { index: index + 1 });
  };
  const localizeQueueItem = <T extends { kind: string; positionLabel: string }>(item: T, index: number): T => ({
    ...item,
    label: localizedKindText(item.kind, 'label'),
    positionLabel: localizedPositionLabel(index),
    title: localizedKindText(item.kind, 'title'),
  });
  const selectedQueueIndex = queuePresentation.items.findIndex((item) => item.requestId === activeRequestIdForPresentation);
  const activeQueuePresentation = {
    ...queuePresentation,
    active: selectedQueueItem
      ? localizeQueueItem(selectedQueueItem, selectedQueueIndex >= 0 ? selectedQueueIndex : 0)
      : selectedQueueItem,
    items: queuePresentation.items.map((item, index) => ({
      ...localizeQueueItem(item, index),
      active: item.requestId === activeRequestIdForPresentation,
    })),
    title: selectedQueueItem
      ? localizedKindText(selectedQueueItem.kind, 'title')
      : queuePresentation.title,
  };
  const touchLayout = buildInteractionTouchLayout({
    actionCount: resolveActionCount(kind),
    screenWidth,
  });
  const rootLayoutStyle = {
    gap: touchLayout.rootGap,
    paddingBottom: Math.max(spacing.sm, safeAreaBottomInset),
    paddingHorizontal: touchLayout.rootPaddingHorizontal,
  };
  const cardLayoutStyle = {
    gap: touchLayout.cardGap,
    padding: touchLayout.cardPadding,
  };
  if (readOnlyReason) {
    return (
      <View style={[styles.root, fillAvailableHeight && styles.rootFill, rootLayoutStyle]} testID="interaction.panel">
        <PendingTaskHeader
          onSelectRequest={setActiveRequestId}
          presentation={activeQueuePresentation}
          touchLayout={touchLayout}
        />
        <View style={[styles.card, cardLayoutStyle]} testID="interaction.readOnlyCard">
          <Text style={styles.kind}>{t('interaction.panel.readOnlyKind')}</Text>
          <Text style={styles.cardTitle}>{t('interaction.panel.readOnlyTitle')}</Text>
          <Text style={styles.body}>{readOnlyReason}</Text>
        </View>
      </View>
    );
  }
  // 收起 = 「这条我先不答,让我看电脑端的输出」。整块 surface 只留一条 bar:再留着
  // 队列头就还是两层结构,消息流照样看不到几行。
  // 收起入口只给本端能终结的卡:队列里混着 plugin_setup / issue_confirm 时用户能切过去,
  // 那类卡答不了,挂「点开回答」是错的语义(#1493 review)。
  const canToggleCollapsed = !!collapse
    && !!activeRequestIdForPresentation
    && canCollapsePendingInteraction(activeInteraction);
  const collapsed = canToggleCollapsed && isPendingInteractionCollapsed(
    collapse?.requestIds ?? EMPTY_COLLAPSED_REQUEST_IDS,
    activeRequestIdForPresentation,
  );
  const toggleCollapsed = () => {
    if (!activeRequestIdForPresentation) return;
    collapse?.onToggle(activeRequestIdForPresentation);
  };
  // 摘要与读屏标签都跟随用户翻到的那一问(进度从 askUserDraft 现取),由纯函数产出
  // 以便直接断言读屏行为。
  const { accessibilityLabel: collapsedBarLabel, summaryText } = buildCollapsedPendingInteractionPresentation({
    item: activeInteraction,
    queueTitle: activeQueuePresentation.title,
    requestId: activeRequestIdForPresentation,
  });
  if (collapsed) {
    return (
      <View style={[styles.root, rootLayoutStyle]} testID="interaction.panel">
        <InteractionTouchButton
          accessibilityLabel={collapsedBarLabel}
          onPress={toggleCollapsed}
          style={[styles.card, styles.collapsedInteractionBar, { paddingHorizontal: touchLayout.cardPadding }]}
          testID="interaction.panel.collapsedBar"
        >
          <View style={styles.collapsedInteractionText}>
            <Text style={styles.collapsedInteractionLabel}>{activeQueuePresentation.title}</Text>
            {summaryText ? (
              <Text numberOfLines={1} style={styles.collapsedInteractionTitle}>{summaryText}</Text>
            ) : null}
          </View>
          <View style={styles.compactHeaderActions}>
            {activeQueuePresentation.totalCount > 1 ? (
              <Text style={styles.collapsedInteractionMeta} testID="interaction.panel.collapsedCount">
                {Math.max(0, selectedQueueIndex) + 1}/{activeQueuePresentation.totalCount}
              </Text>
            ) : null}
            <Text style={styles.collapsedInteractionMeta}>{t('interaction.panel.collapsedHint')}</Text>
            <View style={styles.iconControl}>
              <Plus color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
            </View>
          </View>
        </InteractionTouchButton>
      </View>
    );
  }
  return (
    <View style={[styles.root, fillAvailableHeight && styles.rootFill, rootLayoutStyle]} testID="interaction.panel">
      <PendingTaskHeader
        onCollapse={canToggleCollapsed ? toggleCollapsed : undefined}
        onSelectRequest={setActiveRequestId}
        presentation={activeQueuePresentation}
        touchLayout={touchLayout}
      />
      <InteractionItem
        key={readRequestId(activeInteraction) ?? `${interactionKind(activeInteraction)}-${JSON.stringify(activeInteraction.request)}`}
        deviceId={deviceId}
        sessionId={sessionId}
        item={activeInteraction}
        planViewerState={planViewerState}
        onPlanViewerStateChange={onPlanViewerStateChange}
        onError={onError}
        touchLayout={touchLayout}
      />
    </View>
  );
}

function resolveActionCount(kind: string): number {
  if (kind === 'permission') return 3;
  if (kind === 'plan_review') return 3;
  if (kind === 'ask_user_question') return 3;
  return 1;
}

type InteractionStyles = ReturnType<typeof makeStyles>;

function cardStyle(styles: InteractionStyles, touchLayout: InteractionTouchLayout): StyleProp<ViewStyle> {
  return [
    styles.card,
    {
      gap: touchLayout.cardGap,
      padding: touchLayout.cardPadding,
    },
  ];
}

function actionsStyle(styles: InteractionStyles, touchLayout: InteractionTouchLayout): StyleProp<ViewStyle> {
  return [
    styles.actions,
    {
      gap: touchLayout.actionGap,
    },
  ];
}

function resolveButtonLayoutStyle(
  touchLayout: InteractionTouchLayout,
  variant: 'primary' | 'secondary' | 'inline',
): StyleProp<ViewStyle> {
  return {
    minHeight: touchLayout.actionButtonMinHeight,
    minWidth: variant === 'inline' ? touchLayout.inlineButtonMinWidth : touchLayout.actionButtonMinWidth,
  };
}

function PendingTaskHeader({
  onCollapse,
  onSelectRequest,
  presentation,
  touchLayout,
}: {
  onCollapse?(): void;
  onSelectRequest(requestId: string | null): void;
  presentation: ReturnType<typeof buildPendingInteractionQueuePresentation>;
  touchLayout: InteractionTouchLayout;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const activeIndex = Math.max(0, presentation.items.findIndex((item) => item.active));
  const nextItem = presentation.items.length > 1
    ? presentation.items[(activeIndex + 1) % presentation.items.length]
    : null;
  return (
    <View style={styles.taskHeaderWrap} testID="interaction.panelHeader">
      <View
        style={[
          styles.taskHeader,
          {
            gap: touchLayout.taskHeaderGap,
            minHeight: touchLayout.taskHeaderMinHeight,
          },
        ]}
      >
        <View style={styles.taskHeaderText}>
          <Text style={styles.taskEyebrow}>{t('interaction.panel.pendingRequests')}</Text>
          <Text numberOfLines={1} style={styles.taskTitle}>{presentation.title}</Text>
        </View>
        {presentation.totalCount > 1 ? (
          <InteractionTouchButton
            accessibilityLabel={nextItem ? t('interaction.panel.queueSwitchTo', { position: nextItem.positionLabel, label: nextItem.label }) : t('interaction.panel.queueSwitchGeneric')}
            disabled={!nextItem?.requestId}
            onPress={() => onSelectRequest(nextItem?.requestId ?? null)}
            style={[styles.taskCountPill, { minHeight: touchLayout.taskCountPillMinHeight }]}
            testID="interaction.queuePreview.next"
          >
            <Text style={styles.taskCountText}>
              ‹ {activeIndex + 1}/{presentation.totalCount} ›
            </Text>
          </InteractionTouchButton>
        ) : null}
        {/*
          收起入口带可见文字:此前它是卡片里一个没有标签的「—」图标,用户看不出那是
          「先不答、让我看输出」的出口(线上反馈)。放在队列头则三类卡通用,不再各自
          实现一套收起。
        */}
        {onCollapse ? (
          <InteractionTouchButton
            accessibilityLabel={t('interaction.panel.collapsePendingCard')}
            onPress={onCollapse}
            style={[styles.taskCollapseButton, { minHeight: touchLayout.taskCountPillMinHeight }]}
            testID="interaction.panel.collapseButton"
          >
            <Minus color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
            <Text style={styles.taskCollapseText}>{t('interaction.panel.collapse')}</Text>
          </InteractionTouchButton>
        ) : null}
      </View>
    </View>
  );
}

function InteractionItem({
  deviceId,
  sessionId,
  item,
  planViewerState,
  onPlanViewerStateChange,
  onError,
  touchLayout,
}: {
  deviceId: string;
  sessionId: string;
  item: PendingInteraction;
  planViewerState?: MobilePlanViewerState;
  onPlanViewerStateChange?(state: MobilePlanViewerState): void;
  onError(message: string | null): void;
  touchLayout: InteractionTouchLayout;
}) {
  const { t } = useTranslation();
  const maker = useMobileMakerTransport(deviceId);
  const [busy, setBusy] = useState(false);
  const submittingRequestIdRef = useRef<string | null>(null);
  const requestId = readRequestId(item);
  const kind = interactionKind(item);

  const submitDecision = async (
    decision: Record<string, unknown>,
    options: { optimisticDismiss?: boolean; resolvedRevision?: number } = {},
  ) => {
    if (!canStartInteractionResolve({ requestId, submittingRequestId: submittingRequestIdRef.current })) return;
    const currentRequestId = requestId;
    if (!currentRequestId) return;
    // 乐观 dismiss 只适合「决定即终局」的卡。plugin_setup 的取消由被控端按
    // expectedRevision 裁决(旧快照会被改判成重新体检而非取消),抢先撤卡会在
    // 取消其实没生效时留下一张被抑制、再也灌不回来的幽灵卡 —— 那类卡走非乐观
    // 路径,等被控端 dismiss 推送为准。
    const optimisticDismiss = options.optimisticDismiss !== false;
    submittingRequestIdRef.current = currentRequestId;
    setBusy(true);
    onError(null);
    // 乐观 dismiss:点批准 / 拒绝当帧撤卡,不让用户盯着 busy 卡等网络往返
    //(agent 每次要权限都要点,弱网下是最高频的「卡住感」来源)。store 侧同时
    // 登记在途抑制,防权威快照 / push 重放在被控端确认前把同卡灌回闪回;保留
    // item 快照,真失败时原卡复原供重试。
    const itemSnapshot = item;
    if (optimisticDismiss) remoteSessionStore.beginOptimisticInteractionDismiss(sessionId, currentRequestId);
    try {
      await resolveInteractionResilient(maker, sessionId, currentRequestId, decision);
      if (kind === 'plan_review') clearPlanReviewDraft(currentRequestId);
      if (optimisticDismiss) {
        remoteSessionStore.settleOptimisticInteractionDismiss(sessionId, currentRequestId, { kind: 'confirmed' });
      } else if (options.resolvedRevision !== undefined) {
        // 非乐观路径也必须挡「早发晚到」:提交前发出的慢快照仍带着这张卡,dismiss
        // push 先到时它会把已取消的卡写回来(#530 review P1)。这里只把 revision
        // 下限抬过本次决定作用的那份 —— 决定没生效时被控端会推更高 revision,
        // 卡照样回来。
        remoteSessionStore.markInteractionRevisionResolved(
          sessionId,
          currentRequestId,
          options.resolvedRevision,
        );
      }
    } catch (err) {
      // resolveInteractionResilient 已带弱网重试 + pending 列表权威分辨,走到
      // 这里就是决定确未生效:复原卡片 + 报错。
      if (optimisticDismiss) {
        remoteSessionStore.settleOptimisticInteractionDismiss(sessionId, currentRequestId, {
          kind: 'restore',
          item: itemSnapshot,
        });
      }
      onError(formatRemoteError(err));
    } finally {
      if (submittingRequestIdRef.current === currentRequestId) {
        submittingRequestIdRef.current = null;
      }
      setBusy(false);
    }
  };

  if (!requestId) {
    return (
      <UnsupportedCard
        message={t('interaction.panel.missingRequestId')}
        request={item.request}
        touchLayout={touchLayout}
      />
    );
  }

  if (kind === 'permission') {
    return (
      <PermissionCard
        busy={busy}
        item={item}
        onDecision={(decision) => void submitDecision(decision)}
        touchLayout={touchLayout}
      />
    );
  }
  if (kind === 'ask_user_question') {
    return (
      <AskUserQuestionCard
        busy={busy}
        item={item}
        onDecision={(decision) => void submitDecision(decision)}
        touchLayout={touchLayout}
      />
    );
  }
  if (kind === 'plan_review') {
    return (
      <PlanReviewCard
        busy={busy}
        item={item}
        onDecision={(decision) => void submitDecision(decision)}
        viewerState={planViewerState}
        onViewerStateChange={onPlanViewerStateChange}
        touchLayout={touchLayout}
      />
    );
  }
  if (kind === 'issue_confirm') {
    return (
      <UnsupportedCard
        message={t('interaction.panel.issueConfirmUnsupported')}
        request={item.request}
        touchLayout={touchLayout}
      />
    );
  }
  // plugin_setup:配置动作(OAuth / 写本地设置)只能在被控端完成,被控端的 IPC
  // 边界也只放 cancel 过来。手机侧因此给只读摘要 + 取消出口,让用户至少能把
  // 会话从等待里放出来,而不是对着一张没有任何按钮的卡干等。
  if (kind === 'plugin_setup') {
    // 取消入口以共享分类器为准:terminal 快照(被控端 settle 后短暂保留的收尾帧)
    // 归 desktop-only,此时被控端已 complete、不再受理 resolve,给按钮只会让用户点出
    // 一个「看起来成功」的 no-op(#530 review)。
    const cancelDecision = remoteInteractionHandling(item) === 'cancel-only'
      ? buildPluginSetupCancelDecision(item.request)
      : null;
    return (
      <PluginSetupCard
        busy={busy}
        cancel={cancelDecision
          ? {
            accessibilityLabel: t('interaction.panel.cancelRequestAccessibility'),
            label: t('interaction.panel.cancelRequest'),
            onPress: () => void submitDecision(cancelDecision, {
              optimisticDismiss: false,
              resolvedRevision: cancelDecision.expectedRevision,
            }),
          }
          : null}
        item={item}
        requestId={requestId}
        touchLayout={touchLayout}
      />
    );
  }
  return (
    <UnsupportedCard
      message={t('interaction.panel.unsupportedType')}
      request={item.request}
      touchLayout={touchLayout}
    />
  );
}

function PermissionCard({
  busy,
  item,
  onDecision,
  touchLayout,
}: {
  busy: boolean;
  item: PendingInteraction;
  onDecision(decision: Record<string, unknown>): void;
  touchLayout: InteractionTouchLayout;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const presentation = useMemo(() => buildPermissionReviewPresentation(item.request), [item.request]);
  const suggestions = sessionScopedPermissionSuggestions(item.request.suggestions);
  const requestId = readRequestId(item);
  const [armedDecision, setArmedDecision] = useState<'allow-once' | 'always-allow' | null>(null);
  const permissionState = buildMobilePermissionCardState({ armedDecision, presentation });
  const requestDecision = (
    action: 'allow-once' | 'always-allow',
    decision: Record<string, unknown>,
  ) => {
    if (permissionState.isHighRisk && armedDecision !== action) {
      setArmedDecision(action);
      return;
    }
    onDecision(decision);
  };

  return (
    <View style={cardStyle(styles, touchLayout)} testID="interaction.permission.card">
      <View style={styles.compactCardHeader}>
        <Text style={styles.kind}>{t('interaction.permission.kind')}</Text>
        <Text numberOfLines={1} style={styles.compactCardTitle}>{permissionState.title}</Text>
      </View>
      <PermissionEvidence
        armed={!!armedDecision}
        presentation={presentation}
        riskWarningText={permissionState.riskWarningText}
        touchLayout={touchLayout}
      />
      <View style={actionsStyle(styles, touchLayout)}>
        <ResolveButton
          accessibilityLabel={t('interaction.permission.denyAccessibility')}
          busy={busy}
          label={t('interaction.permission.deny')}
          onPress={() => onDecision(buildPermissionDecision('deny', { reason: 'User denied' }))}
          requestId={requestId}
          touchStyle={resolveButtonLayoutStyle(touchLayout, 'secondary')}
          testID="interaction.permission.denyButton"
          variant="secondary"
        />
        {permissionState.canShowAlwaysAllow ? (
          <ResolveButton
            accessibilityLabel={t('interaction.permission.alwaysAllowAccessibility')}
            armed={armedDecision === 'always-allow'}
            busy={busy}
            confirmLabel={t('interaction.permission.alwaysAllowConfirm')}
            label={t('interaction.permission.alwaysAllow')}
            onPress={() => requestDecision(
              'always-allow',
              buildPermissionDecision('allow', { permissionUpdates: suggestions }),
            )}
            requestId={requestId}
            touchStyle={resolveButtonLayoutStyle(touchLayout, 'secondary')}
            testID="interaction.permission.alwaysAllowButton"
            variant="secondary"
          />
        ) : null}
        <ResolveButton
          accessibilityLabel={t('interaction.permission.allowOnceAccessibility')}
          armed={armedDecision === 'allow-once'}
          busy={busy}
          confirmLabel={t('interaction.permission.allowOnceConfirm')}
          label={t('interaction.permission.allowOnce')}
          onPress={() => requestDecision('allow-once', buildPermissionDecision('allow'))}
          requestId={requestId}
          touchStyle={resolveButtonLayoutStyle(touchLayout, 'primary')}
          testID="interaction.permission.allowOnceButton"
          variant="primary"
        />
      </View>
    </View>
  );
}

function PermissionEvidence({
  armed,
  presentation,
  riskWarningText,
  touchLayout,
}: {
  armed: boolean;
  presentation: PermissionReviewPresentation;
  riskWarningText: string | null;
  touchLayout: InteractionTouchLayout;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  return (
    <View
      style={[
        styles.permissionEvidence,
        {
          gap: touchLayout.cardGap,
          paddingHorizontal: touchLayout.cardPadding,
        },
      ]}
      testID="interaction.permission.decisionSummary"
    >
      <View style={styles.permissionEvidenceHeader}>
        <View style={styles.permissionEvidenceTitleWrap}>
          <Text style={styles.permissionEvidenceTitle}>{presentation.summary.title}</Text>
          <Text style={styles.permissionEvidenceDetail}>{presentation.summary.detail}</Text>
        </View>
        <Text numberOfLines={1} style={styles.permissionToolPill}>
          {presentation.toolName}
        </Text>
      </View>
      {presentation.autoReviewUnavailable || presentation.description ? (
        <Text style={styles.permissionDescription}>
          {presentation.autoReviewUnavailable
            ? t('interaction.permission.autoReviewUnavailable')
            : presentation.description}
        </Text>
      ) : null}
      {riskWarningText ? (
        <View
          style={[styles.permissionRiskRow, armed && styles.permissionRiskRowArmed]}
          testID="interaction.permission.riskWarning"
        >
          <Text style={styles.permissionRiskLabel}>{t('interaction.permission.highRisk')}</Text>
          <Text style={styles.permissionRiskText}>{riskWarningText}</Text>
        </View>
      ) : null}
      <ScrollView style={styles.permissionCodeBlock} nestedScrollEnabled>
        <Text selectable style={styles.codeText}>{presentation.code}</Text>
      </ScrollView>
    </View>
  );
}

function AskUserQuestionCard({
  busy,
  item,
  onDecision,
  touchLayout,
}: {
  busy: boolean;
  item: PendingInteraction;
  onDecision(decision: Record<string, unknown>): void;
  touchLayout: InteractionTouchLayout;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const requestId = readRequestId(item) ?? '';
  const questions = useMemo(() => normalizeAskQuestions(item.request.questions), [item.request.questions]);
  const draftCompletedRef = useRef(false);
  const skipNextQuestionSyncRef = useRef(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());
  const [customInput, setCustomInput] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const presentation = useMemo(() => buildAskQuestionReviewPresentation({
    currentIndex,
    questions,
  }), [currentIndex, questions]);
  const current = presentation.current;

  useEffect(() => {
    draftCompletedRef.current = false;
    const draft = readAskUserDraft(requestId);
    skipNextQuestionSyncRef.current = !!draft;
    setCurrentIndex(Math.min(draft?.currentIndex ?? 0, Math.max(0, questions.length - 1)));
    setAnswers(draft?.answers ?? {});
    setSelectedLabels(new Set(draft?.selectedLabels ?? []));
    setCustomInput(draft?.customInput ?? '');
    setShowCustomInput(draft?.showCustomInput ?? false);
  }, [questions.length, requestId]);

  useEffect(() => {
    if (!current) return;
    if (skipNextQuestionSyncRef.current) {
      skipNextQuestionSyncRef.current = false;
      return;
    }
    const next = selectionFromAnswer(current, answers[answerKey(current)]);
    setSelectedLabels(next.selectedLabels);
    setCustomInput(next.customInput);
    setShowCustomInput(next.showCustomInput);
  }, [answers, current]);

  useEffect(() => {
    if (!requestId || draftCompletedRef.current) return;
    saveAskUserDraft(requestId, {
      answers,
      currentIndex,
      customInput,
      selectedLabels: [...selectedLabels],
      showCustomInput,
    });
  }, [answers, currentIndex, customInput, requestId, selectedLabels, showCustomInput]);

  if (questions.length === 0) {
    return (
      <View style={cardStyle(styles, touchLayout)} testID="interaction.ask.card">
        <Text style={styles.kind}>{t('interaction.panel.awaitingAnswer')}</Text>
        <Text style={styles.askQuestion} testID="interaction.ask.question">{presentation.title}</Text>
        <Text style={styles.askMetaCaption}>{presentation.summary.detail}</Text>
        <View style={actionsStyle(styles, touchLayout)}>
          <ResolveButton
            accessibilityLabel={t('interaction.panel.continueAccessibility')}
            busy={busy}
            label={t('interaction.panel.continue')}
            onPress={() => {
              draftCompletedRef.current = true;
              clearAskUserDraft(requestId);
              onDecision(buildAskUserQuestionDecision({}));
            }}
            requestId={requestId}
            touchStyle={resolveButtonLayoutStyle(touchLayout, 'primary')}
            testID="interaction.ask.continueButton"
            variant="primary"
          />
        </View>
      </View>
    );
  }
  if (!current) return null;

  const isLast = currentIndex === questions.length - 1;
  const options = current.options ?? [];
  const isMulti = current.multiSelect === true;
  const currentAnswerKey = answerKey(current);
  const existingAnswer = answers[currentAnswerKey];
  const trimmedCustomInput = customInput.trim();
  const customModeActive = showCustomInput || options.length === 0;
  const canSubmitMulti = selectedLabels.size > 0 || trimmedCustomInput.length > 0;
  const singleAnswer = customModeActive ? trimmedCustomInput : existingAnswer;
  const canSubmitSingle = !isMulti && (singleAnswer ?? '').trim().length > 0;
  const optionsCaption = options.length > 0
    ? t('interaction.panel.askOptionCount', { count: options.length })
    : t('interaction.panel.askFreeInput');
  const metaCaption = t('interaction.panel.askMetaCaption', {
    options: optionsCaption,
    mode: isMulti ? t('interaction.panel.askModeMulti') : t('interaction.panel.askModeSingle'),
  });

  const advance = (answer: string) => {
    const nextAnswers = { ...answers, [currentAnswerKey]: answer };
    setAnswers(nextAnswers);
    if (isLast) {
      draftCompletedRef.current = true;
      clearAskUserDraft(requestId);
      onDecision(buildAskUserQuestionDecision(nextAnswers));
    } else {
      setCurrentIndex((idx) => Math.min(idx + 1, questions.length - 1));
    }
  };

  const clearCurrentAnswer = () => {
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[currentAnswerKey];
      return next;
    });
  };

  const submitMulti = () => {
    if (!canSubmitMulti) return;
    advance(encodeMultiSelectAnswer(options, selectedLabels, customInput));
  };

  const submitSingle = () => {
    if (!canSubmitSingle || singleAnswer === undefined) return;
    advance(singleAnswer);
  };

  const toggleLabel = (label: string) => {
    if (!isMulti) {
      setShowCustomInput(false);
      setCustomInput('');
      setSelectedLabels(new Set([label]));
      setAnswers((prev) => ({ ...prev, [currentAnswerKey]: label }));
      return;
    }
    setSelectedLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  return (
    <View style={cardStyle(styles, touchLayout)} testID="interaction.ask.card">
      {/* 收起入口统一在队列头(PendingTaskHeader),卡内不再自持一份 collapsed state:
          两套状态时页面级那份被卡片 key 变化冲掉,收起会自己弹回来。 */}
      <View style={styles.compactCardHeader}>
        <Text style={styles.askHeaderKind}>{t('interaction.panel.awaitingAnswer')}</Text>
        <View style={styles.compactHeaderActions}>
          <Text style={styles.pageText}>{presentation.pageLabel}</Text>
        </View>
      </View>
      <Text style={styles.askQuestion} testID="interaction.ask.question">{presentation.title}</Text>
      <Text style={styles.askMetaCaption}>{metaCaption}</Text>

      {options.length > 0 ? (
        <View style={styles.optionList}>
          {options.map((option, index) => {
            const selected = isMulti
              ? selectedLabels.has(option.label)
              : existingAnswer === option.label;
            return (
              <InteractionTouchButton
                accessibilityLabel={t('interaction.panel.selectAnswer', { label: option.label })}
                accessibilityHint={busy ? t('interaction.panel.submittingHint') : undefined}
                disabled={busy}
                key={option.label}
                onPress={() => toggleLabel(option.label)}
                selected={selected}
                style={[
                  styles.optionRow,
                  {
                    gap: touchLayout.actionGap,
                    minHeight: touchLayout.optionRowMinHeight,
                    paddingHorizontal: touchLayout.cardPadding,
                  },
                  selected && styles.optionRowSelected,
                ]}
                testID={`interaction.ask.option.${index + 1}`}
              >
                {/* 单选也要有指示器:选中反色实底 + 对勾(对齐桌面 ask-checkbox 与登录
                    radio 的反色勾体系)。此前单选行只靠 surfaceChip 底色,dark 下与卡底
                    几乎同色,选中态不可见。 */}
                <View
                  style={[
                    styles.optionIndicator,
                    isMulti ? styles.optionIndicatorSquare : styles.optionIndicatorRound,
                    selected && styles.optionIndicatorSelected,
                  ]}
                  testID={`interaction.ask.${isMulti ? 'checkbox' : 'radio'}${selected ? '.checked' : ''}`}
                >
                  {selected ? (
                    <Check
                      color={colors.ctaText}
                      size={iconSize.sm}
                      strokeWidth={iconStroke.bold}
                    />
                  ) : null}
                </View>
                <View style={styles.optionCopy}>
                  <Text style={styles.optionTitle}>{option.label}</Text>
                  {option.description ? <Text style={styles.optionDescription}>{option.description}</Text> : null}
                </View>
              </InteractionTouchButton>
            );
          })}
          {showCustomInput ? (
            <View style={[
              styles.customInputRow,
              { gap: touchLayout.actionGap },
              touchLayout.stackInlineInputRows && styles.customInputRowStacked,
            ]}>
              <TextInput
                accessibilityLabel={t('interaction.panel.customAnswerInputAccessibility')}
                autoFocus
                onChangeText={setCustomInput}
                placeholder={t('interaction.panel.customAnswerPlaceholder')}
                placeholderTextColor={colors.textTertiary}
                style={styles.inlineInput}
                testID="interaction.ask.customInput"
                value={customInput}
              />
            </View>
          ) : (
            <InteractionTouchButton
              accessibilityLabel={t('interaction.panel.customAnswerPlaceholder')}
              disabled={busy}
              onPress={() => {
                if (!isMulti) {
                  skipNextQuestionSyncRef.current = true;
                  clearCurrentAnswer();
                  setSelectedLabels(new Set());
                }
                setShowCustomInput(true);
              }}
              style={[
                styles.optionRow,
                {
                  gap: touchLayout.actionGap,
                  minHeight: touchLayout.optionRowMinHeight,
                  paddingHorizontal: touchLayout.cardPadding,
                },
              ]}
              testID="interaction.ask.showCustomButton"
            >
              <Text style={styles.optionCustom}>{t('interaction.panel.customAnswerButtonText')}</Text>
            </InteractionTouchButton>
          )}
        </View>
      ) : (
        <View style={[
          styles.customInputRow,
          { gap: touchLayout.actionGap },
          touchLayout.stackInlineInputRows && styles.customInputRowStacked,
        ]}>
          <TextInput
            accessibilityLabel={t('interaction.panel.answerInput')}
            autoFocus
            onChangeText={setCustomInput}
            placeholder={t('interaction.panel.answerInput')}
            placeholderTextColor={colors.textTertiary}
            style={styles.inlineInput}
            testID="interaction.ask.textInput"
            value={customInput}
          />
        </View>
      )}

      <View style={actionsStyle(styles, touchLayout)}>
        {currentIndex > 0 ? (
          <InteractionTouchButton
            accessibilityLabel={t('interaction.panel.previous')}
            disabled={busy}
            onPress={() => setCurrentIndex((idx) => Math.max(0, idx - 1))}
            style={[
              styles.secondaryButton,
              resolveButtonLayoutStyle(touchLayout, 'secondary'),
            ]}
            testID="interaction.ask.previousButton"
          >
            <Text style={styles.secondaryText}>{t('interaction.panel.previous')}</Text>
          </InteractionTouchButton>
        ) : null}
        <ResolveButton
          accessibilityLabel={t('interaction.panel.skipAccessibility')}
          busy={busy}
          label={t('interaction.panel.skip')}
          onPress={() => advance('')}
          requestId={requestId}
          touchStyle={resolveButtonLayoutStyle(touchLayout, 'secondary')}
          testID="interaction.ask.skipButton"
          variant="secondary"
        />
        {isMulti ? (
          <ResolveButton
            accessibilityLabel={isLast ? t('interaction.panel.submitAnswerAccessibility') : t('interaction.panel.next')}
            busy={busy}
            invalidReason={!canSubmitMulti ? t('interaction.panel.answerRequired') : null}
            label={isLast ? t('interaction.panel.submit') : t('interaction.panel.next')}
            onPress={submitMulti}
            requestId={requestId}
            touchStyle={resolveButtonLayoutStyle(touchLayout, 'primary')}
            testID="interaction.ask.submitButton"
            variant="primary"
          />
        ) : (
          <ResolveButton
            accessibilityLabel={isLast ? t('interaction.panel.submitAnswerAccessibility') : t('interaction.panel.next')}
            busy={busy}
            invalidReason={!canSubmitSingle ? t('interaction.panel.answerRequired') : null}
            label={isLast ? t('interaction.panel.submit') : t('interaction.panel.next')}
            onPress={submitSingle}
            requestId={requestId}
            touchStyle={resolveButtonLayoutStyle(touchLayout, 'primary')}
            testID="interaction.ask.submitButton"
            variant="primary"
          />
        )}
      </View>
    </View>
  );
}

function PlanReviewCard({
  busy,
  item,
  onDecision,
  viewerState: controlledViewerState,
  onViewerStateChange,
  touchLayout,
}: {
  busy: boolean;
  item: PendingInteraction;
  onDecision(decision: Record<string, unknown>): void;
  viewerState?: MobilePlanViewerState;
  onViewerStateChange?(state: MobilePlanViewerState): void;
  touchLayout: InteractionTouchLayout;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const requestId = readRequestId(item) ?? '';
  const [planText, setPlanText] = useState(() =>
    readPlanReviewDraft(requestId)?.planText ?? planReviewPlan(item.request)
  );
  const [localViewerState, setLocalViewerState] = useState<MobilePlanViewerState>('half');
  const [lastExpandedState, setLastExpandedState] = useState<RestorablePlanViewerState>('half');
  const [feedback, setFeedback] = useState(() => readPlanReviewDraft(requestId)?.feedback ?? '');
  const [feedbackOpen, setFeedbackOpen] = useState(() => readPlanReviewDraft(requestId)?.feedbackOpen ?? false);
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const previewScrollRef = useRef<ScrollView | null>(null);
  const skipNextPlanDraftSaveRef = useRef(false);
  const filePath = planReviewFilePath(item.request);
  const originalPlan = planReviewPlan(item.request);
  const viewerStateControlled = controlledViewerState !== undefined;
  const viewerState = controlledViewerState ?? localViewerState;
  const evidence = useMemo(() => buildPlanReviewEvidencePresentation({
    edited: planText !== originalPlan,
    filePath,
    maxOutlineItems: 8,
    plan: planText,
  }), [filePath, originalPlan, planText]);
  const isEdit = viewerState === 'edit';
  const isMinimized = viewerState === 'minimized';
  const expandedPlan = viewerState === 'expanded' || viewerState === 'edit';
  const fillAvailableHeight = expandedPlan && !isMinimized;
  const planViewportHeight = expandedPlan
    ? touchLayout.planPreviewFullMinHeight
    : touchLayout.planPreviewMaxHeight;
  const resolveBusy = isPlanReviewResolveBusy({ busy });

  useEffect(() => {
    skipNextPlanDraftSaveRef.current = true;
    const draft = readPlanReviewDraft(requestId);
    setPlanText(draft?.planText ?? planReviewPlan(item.request));
    setFeedback(draft?.feedback ?? '');
    setFeedbackOpen(draft?.feedbackOpen ?? false);
    if (!viewerStateControlled) setLocalViewerState('half');
    setLastExpandedState('half');
    setActiveOutlineId(null);
  }, [requestId, item.request, viewerStateControlled]);

  useEffect(() => {
    if (!requestId) return;
    if (skipNextPlanDraftSaveRef.current) {
      skipNextPlanDraftSaveRef.current = false;
      return;
    }
    savePlanReviewDraft(requestId, { feedback, feedbackOpen, planText });
  }, [feedback, feedbackOpen, planText, requestId]);

  const updateViewerState = (next: MobilePlanViewerState) => {
    if (viewerStateControlled) onViewerStateChange?.(next);
    else setLocalViewerState(next);
    if (next !== 'minimized') setLastExpandedState(next);
  };

  const jumpToOutline = (entry: PlanReviewEvidencePresentation['outlineItems'][number]) => {
    setActiveOutlineId(entry.id);
    if (viewerState === 'minimized') updateViewerState(lastExpandedState);
    previewScrollRef.current?.scrollTo({
      y: Math.max(0, (entry.line - 1) * PLAN_PREVIEW_LINE_HEIGHT),
      animated: true,
    });
  };

  const denyWithFeedback = () => {
    const trimmed = feedback.trim();
    if (!trimmed || resolveBusy) return;
    onDecision(buildPlanReviewDecision(false, planText, trimmed));
  };

  const approvePlan = () => {
    if (resolveBusy) return;
    onDecision(buildPlanReviewDecision(true, planText));
  };

  return (
    <View
      style={[
        styles.planReviewStack,
        fillAvailableHeight && styles.planReviewStackFullHeight,
        { gap: touchLayout.cardGap },
      ]}
      testID="interaction.plan.card"
    >
      <View
        style={[
          styles.planViewerCard,
          isMinimized && styles.planViewerCardMinimized,
          fillAvailableHeight && styles.planViewerCardFullHeight,
        ]}
        testID="interaction.plan.viewerCard"
      >
        {isMinimized ? (
          <InteractionTouchButton
            accessibilityLabel={t('interaction.panel.planExpand')}
            disabled={resolveBusy}
            onPress={() => updateViewerState(lastExpandedState)}
            style={styles.planMinimizedBar}
            testID="interaction.plan.expandButton"
          >
            <Text numberOfLines={1} style={styles.planMinimizedTitle}>{t('interaction.panel.planReviewTitle')}</Text>
            <View style={styles.iconControl}>
              <Plus color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
            </View>
          </InteractionTouchButton>
        ) : (
          <>
            <View style={styles.planViewerHeader}>
              <View style={styles.planViewerTitleWrap}>
                <Text numberOfLines={1} style={styles.planViewerTitle}>{t('interaction.panel.planReviewTitle')}</Text>
                <Text numberOfLines={1} style={styles.planViewerHint}>
                  {isEdit ? t('interaction.panel.planEditHint') : t('interaction.panel.planBrowseHint')}
                </Text>
              </View>
              <View style={styles.planToolbar}>
                <InteractionTouchButton
                  accessibilityLabel={isEdit ? t('interaction.panel.planEditExit') : t('interaction.panel.planEditToggle')}
                  disabled={resolveBusy}
                  onPress={() => updateViewerState(isEdit ? 'expanded' : 'edit')}
                  selected={isEdit}
                  style={[styles.planToolbarButton, isEdit && styles.planToolbarButtonActive]}
                  testID="interaction.plan.editTab"
                >
                  <Pencil color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                </InteractionTouchButton>
                <InteractionTouchButton
                  accessibilityLabel={t('interaction.panel.planCollapse')}
                  disabled={resolveBusy}
                  onPress={() => updateViewerState('minimized')}
                  style={styles.planToolbarButton}
                  testID="interaction.plan.minimizeButton"
                >
                  <Minus color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                </InteractionTouchButton>
                <InteractionTouchButton
                  accessibilityLabel={viewerState === 'half' ? t('interaction.panel.planExpandArea') : t('interaction.panel.planHalf')}
                  disabled={resolveBusy}
                  onPress={() => updateViewerState(viewerState === 'half' ? 'expanded' : 'half')}
                  selected={expandedPlan}
                  style={[styles.planToolbarButton, expandedPlan && styles.planToolbarButtonActive]}
                  testID="interaction.plan.sizeButton"
                >
                  {expandedPlan ? (
                    <Minimize2 color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                  ) : (
                    <Maximize2 color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                  )}
                </InteractionTouchButton>
              </View>
            </View>
            <View
              style={[
                styles.planViewerBody,
                fillAvailableHeight && styles.planViewerBodyFullHeight,
                {
                  gap: touchLayout.cardGap,
                  paddingHorizontal: touchLayout.cardPadding,
                  paddingVertical: touchLayout.cardPadding,
                },
              ]}
            >
              {isEdit ? (
                <TextInput
                  accessibilityLabel={t('interaction.panel.planEditorAccessibility')}
                  multiline
                  onChangeText={setPlanText}
                  placeholder={t('interaction.panel.planEditorPlaceholder')}
                  placeholderTextColor={colors.textTertiary}
                  style={[
                    styles.planEditor,
                    fillAvailableHeight
                      ? styles.planEditorFullHeight
                      : { minHeight: planViewportHeight },
                  ]}
                  testID="interaction.plan.editor"
                  value={planText}
                />
              ) : (
                <>
                  {evidence.outlineItems.length > 0 ? (
                    <ScrollView
                      horizontal
                      nestedScrollEnabled
                      showsHorizontalScrollIndicator={false}
                      style={styles.planOutlineScroll}
                      testID="interaction.plan.outline"
                    >
                      <View style={styles.planOutlineRow}>
                        <Text style={styles.planOutlineLabel}>{t('interaction.panel.planOutline')}</Text>
                        {evidence.outlineItems.map((entry) => {
                          const active = entry.id === activeOutlineId;
                          return (
                            <InteractionTouchButton
                              accessibilityLabel={t('interaction.panel.planJumpTo', { title: entry.title })}
                              key={entry.id}
                              onPress={() => jumpToOutline(entry)}
                              selected={active}
                              style={[
                                styles.planOutlineChip,
                                active && styles.planOutlineChipActive,
                              ]}
                              testID="interaction.plan.outlineItem"
                            >
                              <Text
                                numberOfLines={1}
                                style={[
                                  styles.planOutlineChipText,
                                  active && styles.planOutlineChipTextActive,
                                ]}
                                testID={active ? 'interaction.plan.outlineTarget' : undefined}
                              >
                                {entry.title}
                              </Text>
                            </InteractionTouchButton>
                          );
                        })}
                        {evidence.outlineOverflowCount > 0 ? (
                          <Text style={styles.planOutlineMore} testID="interaction.plan.outlineMore">
                            +{evidence.outlineOverflowCount}
                          </Text>
                        ) : null}
                      </View>
                    </ScrollView>
                  ) : null}
                  <ScrollView
                    ref={previewScrollRef}
                    style={[
                      styles.planPreview,
                      fillAvailableHeight
                        ? styles.planPreviewFullHeight
                        : { height: planViewportHeight },
                    ]}
                    nestedScrollEnabled
                    testID="interaction.plan.preview"
                  >
                    <Text selectable style={styles.planText}>{planText || t('interaction.panel.planEmpty')}</Text>
                  </ScrollView>
                </>
              )}
            </View>
          </>
        )}
      </View>

      <View
        style={[
          styles.planActionCard,
          {
            paddingHorizontal: touchLayout.cardPadding,
          },
        ]}
        testID="interaction.plan.actionCard"
      >
        <InteractionTouchButton
          accessibilityLabel={t('interaction.panel.planApproveAccessibility')}
          busy={resolveBusy}
          disabled={resolveBusy}
          onPress={approvePlan}
          style={styles.planApproveRow}
          testID="interaction.plan.approveButton"
        >
          <View style={styles.planApproveIcon}>
            <Check color={colors.ctaText} size={iconSize.sm} strokeWidth={iconStroke.bold} />
          </View>
          <Text numberOfLines={1} style={styles.planApproveText}>{t('interaction.panel.planApprove')}</Text>
          <CornerDownLeft color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
        </InteractionTouchButton>

        {feedbackOpen ? (
          <View style={styles.planFeedbackEditorRow}>
            <Pencil color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
            <TextInput
              accessibilityLabel={t('interaction.panel.planFeedbackLabel')}
              multiline
              onChangeText={setFeedback}
              placeholder={t('interaction.panel.planFeedbackPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              style={styles.planFeedbackInput}
              testID="interaction.plan.feedbackInput"
              value={feedback}
            />
            <InteractionTouchButton
              accessibilityHint={feedback.trim().length === 0 ? t('interaction.panel.planFeedbackRequired') : undefined}
              accessibilityLabel={t('interaction.panel.planFeedbackSubmit')}
              busy={resolveBusy}
              disabled={feedback.trim().length === 0 || resolveBusy}
              onPress={denyWithFeedback}
              style={styles.planFeedbackSubmitButton}
              testID="interaction.plan.submitFeedbackButton"
            >
              <CornerDownLeft
                color={feedback.trim() ? colors.textPrimary : colors.textTertiary}
                size={iconSize.md}
                strokeWidth={iconStroke.regular}
              />
            </InteractionTouchButton>
          </View>
        ) : (
          <InteractionTouchButton
            accessibilityLabel={t('interaction.panel.planFeedbackAccessibility')}
            busy={resolveBusy}
            disabled={resolveBusy}
            onPress={() => setFeedbackOpen(true)}
            style={styles.planFeedbackRow}
            testID="interaction.plan.feedbackButton"
          >
            <Pencil color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
            <Text numberOfLines={1} style={styles.planFeedbackPlaceholder}>{t('interaction.panel.planFeedbackPlaceholder')}</Text>
          </InteractionTouchButton>
        )}
      </View>
    </View>
  );
}

/**
 * plugin_setup 的**只读**状态卡。
 *
 * 手机端做不了配置动作(Secret 输入与 OAuth 必须留在被控端,见
 * docs/dev-rules/plugin-security-and-authoring.md §4 与 desktop 的
 * interactionResolveOrigin),所以这张卡的价值全在「看懂」:哪个插件、卡在哪一步、
 * 为什么失败、回电脑端要做什么。动作只有取消。
 */
function PluginSetupCard({
  busy,
  cancel,
  item,
  requestId,
  touchLayout,
}: {
  busy: boolean;
  cancel: { accessibilityLabel: string; label: string; onPress(): void } | null;
  item: PendingInteraction;
  requestId: string | null;
  touchLayout: InteractionTouchLayout;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const presentation = useMemo(
    () => buildRemotePluginSetupPresentation(item.request),
    [item.request],
  );
  const title = presentation.ghostName ?? t('interaction.kinds.plugin_setup.title');
  return (
    <View style={cardStyle(styles, touchLayout)} testID="interaction.pluginSetup.card">
      <View style={styles.compactCardHeader}>
        {presentation.iconDataUrl ? (
          <Image
            accessibilityIgnoresInvertColors
            // 纯装饰:插件名紧跟其后,读屏再念一次图标只是噪音。
            accessibilityElementsHidden
            importantForAccessibility="no"
            source={{ uri: presentation.iconDataUrl }}
            style={styles.pluginSetupIcon}
            testID="interaction.pluginSetup.icon"
          />
        ) : null}
        <View style={styles.compactCardTitleWrap}>
          <Text style={styles.kind}>{t('interaction.panel.desktopOnlyKind')}</Text>
          <Text numberOfLines={1} style={styles.compactCardTitle}>{title}</Text>
        </View>
        {presentation.stepCount > 0 ? (
          <Text style={styles.pageText} testID="interaction.pluginSetup.progress">
            {t('interaction.pluginSetup.progress', {
              satisfied: presentation.satisfiedCount,
              total: presentation.stepCount,
            })}
          </Text>
        ) : null}
      </View>
      {presentation.intro ? (
        <Text style={styles.body} numberOfLines={3}>{presentation.intro}</Text>
      ) : null}
      {presentation.groups.map((group) => (
        <View key={group.id} style={styles.pluginSetupGroup}>
          {group.anyOf ? (
            <Text style={styles.pluginSetupGroupHint}>{t('interaction.pluginSetup.chooseOne')}</Text>
          ) : null}
          {group.steps.map((step) => (
            <PluginSetupStepRow key={step.id} step={step} />
          ))}
        </View>
      ))}
      {/* 收尾帧已经 settle,再让用户「去电脑端完成」是错的引导。 */}
      {presentation.terminal ? null : (
        <Text style={styles.pluginSetupFootnote}>{t('interaction.pluginSetup.completeOnDesktop')}</Text>
      )}
      {cancel ? (
        <View style={actionsStyle(styles, touchLayout)}>
          <ResolveButton
            accessibilityLabel={cancel.accessibilityLabel}
            busy={busy}
            label={cancel.label}
            onPress={cancel.onPress}
            requestId={requestId}
            touchStyle={resolveButtonLayoutStyle(touchLayout, 'secondary')}
            testID="interaction.pluginSetup.cancelButton"
            variant="secondary"
          />
        </View>
      ) : null}
    </View>
  );
}

/** 运行中的步骤:与桌面同语义,用 Heart Orange 表示「正在进行」。 */
const PLUGIN_SETUP_RUNNING_PHASES: ReadonlySet<RemotePluginSetupPhase> = new Set([
  'action_running',
  'waiting_external',
  'verifying',
]);

function PluginSetupStepRow({ step }: { step: RemotePluginSetupStep }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const phaseColor = step.phase === 'satisfied'
    ? colors.statusReady
    : step.phase && PLUGIN_SETUP_RUNNING_PHASES.has(step.phase)
      ? colors.statusAccent
      : colors.textTertiary;
  const phaseText = step.phase ? t(`interaction.pluginSetup.phase.${step.phase}`) : null;
  const actionHint = step.actionKind === 'inline_form'
    ? (step.inlineFieldLabel
      ? t('interaction.pluginSetup.inlineFormAction', { label: step.inlineFieldLabel })
      : t('interaction.pluginSetup.inlineFormActionGeneric'))
    : step.actionKind
      ? t('interaction.pluginSetup.desktopActionHint', {
        action: t(`interaction.pluginSetup.action.${step.actionKind}`),
      })
      : null;
  // 已完成的步骤不再提示「回电脑端做什么」——那是下一步该做的事。
  const visibleActionHint = actionHint && step.phase !== 'satisfied' ? actionHint : null;
  const errorText = step.errorCode ? t(`interaction.pluginSetup.error.${step.errorCode}`) : null;
  return (
    <View
      // 聚合成一个读屏单元:标题 / 状态 / 待办 / 错误分开念会把一步拆成四条碎片。
      // 分隔符走文案目录:硬编码「，」会让 en / ja / ko 的读屏念出中文标点。
      accessible
      accessibilityLabel={[step.title, phaseText, step.description, visibleActionHint, errorText]
        .filter((part): part is string => !!part)
        .join(t('interaction.pluginSetup.a11ySeparator'))}
      style={styles.pluginSetupStep}
      testID="interaction.pluginSetup.step"
    >
      <View style={styles.pluginSetupStepHeader}>
        <Text numberOfLines={2} style={styles.pluginSetupStepTitle}>{step.title}</Text>
        {phaseText ? (
          <Text style={[styles.pluginSetupPhase, { color: phaseColor }]}>{phaseText}</Text>
        ) : null}
      </View>
      {step.description ? (
        <Text numberOfLines={2} style={styles.pluginSetupStepBody}>{step.description}</Text>
      ) : null}
      {visibleActionHint ? (
        <Text style={styles.pluginSetupStepAction}>{visibleActionHint}</Text>
      ) : null}
      {errorText ? (
        <Text style={styles.pluginSetupStepError} testID="interaction.pluginSetup.stepError">
          {errorText}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * 本端既处理不了、也没有可用出口的卡:缺 requestId 的残卡、issue_confirm,以及
 * 任何未知 kind。纯展示——`plugin_setup` 自 PluginSetupCard 起不再走这里,当时
 * 为它加的 cancel / busy / kindLabel / summaryLines 形参已随之失去调用方,一并
 * 移除,避免留下没人走的分支。
 */
function UnsupportedCard({
  message,
  request,
  touchLayout,
}: {
  message: string;
  request: PendingInteraction['request'];
  touchLayout: InteractionTouchLayout;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  // 未知类型只能靠 request 预览交底;整段一次限行,不按行各自限行(每行各自
  // numberOfLines={6} 会把总可见行数放大成 6 × 行数,#530 review)。
  const summaryText = contentToPreview(request);
  return (
    <View style={cardStyle(styles, touchLayout)} testID="interaction.unsupported.card">
      <Text style={styles.kind}>{t('interaction.panel.unsupportedKind')}</Text>
      <Text style={styles.cardTitle}>{message}</Text>
      {summaryText ? <Text style={styles.body} numberOfLines={6}>{summaryText}</Text> : null}
    </View>
  );
}

function ResolveButton({
  accessibilityLabel,
  armed,
  busy,
  confirmLabel,
  invalidReason,
  label,
  onPress,
  requestId,
  touchStyle,
  testID,
  variant,
}: {
  accessibilityLabel: string;
  armed?: boolean;
  busy: boolean;
  confirmLabel?: string;
  invalidReason?: string | null;
  label: string;
  onPress(): void;
  requestId: string | null;
  touchStyle?: StyleProp<ViewStyle>;
  testID: string;
  variant: 'primary' | 'secondary' | 'inline';
}) {
  const styles = useThemedStyles(makeStyles);
  const presentation = buildInteractionResolveActionPresentation({
    armed,
    busy,
    confirmLabel,
    invalidReason,
    label,
    requestId,
  });
  const buttonStyle = variant === 'primary'
    ? styles.primaryButton
    : variant === 'secondary'
      ? styles.secondaryButton
      : styles.inlineButton;
  const disabledButtonStyle = variant === 'primary' && presentation.disabled
    ? styles.primaryButtonDisabled
    : null;
  const textStyle = variant === 'primary'
    ? styles.primaryText
    : variant === 'secondary'
      ? styles.secondaryText
      : styles.inlineButtonText;
  const disabledTextStyle = variant === 'primary' && presentation.disabled
    ? styles.primaryTextDisabled
    : null;

  return (
    <InteractionTouchButton
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={presentation.disabledReason ?? undefined}
      busy={busy}
      disabled={presentation.disabled}
      onPress={onPress}
      style={[buttonStyle, disabledButtonStyle, touchStyle]}
      testID={testID}
    >
      <Text style={[textStyle, disabledTextStyle]}>{presentation.label}</Text>
    </InteractionTouchButton>
  );
}

function InteractionTouchButton({
  accessibilityHint,
  accessibilityLabel,
  busy = false,
  children,
  disabled = false,
  onPress,
  selected = false,
  style,
  testID,
}: {
  accessibilityHint?: string;
  accessibilityLabel: string;
  busy?: boolean;
  children: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const interactionDisabled = disabled || busy || !onPress;
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{
        busy,
        disabled: interactionDisabled,
        selected,
      }}
      disabled={interactionDisabled}
      onPress={interactionDisabled ? undefined : onPress}
      style={({ pressed }) => [
        style,
        pressed && styles.pressed,
        interactionDisabled && styles.disabled,
      ]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  rootFill: {
    flex: 1,
    minHeight: 0,
  },
  taskHeaderWrap: {
    gap: spacing.xs,
  },
  taskHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 44,
  },
  taskHeaderText: {
    alignItems: 'baseline',
    flex: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minWidth: 0,
  },
  taskEyebrow: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    textTransform: 'uppercase',
  },
  taskTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    minWidth: 0,
  },
  taskCountPill: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  taskCountText: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  taskCollapseButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexShrink: 0,
    gap: spacing.xs,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  taskCollapseText: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  card: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  compactCardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 44,
  },
  compactCardTitleWrap: {
    alignItems: 'baseline',
    flex: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minWidth: 0,
  },
  compactHeaderActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    flexShrink: 0,
  },
  kind: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    textTransform: 'uppercase',
  },
  pageText: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    flexShrink: 0,
  },
  cardTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.body,
  },
  compactCardTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.body,
    minWidth: 0,
  },
  iconControl: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  collapsedInteractionBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingVertical: 0,
  },
  collapsedInteractionText: {
    alignItems: 'baseline',
    flex: 1,
    flexDirection: 'row',
    gap: spacing.md,
    minWidth: 0,
  },
  collapsedInteractionLabel: {
    color: colors.textTertiary,
    flexShrink: 0,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  collapsedInteractionTitle: {
    color: colors.textPrimary,
    flexShrink: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    minWidth: 0,
  },
  collapsedInteractionMeta: {
    color: colors.textTertiary,
    flexShrink: 0,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.regular,
  },
  body: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  pluginSetupIcon: {
    borderRadius: radius.container,
    flexShrink: 0,
    height: iconSize.xxl,
    width: iconSize.xxl,
  },
  pluginSetupGroup: {
    gap: spacing.sm,
  },
  pluginSetupGroupHint: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
  },
  pluginSetupStep: {
    gap: spacing.xs,
  },
  pluginSetupStepHeader: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  pluginSetupStepTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
    minWidth: 0,
  },
  pluginSetupPhase: {
    // 颜色随 phase 内联(已完成 statusReady / 进行中 statusAccent / 其余 textTertiary)。
    flexShrink: 0,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  pluginSetupStepBody: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  pluginSetupStepAction: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  pluginSetupStepError: {
    color: colors.errorText,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  pluginSetupFootnote: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  askHeaderKind: {
    color: colors.textTertiary,
    flex: 1,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    textTransform: 'uppercase',
  },
  askQuestion: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.body,
  },
  askMetaCaption: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  permissionEvidence: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  permissionEvidenceHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  permissionEvidenceTitleWrap: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  permissionEvidenceTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
  },
  permissionEvidenceDetail: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  permissionToolPill: {
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    color: colors.textSecondary,
    flexShrink: 1,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    maxWidth: 112,
    overflow: 'hidden',
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  permissionDescription: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    paddingTop: spacing.sm,
  },
  permissionRiskRow: {
    borderColor: colors.borderStrong,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  permissionRiskRowArmed: {
    backgroundColor: colors.surfaceChip,
    borderColor: colors.borderStrong,
  },
  permissionRiskLabel: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  permissionRiskText: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  permissionCodeBlock: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    maxHeight: 112,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  codeText: {
    color: colors.textPrimary,
    fontFamily: monoFont,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  optionList: {
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  optionRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  optionRowSelected: {
    backgroundColor: colors.surfaceChip,
  },
  optionIndicator: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderWidth: 2,
    height: iconSize.xl,
    justifyContent: 'center',
    width: iconSize.xl,
  },
  // 单选圆形(radio 语义)、多选圆角方形(checkbox 语义),选中都用反色实底 + 勾。
  optionIndicatorRound: {
    borderRadius: radius.pill,
  },
  optionIndicatorSquare: {
    borderRadius: radius.micro,
  },
  optionIndicatorSelected: {
    backgroundColor: colors.cta,
    borderColor: colors.cta,
  },
  optionCopy: { flex: 1, minWidth: 0 },
  optionTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
  },
  optionDescription: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    marginTop: spacing.xs,
  },
  optionCustom: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: typeScale.body,
    fontStyle: 'italic',
  },
  customInputRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.sm,
  },
  customInputRowStacked: {
    alignItems: 'stretch',
    flexDirection: 'column',
  },
  inlineInput: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  inlineInputWide: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.textPrimary,
    fontSize: typeScale.body,
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  inlineButton: {
    backgroundColor: colors.cta,
    borderRadius: radius.pill,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  inlineButtonText: {
    color: colors.ctaText,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  planReviewStack: {
    width: '100%',
  },
  planReviewStackFullHeight: {
    flexBasis: 0,
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
  },
  planViewerCard: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  planViewerCardFullHeight: {
    flexBasis: 0,
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
  },
  planViewerCardMinimized: {
    minHeight: 44,
  },
  planMinimizedBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
  },
  planMinimizedTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    minWidth: 0,
  },
  planViewerHeader: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
  },
  planViewerTitleWrap: {
    alignItems: 'baseline',
    flex: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minWidth: 0,
  },
  planViewerTitle: {
    color: colors.textPrimary,
    flexShrink: 0,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
  },
  planViewerHint: {
    color: colors.textTertiary,
    flex: 1,
    fontSize: typeScale.caption,
    minWidth: 0,
  },
  planToolbar: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 0,
    gap: spacing.xs,
  },
  planToolbarButton: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  planToolbarButtonActive: {
    backgroundColor: colors.surfaceChip,
  },
  planViewerBody: {
    backgroundColor: colors.surfaceElevated,
  },
  planViewerBodyFullHeight: {
    flexBasis: 0,
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
  },
  planOutlineScroll: {
    maxHeight: 44,
  },
  planOutlineRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    paddingRight: spacing.md,
  },
  planOutlineLabel: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    paddingHorizontal: spacing.xs,
  },
  planOutlineChip: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 44,
    maxWidth: 168,
    paddingHorizontal: spacing.md,
  },
  planOutlineChipActive: {
    backgroundColor: colors.cta,
    borderColor: colors.cta,
  },
  planOutlineChipText: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    maxWidth: 144,
  },
  planOutlineChipTextActive: {
    color: colors.ctaText,
  },
  planOutlineMore: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    paddingHorizontal: spacing.sm,
  },
  planPreview: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  planPreviewFullHeight: {
    flexBasis: 0,
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
  },
  planText: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.code,
  },
  planEditor: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.code,
    minHeight: 176,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    textAlignVertical: 'top',
  },
  planEditorFullHeight: {
    flexBasis: 0,
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
  },
  planActionCard: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 0,
    overflow: 'hidden',
  },
  planApproveRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 52,
    paddingVertical: spacing.md,
  },
  planApproveIcon: {
    alignItems: 'center',
    backgroundColor: colors.cta,
    borderRadius: radius.pill,
    height: 20,
    justifyContent: 'center',
    width: 20,
  },
  planApproveText: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.regular,
    minWidth: 0,
  },
  planFeedbackRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 52,
    paddingVertical: spacing.md,
  },
  planFeedbackPlaceholder: {
    color: colors.textTertiary,
    flex: 1,
    fontSize: typeScale.body,
    minWidth: 0,
  },
  planFeedbackEditorRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 52,
    paddingVertical: spacing.md,
  },
  planFeedbackInput: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    lineHeight: lineHeight.body,
    maxHeight: 132,
    minHeight: 44,
    padding: 0,
    textAlignVertical: 'top',
  },
  planFeedbackSubmitButton: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'flex-end',
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.cta,
    borderRadius: radius.pill,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  primaryButtonDisabled: {
    backgroundColor: colors.surfaceChip,
  },
  primaryText: {
    color: colors.ctaText,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  primaryTextDisabled: {
    color: colors.textTertiary,
  },
  secondaryButton: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  secondaryText: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  pressed: {
    opacity: 0.72,
  },
  disabled: {
    opacity: 0.45,
  },
});
