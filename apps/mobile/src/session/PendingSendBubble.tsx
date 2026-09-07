/**
 * 待发送消息气泡(渲染在消息流里,不再是列表 footer)。
 *
 * 形态与已发送用户气泡同款(右对齐、surfaceElevated + borderStrong)但整体半透明——
 * 「这就是你的消息,只是还没生效」;落定时提高不透明度,回流后同一个列表位置换成正式
 * 消息,原地变实。徽标语义:
 *  - 转圈 = 还没有「已被收下」这个事实(enqueue 在途 / 已出队待回流 / 附件上传中);
 *  - 「排入队尾 list-end」= 已确认入队,顺序由排列先后表达,不标数字;
 *  - ✎ = 正在底部 composer 编辑这一条;
 *  - ⚠ = 失败,可重试 / 删除。
 * 「排入队尾」是个事实断言,未确认时画它就是谎报,所以未确认一律转圈。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { buildMessageContentLayout } from '@/session/messageContentLayout';
import { summarizeMessageBubblePresentation } from '@/session/messagePresentation';
import { LONG_USER_MESSAGE_COLLAPSED_LINES, LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD, mayExceedVisualLineThreshold, resolveUserMessageCollapse } from '@/session/userMessageCollapse';
import { sentInlineTokensDisplayText } from '@/session/sentMessageAtoms';
import { SentInlineAtomBody } from '@/session/SentInlineAtomBody';
import {
  AlertCircle,
  ArrowUp,
  ListEnd,
  Paperclip,
  Pencil,
  RotateCcw,
  Trash2,
  type LucideIcon,
} from 'lucide-react-native';
import {
  getSentAttachmentThumbUri,
  useSentAttachmentThumbsVersion,
} from '@/session/sentAttachmentThumbStore';
import {
  isPendingSendItemSelected,
  pendingSendSpins,
  type MobilePendingSendItem,
} from '@/session/pendingSendItems';
import {
  isDesktopLocalMediaUrl,
  type ResolveRemoteMediaFn,
} from '@/session/remoteMedia';
import type { MobileOutboxThumb } from '@/session/sessionOutbox';
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from '@/theme';
import { radius, spacing, typeScale } from '@/theme/tokens';

export interface PendingSendBubbleActions {
  /** 展开 / 收起操作行的条目;null = 全收起。 */
  selectedClientId: string | null;
  onSelect(clientId: string | null): void;
  onRemove(clientId: string): void;
  onBeginEdit(clientId: string): void;
  onSteer(clientId: string): void;
  onRetryOutbox(clientId: string): void;
  onRemoveOutbox(clientId: string): void;
  busy?: boolean;
}

/**
 * 气泡上方图片附件条:乐观语义下图片从第一帧就以图的形态出现,不做「📎 附件行 → 正式消息
 * 图片」的形态跳变。uri 缺失时按 ossRef 查 sentAttachmentThumbStore(订阅版本号,
 * hydrate / 注册完成后自动补图);两者都拿不到时渲染 chip 底色占位格。
 */
/**
 * 单格缩略图的 uri 解析,三条来源按可靠性排序:
 *  1. sentAttachmentThumbStore 的持久拷贝 —— 手机上传的图,活得比粘贴源文件久;
 *  2. 发送时刻记下的本地预览 file://;
 *  3. 远端媒体解析 —— 粘贴时图片已经先传到媒体总仓的场景,附件 url 是
 *     `cindy-media://blobs/<指纹>`,本地根本没有这个文件,只能经 device-link 取缩略图
 *     (正式消息就是走这条路;不走的话排队气泡只能画空占位格)。
 */
function useThumbCellUri(
  thumb: MobileOutboxThumb,
  resolveRemoteMedia?: ResolveRemoteMediaFn,
): string | null {
  // 「这一格现在指的是哪张图」。排队消息被编辑、同一附件下标换成另一张图时,ThumbCell 的
  // key(clientId-file-index)不变、hook 实例被复用 —— 所有缓存都必须绑定这个身份,否则旧图
  // 会一直压住新图直到整行卸载,编辑后的气泡显示的是已被移除的附件(review P1)。
  const identity = `${thumb.uri ?? ''}|${thumb.ossRef ?? ''}`;
  const durableUri = thumb.ossRef ? getSentAttachmentThumbUri(thumb.ossRef) : null;
  const localUri = durableUri ?? thumb.uri ?? null;
  const [remoteState, setRemoteState] = useState<{ uri: string; identity: string } | null>(null);
  const remoteUri = remoteState?.identity === identity ? remoteState.uri : null;
  const remoteCandidate = localUri ? null : thumb.ossRef;
  useEffect(() => {
    if (!remoteCandidate || !resolveRemoteMedia || !isDesktopLocalMediaUrl(remoteCandidate)) {
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const resolved = await resolveRemoteMedia(
          { kind: 'image', url: remoteCandidate, previewable: false, thumbnail: true },
          { signal: controller.signal },
        );
        if (!cancelled && resolved.url) setRemoteState({ uri: resolved.url, identity });
      } catch {
        // 取不到就回落占位格:待发气泡的图是增强,不能因为取件失败妨碍发送流程。
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [identity, remoteCandidate, resolveRemoteMedia]);
  const candidate = localUri ?? remoteUri;
  // 已显示出来的 uri 锁住,不为「更可靠的来源出现」而换:三条来源可用时机不同(本地底片要
  // 等 store hydrate、远端取件更晚),换 uri 会让 Image 重新加载、中间露出底色(闪白)。
  // 锁同样绑身份:身份变了就解锁,重新按新图取。
  const shownRef = useRef<{ uri: string; identity: string } | null>(null);
  const shown = shownRef.current?.identity === identity ? shownRef.current.uri : null;
  // 写 ref 放 layout effect(render 阶段不碰 ref:Concurrent 下被丢弃的 render 会污染它)。
  useLayoutEffect(() => {
    if (candidate && shownRef.current?.identity !== identity) {
      shownRef.current = { uri: candidate, identity };
    }
  }, [candidate, identity]);
  return shown ?? candidate;
}

function ThumbCell({
  thumb,
  resolveRemoteMedia,
  renderImage,
}: {
  renderImage: (uri: string | null) => ReactNode;
  thumb: MobileOutboxThumb;
  resolveRemoteMedia?: ResolveRemoteMediaFn;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const uri = useThumbCellUri(thumb, resolveRemoteMedia);
  return (
    <View style={styles.thumbCell}>
      {renderImage(uri)}
      {thumb.uploading ? (
        <View style={styles.thumbUploadingOverlay}>
          <ActivityIndicator color={colors.ctaText} size="small" />
        </View>
      ) : null}
    </View>
  );
}

function AttachmentThumbStrip({
  thumbs,
  resolveRemoteMedia,
  renderImage,
  gap,
}: {
  renderImage: (uri: string | null) => ReactNode;
  gap: number;
  thumbs: readonly MobileOutboxThumb[];
  resolveRemoteMedia?: ResolveRemoteMediaFn;
}) {
  const styles = useThemedStyles(makeStyles);
  useSentAttachmentThumbsVersion();
  if (thumbs.length === 0) return null;
  return (
    <View style={[styles.thumbStrip, { gap }]} testID="pendingSend.thumbStrip">
      {thumbs.map((thumb) => (
        <ThumbCell renderImage={renderImage} key={thumb.key} resolveRemoteMedia={resolveRemoteMedia} thumb={thumb} />
      ))}
    </View>
  );
}

export function PendingSendBubble({
  item,
  actions,
  resolveRemoteMedia,
  renderImage,
  renderText,
  renderFile,
  screenWidth,
}: {
  renderImage: (uri: string | null) => ReactNode;
  renderText: (text: string, index: number) => ReactNode;
  renderFile: (name: string, index: number) => ReactNode;
  screenWidth?: number;
  item: MobilePendingSendItem;
  actions: PendingSendBubbleActions;
  /** 远端媒体取件(粘贴时已上传到媒体总仓的图靠它取缩略图)。 */
  resolveRemoteMedia?: ResolveRemoteMediaFn;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const spinning = pendingSendSpins(item.phase);
  const editing = item.phase === 'editing';
  const failed = item.phase === 'failed';
  const interactive = item.actions !== null || failed;
  const selected = isPendingSendItemSelected(item, actions.selectedClientId);
  const bubbleLabel = item.text || t('message.queue.attachmentMessage');
  const uploadsPending = item.phase === 'uploading';
  const layout = buildMessageContentLayout({ screenWidth });
  const rendersSentInlineBody = item.sentInlineTokens.some((token) => token.kind !== 'text');
  const displayBody = rendersSentInlineBody ? sentInlineTokensDisplayText(item.sentInlineTokens) : item.text;
  const density = summarizeMessageBubblePresentation({ kind: 'user', body: displayBody, attachmentCount: item.attachmentCount }).density;
  const [measuredBody, setMeasuredBody] = useState<{ body: string; lines: number } | null>(null);
  const [expandedBody, setExpandedBody] = useState<string | null>(null);
  const measureBody = mayExceedVisualLineThreshold(displayBody);
  const shouldCollapse = measureBody && resolveUserMessageCollapse(
    displayBody, measuredBody?.body === displayBody ? measuredBody.lines : null,
    LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  );
  const expanded = expandedBody === displayBody;
  const collapsedLines = shouldCollapse && !expanded ? LONG_USER_MESSAGE_COLLAPSED_LINES : undefined;
  const hasBody = !!displayBody;

  return (
    <View style={styles.rowWrap} testID={`pendingSend.row.${item.clientId}`}>
      <View style={styles.bubbleRow}>
        <View pointerEvents="none" style={styles.badge} testID={`pendingSend.badge.${item.phase}`}>
          {failed ? (
            <AlertCircle color={colors.errorText} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          ) : spinning ? (
            <ActivityIndicator color={colors.textTertiary} size="small" />
          ) : editing ? (
            <Pencil color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          ) : (
            // 暂停态不换 ⏸:组顶横幅已表达暂停,逐条再换会重复;行内恒用排队 icon。
            <ListEnd color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          )}
        </View>
        <Pressable
          accessibilityHint={item.hint ?? undefined}
          accessibilityLabel={failed
            ? t('message.queue.sendFailedMessage', { text: bubbleLabel })
            : spinning
              ? t('message.queue.sendingMessage', { text: bubbleLabel })
              : item.queueIndex !== null
                ? t('message.queue.queuedMessageLabel', { index: item.queueIndex, text: bubbleLabel })
                : t('message.queue.sendingMessage', { text: bubbleLabel })}
          accessibilityRole="button"
          accessibilityState={{ expanded: selected, disabled: !interactive }}
          disabled={!interactive}
          hitSlop={{ left: iconSize.xl + spacing.sm }}
          onPress={() => actions.onSelect(selected ? null : item.clientId)}
          style={({ pressed }) => [
            styles.content,
            item.phase === 'settling' && styles.bubbleSettling,
            selected && styles.bubbleSelected,
            editing && styles.bubbleEditing,
            pressed && styles.pressed,
          ]}
          testID={`pendingSend.bubble.${item.clientId}`}
        >
          {item.thumbs.length > 0 || item.fileNames?.length ? (
            <View style={[styles.attachmentStrip, { gap: layout.attachmentGap }]}>
              <AttachmentThumbStrip
                gap={layout.attachmentGap}
                renderImage={renderImage}
                resolveRemoteMedia={resolveRemoteMedia}
                thumbs={item.thumbs}
              />
              {item.fileNames?.length ? (
                <View style={[styles.thumbStrip, { gap: layout.attachmentGap, maxWidth: layout.fileChipMaxWidth }]}>
                  {item.fileNames.map(renderFile)}
                </View>
              ) : null}
            </View>
          ) : null}
          {hasBody ? (
            <View style={[styles.bubble, density === 'compact' && styles.bubbleCompact, density === 'rich' && styles.bubbleRich]}>
              {rendersSentInlineBody ? (
                <SentInlineAtomBody
                  interactiveAtoms={false}
                  maxVisibleLines={collapsedLines}
                  numberOfLines={collapsedLines}
                  renderText={collapsedLines ? undefined : (text, index) => (
                    <View key={`text:${index}`} style={styles.textChunk}>{renderText(text, index)}</View>
                  )}
                  testID="pendingSend.sentInlineAtoms"
                  textStyle={styles.bubbleText}
                  tokens={item.sentInlineTokens}
                />
              ) : item.text && !collapsedLines ? renderText(item.text, 0) : item.text ? (
                <Text numberOfLines={collapsedLines} style={styles.bubbleText}>
                  {item.text}
                </Text>
              ) : null}
            {measureBody ? (
              <View accessibilityElementsHidden accessible={false} importantForAccessibility="no-hide-descendants"
                pointerEvents="none" style={styles.collapseMeasureWrap}>
                <Text numberOfLines={LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD + 1}
                  onTextLayout={(event) => setMeasuredBody({ body: displayBody, lines: event.nativeEvent.lines.length })}
                  style={styles.bubbleText}>{displayBody}</Text>
              </View>
            ) : null}
            {shouldCollapse ? (
              <Text accessibilityRole="button" suppressHighlighting
                accessibilityLabel={expanded ? t('message.renderer.collapseMessage') : t('message.renderer.expandMessage')}
                onPress={(event) => { event.stopPropagation(); setExpandedBody(expanded ? null : displayBody); }}
                style={styles.collapseToggleText}>
                {expanded ? t('message.renderer.collapse') : t('message.renderer.expand')}
              </Text>
            ) : null}
            </View>
          ) : null}
          {(item.fileCount > 0 && !item.fileNames?.length) || uploadsPending ? (
            <View style={styles.attachmentLine}>
              <Paperclip color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.regular} />
              <Text style={styles.attachmentLineText}>
                {uploadsPending
                  ? t('message.queue.uploadingAttachments', {
                      uploaded: item.uploadedCount,
                      total: item.attachmentCount,
                    })
                  : t('message.queue.attachmentCount', { n: item.fileCount })}
              </Text>
            </View>
          ) : null}
          {editing ? (
            <Text style={styles.editingHint} testID={`pendingSend.editingHint.${item.clientId}`}>
              {t('message.queue.editingInComposer')}
            </Text>
          ) : null}
          {item.errorText ? (
            <Text style={styles.errorText} testID={`pendingSend.error.${item.clientId}`}>
              {item.errorText}
            </Text>
          ) : null}
        </Pressable>
      </View>
      {selected && item.hint ? (
        <Text style={styles.rowHint} testID={`pendingSend.hint.${item.clientId}`}>{item.hint}</Text>
      ) : null}
      {selected && item.actions ? (
        <View style={styles.actionRow} testID={`pendingSend.actions.${item.clientId}`}>
          <ActionPill
            busy={actions.busy}
            disabled={item.actions.remove.disabled}
            disabledReason={item.actions.remove.disabledReason}
            icon={Trash2}
            label={t('message.queue.cancel')}
            onPress={() => actions.onRemove(item.clientId)}
            testID={`pendingSend.remove.${item.clientId}`}
          />
          <ActionPill
            busy={actions.busy}
            disabled={item.actions.edit.disabled}
            disabledReason={item.actions.edit.disabledReason}
            icon={Pencil}
            label={t('message.queue.edit')}
            onPress={() => actions.onBeginEdit(item.clientId)}
            testID={`pendingSend.edit.${item.clientId}`}
          />
          <ActionPill
            busy={actions.busy}
            cta
            disabled={item.actions.steer.disabled}
            disabledReason={item.actions.steer.disabledReason}
            icon={ArrowUp}
            label={t('message.queue.steer')}
            onPress={() => actions.onSteer(item.clientId)}
            testID={`pendingSend.steer.${item.clientId}`}
          />
        </View>
      ) : null}
      {selected && failed ? (
        <View style={styles.actionRow} testID={`pendingSend.outboxActions.${item.clientId}`}>
          <ActionPill
            busy={actions.busy}
            icon={Trash2}
            label={t('message.queue.delete')}
            onPress={() => actions.onRemoveOutbox(item.clientId)}
            testID={`pendingSend.outboxRemove.${item.clientId}`}
          />
          <ActionPill
            busy={actions.busy}
            cta
            icon={RotateCcw}
            label={t('message.queue.retry')}
            onPress={() => actions.onRetryOutbox(item.clientId)}
            testID={`pendingSend.outboxRetry.${item.clientId}`}
          />
        </View>
      ) : null}
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
    <Pressable
      accessibilityHint={disabledReason ?? undefined}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy: busy || undefined, disabled }}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.actionPill,
        cta && styles.actionPillCta,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      {Icon ? <Icon color={iconColor} size={iconSize.sm} strokeWidth={iconStroke.regular} /> : null}
      <Text style={[styles.actionPillText, cta && styles.actionPillTextCta]}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  rowWrap: { alignItems: 'flex-end', gap: spacing.sm, width: '100%' },
  bubbleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'flex-end',
    width: '100%',
  },
  badge: { alignItems: 'center', position: 'absolute', left: 0, top: spacing.md, zIndex: 1 },
  // 与已发送用户气泡同款,但整体半透明:「这就是你的消息,只是还没生效」。
  textChunk: { flexBasis: '100%', flexShrink: 1, maxWidth: '100%' },
  content: { alignItems: 'flex-end', gap: 2, width: '100%', opacity: 0.62 },
  bubbleCompact: { gap: 6, paddingVertical: spacing.sm },
  bubbleRich: { gap: spacing.sm },
  bubble: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.borderStrong,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    maxWidth: '86%',
    minWidth: 0,
    overflow: 'hidden',
    padding: spacing.md,
  },
  collapseMeasureWrap: { left: spacing.md, right: spacing.md, top: 0, opacity: 0, position: 'absolute' },
  collapseToggleText: { alignSelf: 'flex-start', color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, paddingVertical: spacing.xs },
  bubbleSelected: { opacity: 1 },
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
  attachmentStrip: { alignItems: 'flex-end', marginBottom: spacing.xs, maxWidth: '100%' },
  thumbStrip: { alignItems: 'flex-end', maxWidth: '100%' },
  thumbCell: { borderRadius: radius.container, overflow: 'hidden' },
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
  editingHint: { color: colors.textTertiary, fontSize: typeScale.footnote },
  errorText: { color: colors.errorText, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
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
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  actionPillCta: { backgroundColor: colors.cta, borderColor: colors.cta },
  actionPillText: { color: colors.textPrimary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  actionPillTextCta: { color: colors.ctaText },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.42 },
});
