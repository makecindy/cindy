/**
 * 待发送消息气泡(渲染在消息流里,不再是列表 footer)。
 *
 * 形态与已发送用户气泡同款(右对齐、surfaceElevated + border),从第一帧起一直是实色:内容已经
 * 确定,网络往返、排队、等电脑都不是把它变灰的理由;回流后同一个列表位置换成正式消息,外观不变。
 * 状态只放两处(设计稿 Designs/cindy/send-bubble r1 · B):气泡左侧图标,以及气泡下方那一行——
 * 送达后正式消息的「复制 / …」占的就是这一行,所以前后行高不变。本机刚发出的条目图标延后出现,
 * 多数发送在延迟内落定,不闪转圈。左侧图标语义:
 *  - 转圈 = 还没有「已被收下」这个事实(enqueue 在途 / 已出队待回流 / 附件上传中);
 *  - 已确认入队:图标与「排队中」合并到下方菜单入口,左侧不重复显示;
 *  - 时钟 = 电脑离线,消息留在手机上,连上后自动发出(不算失败);
 *  - ✎ = 正在底部 composer 编辑这一条;
 *  - ⚠ = 失败,可重试 / 删除。
 * 「排入队尾」是个事实断言,未确认时画它就是谎报,所以未确认一律转圈。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { CompanionFadeIn } from '@/session/CompanionEntering';
import { LOCAL_SEND_STATUS_DELAY_MS, localSendStartedAt } from '@/session/localSendMotion';
import { Text } from '@/components/AppText';
import { NativePullDownMenu, usesNativePullDownMenu, type NativePullDownAction } from '@/platform/chrome/NativePullDownMenu';
import { AnchoredPullDownMenu } from '@/platform/chrome/AnchoredPullDownMenu';
import { buildMessageContentLayout } from '@/session/messageContentLayout';
import { summarizeMessageBubblePresentation } from '@/session/messagePresentation';
import { LONG_USER_MESSAGE_COLLAPSED_LINES, LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD, mayExceedVisualLineThreshold, resolveUserMessageCollapse } from '@/session/userMessageCollapse';
import { sentInlineTokensDisplayText } from '@/session/sentMessageAtoms';
import { SentInlineAtomBody } from '@/session/SentInlineAtomBody';
import { MessageBodyTapBoundary } from '@/session/ShareMessageCheckbox';
import { shareSelectionTapMoved, shouldCommitShareSelectionTap, type ShareSelectionTapPoint } from '@/session/shareSelectionTap';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Bot,
  ChevronDown,
  Clock,
  Ghost,
  ListEnd,
  Monitor,
  Paperclip,
  Pencil,
  RotateCcw,
  Send,
  Smartphone,
  Timer,
  Trash2,
  type LucideIcon,
} from 'lucide-react-native';
import { shouldShowSourceDevice } from '@cindy/maker-shared/message-source';
import { sourceDeviceLabel } from '@/session/messageSourceLabels';
import { useRemoteDeviceIdentity } from '@/session/remoteSessionStore';
import {
  getSentAttachmentThumbUri,
  useSentAttachmentThumbsVersion,
} from '@/session/sentAttachmentThumbStore';
import {
  isPendingSendItemInteractive,
  isPendingSendItemSelected,
  pendingSendSpins,
  type MobilePendingSendItem,
  type MobilePendingSendSourceKind,
} from '@/session/pendingSendItems';
import {
  isDesktopLocalMediaUrl,
  type ResolveRemoteMediaFn,
} from '@/session/remoteMedia';
import type { MobileOutboxThumb } from '@/session/sessionOutbox';
import type { MessagePayload } from '@/session/messagePayload';
import { pendingSendGalleryImage } from '@/session/pendingSendImages';
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  motionDuration,
  motionEasing,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from '@/theme';
import { radius, spacing, typeScale } from '@/theme/tokens';
import { useUserBubbleAppearance } from '@/theme/userBubblePreference';

/** 与已发送消息上的来源标签同一组图标(自动化 Timer / 任务 Send / Orca Bot / 插件 Ghost)。 */
function sourceIcon(kind: MobilePendingSendSourceKind): LucideIcon {
  switch (kind) {
    case 'automation': return Timer;
    case 'orca': return Bot;
    case 'plugin': return Ghost;
    default: return Send;
  }
}

export interface PendingSendBubbleActions {
  /** 展开 / 收起操作行的条目;null = 全收起。 */
  selectedClientId: string | null;
  onSelect(clientId: string | null): void;
  onRemove(clientId: string): void;
  onBeginEdit(clientId: string): void;
  onSteer(clientId: string): void;
  onMove(clientId: string, direction: 'up' | 'down'): void;
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
  failedUris: readonly string[] = [],
): string | null {
  // 「这一格现在指的是哪张图」。排队消息被编辑、同一附件下标换成另一张图时,ThumbCell 的
  // key(clientId-file-index)不变、hook 实例被复用 —— 所有缓存都必须绑定这个身份,否则旧图
  // 会一直压住新图直到整行卸载,编辑后的气泡显示的是已被移除的附件(review P1)。
  const identity = thumb.uri ?? thumb.ossRef ?? thumb.key;
  const previewRef = thumb.previewRef ?? thumb.ossRef;
  const durableUri = previewRef ? getSentAttachmentThumbUri(previewRef) : null;
  const localUri = [durableUri, thumb.uri].find((uri) => uri && !failedUris.includes(uri)) ?? null;
  const [remoteState, setRemoteState] = useState<{ uri: string; identity: string } | null>(null);
  const remoteUri = remoteState?.identity === identity && !failedUris.includes(remoteState.uri) ? remoteState.uri : null;
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
  const shown = shownRef.current?.identity === identity && !failedUris.includes(shownRef.current.uri) ? shownRef.current.uri : null;
  // 写 ref 放 layout effect(render 阶段不碰 ref:Concurrent 下被丢弃的 render 会污染它)。
  useLayoutEffect(() => {
    if (candidate && !shown) {
      shownRef.current = { uri: candidate, identity };
    }
  }, [candidate, identity, shown]);
  return shown ?? candidate;
}

function ThumbCell({
  thumb,
  slot,
  resolveRemoteMedia,
  renderImage,
  onOpenImage,
  onRetry,
}: {
  renderImage: (uri: string | null, sourceUri: string | null, onError: () => void) => ReactNode;
  thumb: MobileOutboxThumb;
  slot: number;
  onRetry?: () => void;
  resolveRemoteMedia?: ResolveRemoteMediaFn;
  onOpenImage?: (payload: MessagePayload) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [failedUris, setFailedUris] = useState<readonly string[]>([]);
  const uri = useThumbCellUri(thumb, resolveRemoteMedia, failedUris);
  const image = pendingSendGalleryImage(thumb, uri, slot);
  const canOpen = !!image && !!onOpenImage;
  return (
    <Pressable
      accessibilityLabel={image?.title}
      accessibilityRole="button"
      accessibilityState={{ disabled: !canOpen }}
      disabled={!canOpen}
      onPress={(event) => {
        event.stopPropagation();
        if (image) onOpenImage?.(image.payload);
      }}
      style={styles.thumbCell}
      testID={`pendingSend.image.${thumb.key}`}
    >
      {renderImage(uri, thumb.uri, () => {
        if (uri) setFailedUris((failed) => failed.includes(uri) ? failed : [...failed, uri]);
      })}
      {thumb.uploading ? (
        <View pointerEvents="none" style={styles.thumbUploadingOverlay}>
          <ActivityIndicator color={colors.ctaText} size="small" />
        </View>
      ) : thumb.failed ? (
        // 只有这张没传上去:原图照常显示,上面一个重传按钮;正文与其它图不受影响。
        <View pointerEvents="box-none" style={styles.thumbUploadingOverlay}>
          <Pressable
            accessibilityLabel={t('message.queue.retryImage')}
            accessibilityRole="button"
            disabled={!onRetry}
            // 32 + 两侧各 6 = 44。
            hitSlop={6}
            onPress={(event) => { event.stopPropagation(); onRetry?.(); }}
            style={({ pressed }) => [styles.thumbRetry, pressed && styles.pressed]}
            testID={`pendingSend.imageRetry.${thumb.key}`}
          >
            <RotateCcw color={colors.errorText} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          </Pressable>
        </View>
      ) : null}
    </Pressable>
  );
}

function AttachmentThumbStrip({
  thumbs,
  resolveRemoteMedia,
  renderImage,
  gap,
  onOpenImage,
  onRetry,
}: {
  renderImage: (uri: string | null, sourceUri: string | null, onError: () => void) => ReactNode;
  gap: number;
  onRetry?: () => void;
  thumbs: readonly MobileOutboxThumb[];
  resolveRemoteMedia?: ResolveRemoteMediaFn;
  onOpenImage?: (payload: MessagePayload) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  useSentAttachmentThumbsVersion();
  if (thumbs.length === 0) return null;
  return (
    <View style={[styles.thumbStrip, { gap }]} testID="pendingSend.thumbStrip">
      {thumbs.map((thumb, slot) => (
        <ThumbCell renderImage={renderImage} key={thumb.key} resolveRemoteMedia={resolveRemoteMedia}
          thumb={thumb} slot={slot} onOpenImage={onOpenImage} onRetry={onRetry} />
      ))}
    </View>
  );
}

/**
 * 本机刚发出的条目延后 LOCAL_SEND_STATUS_DELAY_MS 才显示状态:false = 还在延迟内,
 * 'revealed' = 延迟后才出现(淡入),true = 一开始就该显示(别处来的条目 / 早已过了延迟)。
 */
function useLocalSendStatusShown(key: string): boolean | 'revealed' {
  const sentAt = localSendStartedAt(key);
  const remaining = sentAt === null ? 0 : sentAt + LOCAL_SEND_STATUS_DELAY_MS - Date.now();
  const waiting = remaining > 0;
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!waiting || sentAt === null) return undefined;
    const timer = setTimeout(() => setRevealedKey(key), Math.max(0, sentAt + LOCAL_SEND_STATUS_DELAY_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [key, sentAt, waiting]);
  if (revealedKey === key) return 'revealed';
  return !waiting;
}

/** 进出「正在下方输入框编辑」时气泡透明度渐变,系统减弱动效时直接切换。 */
function useAnimatedOpacity(target: number): Animated.Value {
  const reduceMotion = useReduceMotionEnabled();
  const value = useRef(new Animated.Value(target)).current;
  useEffect(() => {
    if (reduceMotion !== false) {
      value.setValue(target);
      return undefined;
    }
    const timing = Animated.timing(value, {
      toValue: target, duration: motionDuration.fast, easing: Easing.bezier(...motionEasing.out), useNativeDriver: true,
    });
    timing.start();
    return () => timing.stop();
  }, [reduceMotion, target, value]);
  return value;
}

export function PendingSendBubble({
  item,
  actions,
  resolveRemoteMedia,
  renderImage,
  renderText,
  renderFile,
  renderReplyQuote,
  screenWidth,
  viewerDeviceId,
  onOpenImage,
}: {
  /** 当前查看设备:排队消息就是本机发的时不显示设备标签(与已发送消息同一规则)。 */
  viewerDeviceId?: string | null;
  renderImage: (uri: string | null, sourceUri: string | null, onError: () => void) => ReactNode;
  renderText: (text: string, index: number) => ReactNode;
  renderFile: (name: string, index: number) => ReactNode;
  /** 伙伴私聊的引用回复块;普通任务不传。 */
  renderReplyQuote?: (quote: NonNullable<MobilePendingSendItem['replyQuote']>) => ReactNode;
  screenWidth?: number;
  item: MobilePendingSendItem;
  actions: PendingSendBubbleActions;
  /** 远端媒体取件(粘贴时已上传到媒体总仓的图靠它取缩略图)。 */
  resolveRemoteMedia?: ResolveRemoteMediaFn;
  onOpenImage?: (payload: MessagePayload) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  // 待发送的一定是自己的消息;与落定后的正式气泡同色,避免发出瞬间换色。
  const { colors: userBubbleColors } = useUserBubbleAppearance();
  const spinning = pendingSendSpins(item.phase);
  const editing = item.phase === 'editing';
  const failed = item.phase === 'failed';
  // Local outbox rows have not reached the desktop queue yet, but users must
  // still be able to cancel them while upload/enqueue is in flight. Settling
  // rows deliberately remain non-interactive: they have already left the
  // queue and use the existing recovery path instead.
  const interactive = isPendingSendItemInteractive(item);
  const outbox = interactive && item.actions === null;
  const selected = isPendingSendItemSelected(item, actions.selectedClientId);
  const bubbleLabel = item.text || t('message.queue.attachmentMessage');
  const uploadsPending = item.phase === 'uploading';
  const statusShown = useLocalSendStatusShown(item.key);
  const waiting = item.phase === 'waiting';
  const queued = item.phase === 'queued' && !!item.actions;
  const failedImages = item.thumbs.filter((thumb) => thumb.failed).length;
  // 只有「正在下方输入框编辑」时淡化:那一刻气泡确实在被改写。
  const contentOpacity = useAnimatedOpacity(editing ? 0.38 : 1);
  const layout = buildMessageContentLayout({ screenWidth });
  const rendersSentInlineBody = item.sentInlineTokens.some((token) => token.kind !== 'text');
  const displayBody = rendersSentInlineBody ? sentInlineTokensDisplayText(item.sentInlineTokens) : item.text;
  const density = summarizeMessageBubblePresentation({ kind: 'user', body: displayBody, attachmentCount: item.attachmentCount }).density;
  const [measuredBody, setMeasuredBody] = useState<{ body: string; lines: number } | null>(null);
  const [expandedBody, setExpandedBody] = useState<string | null>(null);
  const measureBody = mayExceedVisualLineThreshold(displayBody);
  const collapseResolved = measureBody && resolveUserMessageCollapse(
    displayBody, measuredBody?.body === displayBody ? measuredBody.lines : null,
    LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  );
  const [collapseLatchBody, setCollapseLatchBody] = useState<string | null>(null);
  const collapseLatched = collapseLatchBody === displayBody;
  useEffect(() => {
    if (collapseResolved && !collapseLatched) setCollapseLatchBody(displayBody);
  }, [collapseResolved, collapseLatched, displayBody]);
  const shouldCollapse = (measureBody && collapseLatched) || collapseResolved;
  const expanded = expandedBody === displayBody;
  const collapsedLines = shouldCollapse && !expanded ? LONG_USER_MESSAGE_COLLAPSED_LINES : undefined;
  const hasBody = !!displayBody;
  const hasAttachments = item.thumbs.length > 0 || !!item.fileNames?.length;
  const [badgeAnchor, setBadgeAnchor] = useState<{ clientId: string; left: number } | null>(null);
  const bubbleTouchOriginRef = useRef<{ start: ShareSelectionTapPoint; startedAt: number } | null>(null);
  const pendingCommitFrameRef = useRef<number | null>(null);
  const cancelBubbleTouch = useCallback(() => {
    bubbleTouchOriginRef.current = null;
    if (pendingCommitFrameRef.current !== null) cancelAnimationFrame(pendingCommitFrameRef.current);
    pendingCommitFrameRef.current = null;
  }, []);
  // Invalidate pending taps before a recycled row, disabled state or selection can take over.
  useLayoutEffect(() => cancelBubbleTouch, [cancelBubbleTouch, item.clientId, interactive, selected]);
  const handleBubbleTouchStart = (event: GestureResponderEvent) => {
    cancelBubbleTouch();
    if (event.nativeEvent.touches.length !== 1) return;
    bubbleTouchOriginRef.current = { start: event.nativeEvent, startedAt: Date.now() };
  };
  const handleBubbleTouchMove = (event: GestureResponderEvent) => {
    const origin = bubbleTouchOriginRef.current;
    if (!origin) return;
    if (shareSelectionTapMoved(origin.start, event.nativeEvent)) cancelBubbleTouch();
  };
  const handleBubbleTouchEnd = (event: GestureResponderEvent) => {
    const origin = bubbleTouchOriginRef.current;
    bubbleTouchOriginRef.current = null;
    if (origin && event.nativeEvent.touches.length === 0 && shouldCommitShareSelectionTap({
      durationMs: Date.now() - origin.startedAt,
      moved: shareSelectionTapMoved(origin.start, event.nativeEvent),
    })) {
      // Match share rows: child link onPress gets a turn to consume the gesture.
      pendingCommitFrameRef.current = requestAnimationFrame(() => {
        pendingCommitFrameRef.current = null;
        actions.onSelect(selected ? null : item.clientId);
      });
    }
  };
  const measureBadgeAnchor = (event: LayoutChangeEvent) => {
    const left = Math.max(0, event.nativeEvent.layout.x - 28 - spacing.sm);
    setBadgeAnchor((current) => current?.clientId === item.clientId && current.left === left
      ? current : { clientId: item.clientId, left });
  };
  const badgePosition = badgeAnchor?.clientId === item.clientId
    ? { left: badgeAnchor.left } : { right: 0 };
  const statusLabel = failed
    ? t('message.queue.sendFailedMessage', { text: bubbleLabel })
    : waiting
      ? t('message.queue.waitingMessage', { text: bubbleLabel })
    : spinning
      ? t('message.queue.sendingMessage', { text: bubbleLabel })
      : item.queueIndex !== null
        ? t('message.queue.queuedMessageLabel', { index: item.queueIndex, text: bubbleLabel })
        : t('message.queue.sendingMessage', { text: bubbleLabel });
  const SourceIcon = item.source ? sourceIcon(item.source.kind) : null;
  const [sourceIdVisible, setSourceIdVisible] = useState(false);
  const [deviceIdVisible, setDeviceIdVisible] = useState(false);
  const directory = useRemoteDeviceIdentity();
  const showDevice = shouldShowSourceDevice(item.sourceDevice, viewerDeviceId);
  const deviceLabel = showDevice && item.sourceDevice ? sourceDeviceLabel(item.sourceDevice, directory) : null;
  const deviceIdText = showDevice && item.sourceDevice
    ? t('message.renderer.sourceDeviceId', { id: item.sourceDevice.deviceId })
    : null;
  const DeviceIcon = item.sourceDevice?.platform === 'mobile' ? Smartphone : Monitor;

  return (
    <View style={styles.rowWrap} testID={`pendingSend.row.${item.clientId}`}>
      {item.source && SourceIcon ? (
        // 非本人输入的排队条目:气泡上方的来源标签(对齐桌面排队面板与已发送消息的来源标签)。
        // 有来源 ID 时长按就地显示(可选中复制),读屏提示读出 ID;脱敏来源保持静态。
        <View style={styles.sourceStack}>
          <Pressable
            accessibilityHint={item.source.idText}
            accessibilityLabel={item.source.label}
            accessibilityRole="text"
            disabled={!item.source.idText}
            hitSlop={8}
            onLongPress={item.source.idText ? () => setSourceIdVisible((visible) => !visible) : undefined}
            style={styles.sourceRow}
            testID={`pendingSend.source.${item.clientId}`}
          >
            <SourceIcon color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.thin} />
            <Text numberOfLines={1} style={styles.sourceText}>{item.source.label}</Text>
          </Pressable>
          {sourceIdVisible && item.source.idText ? (
            <Text selectable style={styles.sourceText} testID={`pendingSend.sourceId.${item.clientId}`}>
              {item.source.idText}
            </Text>
          ) : null}
        </View>
      ) : null}
      {deviceLabel && deviceIdText ? (
        // 别的设备发来的本人排队消息:标出设备,长按显示设备 ID;仍可编辑 / 插话。
        <View style={styles.sourceStack}>
          <Pressable
            accessibilityHint={deviceIdText}
            accessibilityLabel={deviceLabel}
            accessibilityRole="text"
            hitSlop={8}
            onLongPress={() => setDeviceIdVisible((visible) => !visible)}
            style={styles.sourceRow}
            testID={`pendingSend.sourceDevice.${item.clientId}`}
          >
            <DeviceIcon color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.thin} />
            <Text numberOfLines={1} style={styles.sourceText}>{deviceLabel}</Text>
          </Pressable>
          {deviceIdVisible ? (
            <Text selectable style={styles.sourceText} testID={`pendingSend.sourceDeviceId.${item.clientId}`}>
              {deviceIdText}
            </Text>
          ) : null}
        </View>
      ) : null}
      <View style={styles.bubbleRow}>
        {!queued ? <Pressable
          accessibilityHint={item.hint ?? undefined}
          accessibilityLabel={item.source
            ? t('message.queue.withSource', { source: item.source.label, message: statusLabel })
            : statusLabel}
          accessibilityRole="button"
          accessibilityState={{ expanded: selected, disabled: !interactive }}
          disabled={!interactive}
          hitSlop={spacing.sm}
          onPress={() => actions.onSelect(selected ? null : item.clientId)}
          style={({ pressed }) => [styles.badge, badgePosition, pressed && styles.pressed]}
          testID={`pendingSend.badge.${item.phase}`}
        >
          {failed ? (
            <AlertCircle color={colors.statusError} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          ) : editing ? (
            <Pencil color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          ) : !statusShown ? null : (
            <CompanionFadeIn distance={0} duration={motionDuration.fast} play={statusShown === 'revealed'}>
              {spinning ? (
                <ActivityIndicator color={colors.textTertiary} size="small" />
              ) : waiting ? (
                <Clock color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
              ) : (
                // 暂停态不换 ⏸:组顶横幅已表达暂停,逐条再换会重复;行内恒用排队 icon。
                <ListEnd color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
              )}
            </CompanionFadeIn>
          )}
        </Pressable> : null}
        <Animated.View
          style={[styles.content, { opacity: contentOpacity }]}
          testID={`pendingSend.bubble.${item.clientId}`}
        >
          {hasAttachments ? (
            <View key={`attachments:${item.clientId}`} onLayout={measureBadgeAnchor} style={[styles.attachmentStrip, { gap: layout.attachmentGap }]}>
              <AttachmentThumbStrip
                gap={layout.attachmentGap}
                onOpenImage={onOpenImage}
                onRetry={failed ? () => actions.onRetryOutbox(item.clientId) : undefined}
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
          {hasBody || (item.replyQuote && renderReplyQuote) ? (
            <MessageBodyTapBoundary value={cancelBubbleTouch}>
            <View
              key={`body:${item.clientId}`}
              onLayout={hasAttachments ? undefined : measureBadgeAnchor}
              onTouchEnd={interactive ? handleBubbleTouchEnd : undefined}
              onTouchMove={interactive ? handleBubbleTouchMove : undefined}
              onTouchStart={interactive ? handleBubbleTouchStart : undefined}
              onTouchCancel={cancelBubbleTouch}
              style={[
                styles.bubble,
                density === 'compact' && styles.bubbleCompact,
                density === 'rich' && styles.bubbleRich,
                userBubbleColors && { backgroundColor: userBubbleColors.background, borderColor: userBubbleColors.border },
              ]}
              testID={`pendingSend.body.${item.clientId}`}
            >
              {item.replyQuote && renderReplyQuote ? renderReplyQuote(item.replyQuote) : null}
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
                onPress={(event) => {
                  event.stopPropagation();
                  cancelBubbleTouch();
                  setExpandedBody(expanded ? null : displayBody);
                }}
                style={styles.collapseToggleText}>
                {expanded ? t('message.renderer.collapse') : t('message.renderer.expand')}
              </Text>
            ) : null}
            </View>
            </MessageBodyTapBoundary>
          ) : null}
          {/* 图片各自带上传转圈;只有非图片附件在传时才需要这一行。 */}
          {(item.fileCount > 0 && !item.fileNames?.length) || (uploadsPending && item.thumbs.length === 0) ? (
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
        </Animated.View>
      </View>
      {/* 气泡下方这一行:送达后正式消息的「复制 / …」也占这一行,状态与操作都放这里,前后行高不变。 */}
      <View style={styles.statusRow} testID={`pendingSend.statusRow.${item.clientId}`}>
        {failed ? (
          <>
            <Text numberOfLines={1} style={styles.statusError}>
              {failedImages > 0 ? t('message.queue.imagesNotUploaded', { count: failedImages }) : t('message.queue.notSent')}
            </Text>
            <View style={styles.statusDivider} />
            <StatusAction busy={actions.busy} label={t('message.queue.retry')} primary
              onPress={() => actions.onRetryOutbox(item.clientId)} testID={`pendingSend.outboxRetry.${item.clientId}`} />
            {item.canCancel !== false ? (
              <StatusAction busy={actions.busy} label={t('message.queue.delete')}
                onPress={() => actions.onRemoveOutbox(item.clientId)} testID={`pendingSend.outboxRemove.${item.clientId}`} />
            ) : null}
          </>
        ) : waiting && statusShown ? (
          <CompanionFadeIn distance={0} duration={motionDuration.fast} play={statusShown === 'revealed'}>
          <View style={styles.statusActions}>
            <Text numberOfLines={1} style={styles.statusText}>
              {t(item.waitingFor === 'network' ? 'message.queue.waitingForNetwork' : 'message.queue.waitingForComputer')}
            </Text>
            {outbox && item.canCancel !== false ? (
              <>
                <View style={styles.statusDivider} />
                <StatusAction busy={actions.busy} label={t('message.queue.cancel')}
                  onPress={() => actions.onRemoveOutbox(item.clientId)} testID={`pendingSend.outboxRemove.${item.clientId}`} />
              </>
            ) : null}
          </View>
          </CompanionFadeIn>
        ) : item.actions && item.phase === 'queued' && statusShown ? (
          <CompanionFadeIn distance={0} duration={motionDuration.fast} play={statusShown === 'revealed'}>
            <QueuedSendMenu item={item} actions={actions} accessibilityLabel={item.source
              ? t('message.queue.withSource', { source: item.source.label, message: statusLabel })
              : statusLabel} />
          </CompanionFadeIn>
        ) : selected && outbox && item.canCancel !== false ? (
          // 还在上传 / 发出途中:轻点气泡才露出「取消」,平时这一行留空,只有左侧图标。
          <View style={styles.statusActions} testID={`pendingSend.outboxActions.${item.clientId}`}>
            <StatusAction busy={actions.busy} label={t('message.queue.cancel')}
              onPress={() => actions.onRemoveOutbox(item.clientId)} testID={`pendingSend.outboxRemove.${item.clientId}`} />
          </View>
        ) : null}
      </View>
      {/* 有具体原因的失败(比如模型不支持图片)直接写出来,用户才知道该怎么处理;图片没传上去的
          通用提示由那张图上的重传按钮表达,轻点气泡才看。 */}
      {item.errorText && (failedImages === 0 || selected) ? (
        <Text style={styles.errorReason} testID={`pendingSend.error.${item.clientId}`}>{item.errorText}</Text>
      ) : null}
      {/* 轻点气泡看排队操作为什么不可用。 */}
      {selected && item.hint ? (
        <Text style={styles.rowHint} testID={`pendingSend.hint.${item.clientId}`}>{item.hint}</Text>
      ) : null}
    </View>
  );
}

/** 排队状态与操作共用一个入口,菜单浮在消息上,不展开列表行。 */
function QueuedSendMenu({ item, actions, accessibilityLabel }: {
  item: MobilePendingSendItem;
  actions: PendingSendBubbleActions;
  accessibilityLabel: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const choices: NativePullDownAction[] = [
    { id: 'steer', title: t('message.queue.steer'), image: 'arrow.up', icon: ArrowUp },
    { id: 'edit', title: t('message.queue.edit'), image: 'pencil', icon: Pencil },
    { id: 'moveUp', title: t('message.queue.moveUp'), image: 'arrow.up', icon: ArrowUp },
    { id: 'moveDown', title: t('message.queue.moveDown'), image: 'arrow.down', icon: ArrowDown },
    { id: 'remove', title: t('message.queue.cancelSend'), image: 'trash', icon: Trash2, destructive: true },
  ].filter((choice) => {
    const availability = item.actions?.[choice.id as keyof NonNullable<MobilePendingSendItem['actions']>];
    return !actions.busy && availability && !availability.disabled;
  });
  const disabled = choices.length === 0;
  const trigger = (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={item.hint ?? undefined}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: actions.busy || undefined }}
      disabled={disabled}
      style={({ pressed }) => [styles.queueMenuTrigger, pressed && styles.pressed]}
      testID={`pendingSend.queueStatus.${item.clientId}`}
    >
      <ListEnd color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
      <Text style={styles.queueStatusText}>{t('message.queue.queued')}</Text>
      {!disabled && <ChevronDown color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.regular} />}
    </Pressable>
  );
  if (disabled) return trigger;
  const Menu = usesNativePullDownMenu() ? NativePullDownMenu : AnchoredPullDownMenu;
  return (
    <Menu actions={choices} testID={`pendingSend.queueMenu.${item.clientId}`}
      onAction={(id) => {
        if (item.phase !== 'queued' || !choices.some((choice) => choice.id === id && !choice.disabled)) return;
        if (id === 'steer') actions.onSteer(item.clientId);
        else if (id === 'edit') actions.onBeginEdit(item.clientId);
        else if (id === 'remove') actions.onRemove(item.clientId);
        else if (id === 'moveUp') actions.onMove(item.clientId, 'up');
        else if (id === 'moveDown') actions.onMove(item.clientId, 'down');
      }}>
      {trigger}
    </Menu>
  );
}

/** 状态行里的文字按钮:13/18 medium,可见高度跟着这一行,命中区用 hitSlop 补到 44。 */
function StatusAction({
  busy,
  disabled,
  disabledReason,
  label,
  onPress,
  primary,
  testID,
}: {
  busy?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  label: string;
  onPress(): void;
  primary?: boolean;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityHint={disabledReason ?? undefined}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy: busy || undefined, disabled }}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [styles.statusAction, pressed && styles.pressed]}
      testID={testID}
    >
      <Text style={[styles.statusActionText, primary && styles.statusActionTextPrimary, disabled && styles.statusActionTextDisabled]}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  rowWrap: { alignItems: 'flex-end', gap: spacing.sm, width: '100%' },
  // 来源标签:与已发送消息上方的来源标签同款(12/18 三级色)。
  sourceStack: { alignItems: 'flex-end', gap: 2, maxWidth: '86%' },
  sourceRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  sourceText: { color: colors.textTertiary, flexShrink: 1, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  bubbleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'flex-end',
    width: '100%',
  },
  badge: { alignItems: 'center', justifyContent: 'center', width: 28, minHeight: 44, position: 'absolute', top: 0, zIndex: 1 },
  // 与已发送用户气泡同款,始终实色。
  textChunk: { flexBasis: '100%', flexShrink: 1, maxWidth: '100%' },
  content: { alignItems: 'flex-end', gap: 2, width: '100%' },
  bubbleCompact: { gap: 6, paddingVertical: spacing.sm },
  bubbleRich: { gap: spacing.sm },
  bubble: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
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
  bubbleText: {
    color: colors.textPrimary,
    fontSize: typeScale.bodyLarge,
    lineHeight: lineHeight.bodyLarge,
  },
  attachmentLine: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  attachmentLineText: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
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
  thumbRetry: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  editingHint: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  // 具体失败原因:报错用黑白系 errorText(13/18),不降成三级色。
  errorReason: { color: colors.errorText, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'right' },
  rowHint: {
    color: colors.textTertiary,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
    textAlign: 'right',
  },
  // 正式用户消息的操作行高 44(触控高度)+ 2 间距 = 46。本行吃掉 rowWrap 的 8 间距、自身高 46,
  // 总高不变;按钮在行内实打实 44 高(hitSlop 越不过父级边界,不能靠它补)。
  statusRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs, height: 46, justifyContent: 'flex-end', marginTop: -spacing.sm, maxWidth: '100%' },
  // 按钮自带 44 宽的留白,彼此只留 4 的间距。
  statusActions: { alignItems: 'center', alignSelf: 'stretch', flexDirection: 'row', gap: spacing.xs },
  queueMenuTrigger: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs, minHeight: 44, minWidth: 44 },
  queueStatusText: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  // 说明 / 报错是成句的话:13/18,二级色;失败用报错色。
  statusText: { color: colors.textSecondary, flexShrink: 1, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  statusError: { color: colors.errorText, flexShrink: 1, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  statusDivider: { backgroundColor: colors.border, height: spacing.md, width: StyleSheet.hairlineWidth },
  // 命中区 44×44 是按钮自身大小;短标签(编辑 / 取消)也够,相邻按钮不重叠。
  statusAction: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 44 },
  statusActionText: { color: colors.textSecondary, fontSize: typeScale.footnote, fontWeight: fontWeight.medium, lineHeight: lineHeight.caption },
  statusActionTextPrimary: { color: colors.textPrimary },
  statusActionTextDisabled: { color: colors.textTertiary, fontWeight: fontWeight.regular },
  pressed: { opacity: 0.72 },
});
