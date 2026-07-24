/**
 * 排队消息 inline 区(消息流末尾,作为消息列表 footer 随内容滚动)。
 *
 * 取代旧的 SessionQueueSheet 底部弹层:排队消息以"待发送的用户气泡"形态直接出现在
 * 会话流里——右对齐、与已发送气泡同款但整体半透明(不透明=已发送,半透明=排队中,
 * 落定时原位变实),气泡左侧「排入队尾 list-end」徽标表示排队态(对齐 Codex 的排队
 * 图标语义);顺序由排列先后表达,不标数字(不用时钟,时钟语义留给定时任务)。
 *
 * 交互契约(状态由父屏持有,本组件纯展示 + 回调):
 * - 轻点气泡 → 展开/收起该条的操作行(取消 / 编辑 / 插队发送),同时只展开一条;
 * - 编辑不在气泡原位改,由父屏把整条消息载入底部 composer(见 [sessionId].tsx 编辑模式),
 *   编辑中的条目在这里变暗 + ✎ 徽标;
 * - 队列暂停(Stop 保留队列)时组顶出现「队列已暂停 + 继续」提示条,徽标变 ⏸;
 * - 队列错误 / 停止确认中沿用原 QueuePanel 的文案语义,以横幅形式出现在组顶。
 *
 * 去重:父屏传入已回流消息的 clientId 集合(hiddenClientIds),已落定的条目不再渲染,
 * 避免「排队气泡 + 正式消息」双显(排队气泡消失的同帧正式气泡已在流里,无跳变)。
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { Text } from '@/components/AppText';
import {
  AlertCircle,
  ArrowUp,
  ListEnd,
  Paperclip,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
  type LucideIcon,
} from 'lucide-react-native';
import { describeAgentAuthError } from '@/device-link/remoteStatus';
import { buildQueueRowPresentation } from '@/session/inputProjection';
import {
  getSentAttachmentThumbUri,
  useSentAttachmentThumbsVersion,
} from '@/session/sentAttachmentThumbStore';
import { syntheticTriggerKind } from '@cindy/maker-shared/synthetic-trigger';
import { stripChatQuoteMarkerLines } from '@cindy/maker-shared/chat-quotes';
import type { MobileOutboxDisplayItem, MobileOutboxThumb } from '@/session/sessionOutbox';
import type { InputProjection, QueuedRemoteMessage } from '@/session/types';
import { iconSize, iconStroke, fontWeight, lineHeight, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing, typeScale } from '@/theme/tokens';
import { i18n } from '@/i18n';

/** 折叠时挂载的排队行数(与旧 QueuePanel 同档),其余收进「展开剩余 N 条」。 */
const COLLAPSED_VISIBLE_ROWS = 3;

/**
 * 排队气泡显示文本:合成 UI 指令行(桌面「失败后继续」等隐藏 prompt)用遮蔽标签
 * 替代原文——裸英文指令不能给用户看(对齐桌面 PendingQueuePanel 的 i18n 遮蔽标签)。
 */
function queueBubbleText(item: Pick<QueuedRemoteMessage, 'text' | 'chatMessage'>): string {
  const visibleText = item.chatMessage.quotesEncoded === true
    ? stripChatQuoteMarkerLines(item.text)
    : item.text;
  const kind = syntheticTriggerKind(visibleText);
  if (kind === 'continue') return i18n.t('message.queue.continueSystemInstruction');
  if (kind === 'generic') return i18n.t('message.queue.systemInstruction');
  return visibleText;
}

/** 本地 outbox 同样不能把产品私有 marker 当正文画出来。 */
function outboxBubbleText(item: MobileOutboxDisplayItem): string {
  return item.quotesEncoded ? stripChatQuoteMarkerLines(item.text) : item.text;
}

/**
 * 排队 / 落定中气泡的图片缩略数据:消息 files 里的图片附件此刻仍是
 * `cindy-oss-attach://` 中转引用,本地渲染靠 sentAttachmentThumbStore 的兜底映射
 * (上传成功时已把实际 PUT 的文件拷进自有目录)。非图片附件走计数行。
 */
function queuedAttachmentThumbs(
  item: Pick<QueuedRemoteMessage, 'clientId' | 'files'>,
): { thumbs: MobileOutboxThumb[]; fileCount: number } {
  const thumbs: MobileOutboxThumb[] = [];
  let fileCount = 0;
  (item.files ?? []).forEach((file, index) => {
    if (file.category !== 'image') {
      fileCount += 1;
      return;
    }
    thumbs.push({
      key: `${item.clientId}-file-${index}`,
      uri: null,
      ossRef: file.url ?? file.path,
      uploading: false,
    });
  });
  return { thumbs, fileCount };
}

/**
 * 气泡内图片缩略条:乐观语义下图片从第一帧就以图的形态出现,不做「📎 附件行 →
 * 正式消息图片」的形态跳变(规则 7 视觉连续性)。uri 缺失时按 ossRef 查
 * sentAttachmentThumbStore(订阅版本号,hydrate / 注册完成后自动补图);
 * 两者都拿不到时渲染 chip 底色占位格。上传中的格子压转圈遮罩。
 */
function AttachmentThumbStrip({ thumbs }: { thumbs: readonly MobileOutboxThumb[] }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  useSentAttachmentThumbsVersion();
  if (thumbs.length === 0) return null;
  return (
    <View style={styles.thumbStrip} testID="queue.inline.thumbStrip">
      {thumbs.map((thumb) => {
        const uri = thumb.uri ?? (thumb.ossRef ? getSentAttachmentThumbUri(thumb.ossRef) : null);
        return (
          <View key={thumb.key} style={styles.thumbCell}>
            {uri ? (
              <Image contentFit="cover" source={{ uri }} style={styles.thumbCellImage} transition={0} />
            ) : null}
            {thumb.uploading ? (
              <View style={styles.thumbUploadingOverlay}>
                <ActivityIndicator color={colors.ctaText} size="small" />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export interface InlineQueueSectionProps {
  projection: InputProjection;
  busy?: boolean;
  readOnlyReason?: string | null;
  /** 展开操作行的条目;null = 全收起。 */
  selectedClientId: string | null;
  /** 正在底部 composer 编辑的条目(变暗 + ✎ 徽标,不可再展开操作)。 */
  editingClientId: string | null;
  /** 已回流进消息流的 clientId(去重不渲染)。 */
  hiddenClientIds?: ReadonlySet<string>;
  /**
   * 落定中条目(已被桌面端 drain 出队、消息尚未回流):渲染为不可交互的半透明
   * 气泡 + 转圈徽标,填补 device-link 下「出队→落库回流」的窗口,保证原位变实
   * 不闪断。生命周期由屏幕侧跟踪(回流/超时移除)。
   */
  settlingItems?: readonly QueuedRemoteMessage[];
  /**
   * 本地待发条目(outbox:附件仍在上传 / enqueue 在途或失败,消息尚未真正入队):
   * 渲染在排队行之后(它们是最晚发出的),转圈徽标 + 「上传中 k/N」;失败时
   * 展示错误并提供重试 / 删除。生命周期由屏幕侧 outbox 状态机管理。
   */
  outboxItems?: readonly MobileOutboxDisplayItem[];
  onSelect(clientId: string | null): void;
  onSteer(item: QueuedRemoteMessage): void;
  onBeginEdit(item: QueuedRemoteMessage): void;
  onRemove(clientId: string): void;
  onRetryOutboxItem?(clientId: string): void;
  onRemoveOutboxItem?(clientId: string): void;
  onResume(): void;
  onRetryError(): void;
  onClearError(): void;
}

export function InlineQueueSection({
  projection,
  busy,
  readOnlyReason,
  selectedClientId,
  editingClientId,
  hiddenClientIds,
  settlingItems,
  outboxItems,
  onSelect,
  onSteer,
  onBeginEdit,
  onRemove,
  onRetryOutboxItem,
  onRemoveOutboxItem,
  onResume,
  onRetryError,
  onClearError,
}: InlineQueueSectionProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  // 本区在 FlatList 的 ListFooterComponent 里,行不参与虚拟化:默认只挂前
  // COLLAPSED_VISIBLE_ROWS 条(最先发送的在前),其余折叠为「展开剩余 N 条」,
  // 防止排队几十条时打开会话即整段挂载导致卡顿(review P2)。展开是用户显式
  // 动作,local state 即可,不复用远端 queueExpanded(面板时代的跨端状态)。
  const [expanded, setExpanded] = useState(false);
  const queue = projection.pendingQueue;
  const visibleQueue = hiddenClientIds
    ? queue.filter((item) => !hiddenClientIds.has(item.clientId))
    : queue;

  const settling = settlingItems ?? [];
  const outbox = outboxItems ?? [];
  if (visibleQueue.length === 0 && settling.length === 0 && outbox.length === 0
    && !projection.queueAbortPending && !projection.error) return null;

  const controlsDisabled = busy || !!readOnlyReason;
  const visibleRows = expanded ? visibleQueue : visibleQueue.slice(0, COLLAPSED_VISIBLE_ROWS);
  const hiddenRowCount = visibleQueue.length - visibleRows.length;

  return (
    <View style={styles.container} testID="queue.inline.section">
      {projection.error ? (
        <View style={styles.errorBox} testID="queue.inline.error">
          {/* agent 未鉴权错误换成带引导的中文提示;其它错误维持原文 */}
          <Text style={styles.errorText}>{describeAgentAuthError(projection.error) ?? projection.error}</Text>
          <View style={styles.errorActions}>
            <ActionPill
              busy={busy}
              disabled={controlsDisabled || !projection.errorRetryText}
              label={t('message.queue.retrySend')}
              onPress={onRetryError}
              testID="queue.inline.retryButton"
            />
            <ActionPill
              busy={busy}
              disabled={controlsDisabled}
              label={t('message.queue.clearError')}
              onPress={onClearError}
              testID="queue.inline.clearErrorButton"
            />
          </View>
        </View>
      ) : null}

      {projection.credentialSwitchWait ? (
        <View style={styles.banner} testID="queue.inline.credentialSwitchWaitBanner">
          <ActivityIndicator color={colors.textTertiary} size="small" />
          <Text style={styles.bannerText}>{t('message.queue.credentialSwitchWait')}</Text>
        </View>
      ) : null}

      {projection.queueAbortPending ? (
        <View style={styles.banner} testID="queue.inline.abortBanner">
          <ActivityIndicator color={colors.textTertiary} size="small" />
          <Text style={styles.bannerText}>{t('message.queue.aborting')}</Text>
        </View>
      ) : projection.queuePaused ? (
        <View style={styles.banner} testID="queue.inline.pausedBanner">
          <Pause color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          <Text style={styles.bannerText}>{t('message.queue.paused')}</Text>
          <QueueTouchButton
            accessibilityLabel={t('message.queue.resumeSendQueue')}
            busy={busy}
            disabled={controlsDisabled}
            disabledReason={readOnlyReason}
            onPress={onResume}
            style={styles.resumePill}
            testID="queue.inline.resumeButton"
          >
            <Play color={colors.ctaText} fill={colors.ctaText} size={iconSize.xs} strokeWidth={iconStroke.regular} />
            <Text style={styles.resumePillText}>{t('message.queue.resume')}</Text>
          </QueueTouchButton>
        </View>
      ) : null}

      {settling.map((item) => {
        const settlingThumbs = queuedAttachmentThumbs(item);
        return (
          <View key={`settling-${item.clientId}`} style={styles.rowWrap} testID={`queue.inline.settling.${item.clientId}`}>
            <View style={styles.bubbleRow}>
              <View style={styles.badge}>
                <ActivityIndicator color={colors.textTertiary} size="small" />
              </View>
              <View style={[styles.bubble, styles.bubbleSettling]}>
                {item.text ? (
                  <Text numberOfLines={6} style={styles.bubbleText}>{queueBubbleText(item)}</Text>
                ) : null}
                <AttachmentThumbStrip thumbs={settlingThumbs.thumbs} />
                {settlingThumbs.fileCount > 0 ? (
                  <View style={styles.attachmentLine}>
                    <Paperclip color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.regular} />
                    <Text style={styles.attachmentLineText}>{t('message.queue.attachmentCount', { n: settlingThumbs.fileCount })}</Text>
                  </View>
                ) : null}
              </View>
            </View>
          </View>
        );
      })}
      {visibleRows.map((item) => {
        const originalIndex = queue.findIndex((candidate) => candidate.clientId === item.clientId);
        const presentation = buildQueueRowPresentation({
          busy,
          item,
          originalIndex,
          projection,
          queueLength: queue.length,
          readOnlyReason,
        });
        const editing = editingClientId === item.clientId;
        const selected = !editing && selectedClientId === item.clientId;
        const queuedThumbs = queuedAttachmentThumbs(item);
        return (
          <View key={item.clientId} style={styles.rowWrap} testID={`queue.inline.row.${originalIndex + 1}`}>
            <View style={styles.bubbleRow}>
              <View style={styles.badge} testID={`queue.inline.badge.${originalIndex + 1}`}>
                {presentation.steering ? (
                  <ActivityIndicator color={colors.textTertiary} size="small" />
                ) : editing ? (
                  <Pencil color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                ) : (
                  // 暂停态不换 ⏸:组顶横幅已表达暂停,逐条再换会重复;行内恒用排队 icon。
                  <ListEnd color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                )}
              </View>
              <Pressable
                accessibilityHint={presentation.hint ?? undefined}
                accessibilityLabel={presentation.steering
                  ? t('message.queue.steeringLabel', { text: queueBubbleText(item) || t('message.queue.attachmentMessage') })
                  : t('message.queue.queuedMessageLabel', { index: originalIndex + 1, text: queueBubbleText(item) || t('message.queue.attachmentMessage') })}
                accessibilityRole="button"
                accessibilityState={{ expanded: selected, disabled: editing }}
                disabled={editing}
                onPress={() => onSelect(selected ? null : item.clientId)}
                style={({ pressed }) => [
                  styles.bubble,
                  selected && styles.bubbleSelected,
                  editing && styles.bubbleEditing,
                  pressed && styles.pressed,
                ]}
                testID={`queue.inline.bubble.${originalIndex + 1}`}
              >
                {item.text ? (
                  <Text numberOfLines={selected ? undefined : 6} style={styles.bubbleText}>
                    {queueBubbleText(item)}
                  </Text>
                ) : null}
                <AttachmentThumbStrip thumbs={queuedThumbs.thumbs} />
                {queuedThumbs.fileCount > 0 ? (
                  <View style={styles.attachmentLine}>
                    <Paperclip color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.regular} />
                    <Text style={styles.attachmentLineText}>{t('message.queue.attachmentCount', { n: queuedThumbs.fileCount })}</Text>
                  </View>
                ) : null}
                {editing ? (
                  <Text style={styles.editingHint} testID={`queue.inline.editingHint.${originalIndex + 1}`}>
                    {t('message.queue.editingInComposer')}
                  </Text>
                ) : null}
              </Pressable>
            </View>
            {selected && presentation.hint ? (
              <Text style={styles.rowHint} testID={`queue.inline.rowHint.${originalIndex + 1}`}>
                {presentation.hint}
              </Text>
            ) : null}
            {selected ? (
              <View style={styles.actionRow} testID={`queue.inline.actions.${originalIndex + 1}`}>
                <ActionPill
                  busy={busy}
                  disabled={presentation.actions.remove.disabled}
                  disabledReason={presentation.actions.remove.disabledReason}
                  icon={Trash2}
                  label={t('message.queue.cancel')}
                  onPress={() => onRemove(item.clientId)}
                  testID={`queue.inline.remove.${originalIndex + 1}`}
                />
                <ActionPill
                  busy={busy}
                  disabled={presentation.actions.edit.disabled}
                  disabledReason={presentation.actions.edit.disabledReason}
                  icon={Pencil}
                  label={t('message.queue.edit')}
                  onPress={() => onBeginEdit(item)}
                  testID={`queue.inline.edit.${originalIndex + 1}`}
                />
                <ActionPill
                  busy={busy}
                  cta
                  disabled={presentation.actions.steer.disabled}
                  disabledReason={presentation.actions.steer.disabledReason}
                  icon={ArrowUp}
                  label={t('message.queue.steer')}
                  onPress={() => onSteer(item)}
                  testID={`queue.inline.steer.${originalIndex + 1}`}
                />
              </View>
            ) : null}
          </View>
        );
      })}
      {hiddenRowCount > 0 || (expanded && visibleQueue.length > COLLAPSED_VISIBLE_ROWS) ? (
        <View style={styles.toggleRow}>
          <QueueTouchButton
            accessibilityLabel={expanded ? t('message.queue.collapseQueued') : t('message.queue.expandRemainingQueued', { n: hiddenRowCount })}
            onPress={() => setExpanded(!expanded)}
            style={styles.togglePill}
            testID="queue.inline.toggle"
          >
            <Text style={styles.togglePillText}>
              {expanded ? t('message.queue.collapse') : t('message.queue.expandRemaining', { n: hiddenRowCount })}
            </Text>
          </QueueTouchButton>
        </View>
      ) : null}
      {/* 本地待发条目(outbox):恒排在排队行之后——它们是最晚发出的消息。
          附件仍在上传时消息就已在对话里,这是「点发送即上屏」的乐观语义主体。 */}
      {outbox.map((item, outboxIndex) => {
        const selected = selectedClientId === item.clientId;
        const uploadsPending = item.attachmentCount > 0 && item.uploadedCount < item.attachmentCount;
        const visibleText = outboxBubbleText(item);
        return (
          <View key={item.clientId} style={styles.rowWrap} testID={`queue.inline.outbox.${outboxIndex + 1}`}>
            <View style={styles.bubbleRow}>
              <View style={styles.badge} testID={`queue.inline.outboxBadge.${outboxIndex + 1}`}>
                {item.failed ? (
                  <AlertCircle color={colors.errorText} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                ) : (
                  <ActivityIndicator color={colors.textTertiary} size="small" />
                )}
              </View>
              <Pressable
                accessibilityLabel={item.failed
                  ? t('message.queue.sendFailedMessage', { text: visibleText || t('message.queue.attachmentMessage') })
                  : t('message.queue.sendingMessage', { text: visibleText || t('message.queue.attachmentMessage') })}
                accessibilityRole="button"
                accessibilityState={{ expanded: selected }}
                onPress={() => onSelect(selected ? null : item.clientId)}
                style={({ pressed }) => [
                  styles.bubble,
                  selected && styles.bubbleSelected,
                  pressed && styles.pressed,
                ]}
                testID={`queue.inline.outboxBubble.${outboxIndex + 1}`}
              >
                {visibleText ? (
                  <Text numberOfLines={selected ? undefined : 6} style={styles.bubbleText}>{visibleText}</Text>
                ) : null}
                <AttachmentThumbStrip thumbs={item.thumbnails} />
                {item.fileCount > 0 || uploadsPending ? (
                  <View style={styles.attachmentLine}>
                    <Paperclip color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.regular} />
                    <Text style={styles.attachmentLineText}>
                      {uploadsPending
                        ? t('message.queue.uploadingAttachments', { uploaded: item.uploadedCount, total: item.attachmentCount })
                        : t('message.queue.attachmentCount', { n: item.fileCount })}
                    </Text>
                  </View>
                ) : null}
                {item.errorText ? (
                  <Text style={styles.outboxErrorText} testID={`queue.inline.outboxError.${outboxIndex + 1}`}>
                    {item.errorText}
                  </Text>
                ) : null}
              </Pressable>
            </View>
            {selected ? (
              <View style={styles.actionRow} testID={`queue.inline.outboxActions.${outboxIndex + 1}`}>
                <ActionPill
                  busy={busy}
                  icon={Trash2}
                  label={t('message.queue.delete')}
                  onPress={() => onRemoveOutboxItem?.(item.clientId)}
                  testID={`queue.inline.outboxRemove.${outboxIndex + 1}`}
                />
                {item.failed ? (
                  <ActionPill
                    busy={busy}
                    cta
                    icon={RotateCcw}
                    label={t('message.queue.retry')}
                    onPress={() => onRetryOutboxItem?.(item.clientId)}
                    testID={`queue.inline.outboxRetry.${outboxIndex + 1}`}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function ActionPill({
  busy,
  cta,
  disabled,
  disabledReason,
  icon: Icon,
  label,
  onPress,
  testID,
}: {
  busy?: boolean;
  cta?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  icon?: LucideIcon;
  label: string;
  onPress(): void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const iconColor = cta ? colors.ctaText : colors.textSecondary;
  return (
    <QueueTouchButton
      accessibilityLabel={label}
      busy={busy}
      disabled={disabled}
      disabledReason={disabledReason}
      onPress={onPress}
      style={[styles.actionPill, cta && styles.actionPillCta]}
      testID={testID}
    >
      {Icon ? <Icon color={iconColor} size={iconSize.sm} strokeWidth={iconStroke.regular} /> : null}
      <Text style={[styles.actionPillText, cta && styles.actionPillTextCta]}>{label}</Text>
    </QueueTouchButton>
  );
}

function QueueTouchButton({
  accessibilityLabel,
  busy = false,
  children,
  disabled = false,
  disabledReason,
  onPress,
  style,
  testID,
}: {
  accessibilityLabel: string;
  busy?: boolean;
  children: ReactNode;
  disabled?: boolean;
  disabledReason?: string | null;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const interactionDisabled = disabled || !onPress;
  return (
    <Pressable
      accessibilityHint={disabledReason ?? undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy: busy || undefined, disabled: interactionDisabled }}
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
  container: { gap: spacing.sm, paddingTop: spacing.sm, width: '100%' },
  banner: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bannerText: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    minWidth: 0,
  },
  resumePill: {
    alignItems: 'center',
    backgroundColor: colors.cta,
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: 4,
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  resumePillText: { color: colors.ctaText, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  errorBox: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  errorText: { color: colors.errorText, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  errorActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  rowWrap: { alignItems: 'flex-end', gap: spacing.sm, width: '100%' },
  bubbleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'flex-end',
    width: '100%',
  },
  badge: { alignItems: 'center', flexDirection: 'row' },
  // 排队气泡:与已发送用户气泡同款(surfaceElevated + borderStrong)但整体半透明——
  // "这就是你的消息,只是还没生效";落定时原位变为完全不透明,过渡自然无跳变。
  // 顺序由排列先后表达,不标数字。
  bubble: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.borderStrong,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    maxWidth: '86%',
    opacity: 0.62,
    padding: spacing.md,
  },
  bubbleSelected: {
    borderColor: colors.textSecondary,
    opacity: 1,
  },
  bubbleEditing: { opacity: 0.38 },
  // 落定中:即将变实,透明度介于排队(0.62)与已发送(1)之间。
  bubbleSettling: { opacity: 0.85 },
  bubbleText: {
    color: colors.textPrimary,
    fontSize: typeScale.bodyLarge,
    lineHeight: lineHeight.bodyLarge,
  },
  attachmentLine: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  attachmentLineText: { color: colors.textTertiary, fontSize: typeScale.footnote },
  // 气泡内图片缩略条(与 ComposerAttachmentTray 缩略卡同一视觉词汇:chip 底 +
  // hairline 边 + container 圆角;上传中压 overlay 遮罩转圈)。
  thumbStrip: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, justifyContent: 'flex-end' },
  thumbCell: {
    backgroundColor: colors.surfaceChip,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    height: 72,
    overflow: 'hidden',
    width: 72,
  },
  thumbCellImage: { height: '100%', width: '100%' },
  thumbUploadingOverlay: {
    alignItems: 'center',
    backgroundColor: colors.overlay,
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  outboxErrorText: { color: colors.errorText, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  editingHint: { color: colors.textTertiary, fontSize: typeScale.footnote },
  rowHint: {
    color: colors.textTertiary,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
    textAlign: 'right',
  },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'flex-end' },
  actionPill: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 6,
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  actionPillCta: { backgroundColor: colors.cta, borderColor: colors.cta },
  actionPillText: { color: colors.textPrimary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  actionPillTextCta: { color: colors.ctaText },
  toggleRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  togglePill: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  togglePillText: { color: colors.textSecondary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.42 },
});
