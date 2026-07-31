import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftRight,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleStop,
  Copy,
  Ellipsis,
  ExternalLink,
  File as FileIcon,
  FileText,
  Layers,
  ListTodo,
  LoaderCircle,
  PencilLine,
  Share as ShareIcon,
  Send,
  Split,
  Sparkles,
  Timer,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react-native';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  StatusBar,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  type ViewToken,
} from 'react-native';
import { UITextView } from 'react-native-uitextview';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import { tokenizeCode, type CodeTokenKind } from '@/session/codeHighlight';
import { buildComposerTouchLayout } from '@/session/composerTouchLayout';
import { useFoldableExpandedState } from '@/session/expandedBlockMemory';
import {
  joinChatQuoteTextSegments,
  parseChatQuoteSegments,
  type ChatQuote,
} from '@cindy/maker-shared/chat-quotes';
import { QuoteCapsule } from '@/session/QuoteCapsule';
import { StreamingStatusText } from '@/session/StreamingStatusText';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration, motionEasing } from '@/theme/tokens';
import { MessageActionSheet } from '@/session/MessageActionSheet';
import { buildMobileMessageMenu, type MobileMessageMenuActionId } from '@/session/messageActionMenu';
import { InlineQuoteChip } from '@/session/InlineQuoteChip';
import { InlineReferenceChip } from '@/session/InlineReferenceChip';
import {
  composerDocumentFromSerializedMessage,
  type ComposerDocument,
} from '@/session/composerDocument';
import {
  buildVisibleSentInlineTokens,
  sentInlineTokensDisplayText,
  type SentInlineToken,
} from '@/session/sentMessageAtoms';
import {
  selectionQuoteMenuLabel,
  SelectionQuoteContext,
  handleSelectionQuoteMenuAction,
} from '@/session/selectionQuote';
import {
  MOBILE_COMPOSER_CONTROL_SIZE,
  MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT,
} from '@/session/MobileComposerInputRow';
import { MAX_FONT_SIZE_MULTIPLIER, Text } from '@/components/AppText';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type {
  NormalizedAttachment,
  NormalizedRemoteMessage,
  NormalizedToolDiff,
  NormalizedToolMedia,
} from '@/session/messageNormalize';
import {
  buildAttachmentPayload,
  buildDiffPayload,
  buildFilePayload,
  buildMediaPayload,
  buildMermaidPayload,
  buildTextPayload,
  buildToolResultPayload,
  formatDiffPayloadView,
  payloadMediaKindLabel,
  summarizeMessagePayloadBody,
  summarizeMessagePayloadPreview,
  summarizeMessagePayload,
  type FormattedDiffPayloadLine,
  type MessagePayload,
  type MessagePayloadPreview,
} from '@/session/messagePayload';
import { partitionMessageAttachments } from '@/session/messageAttachments';
import {
  AUTOMATION_USER_MESSAGE_COLLAPSED_LINES,
  AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  LONG_USER_MESSAGE_COLLAPSED_LINES,
  LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  mayExceedVisualLineThreshold,
  resolveUserMessageCollapse,
} from '@/session/userMessageCollapse';
import {
  collectMobileMessageGalleryImages,
  lightboxImagesForPayload,
  type MobileMessageGalleryImage,
} from '@/session/messageGallery';
import {
  applySentAttachmentThumbOverlay,
  useSentAttachmentThumbsVersion,
} from '@/session/sentAttachmentThumbStore';
import {
  buildMobileMessageCopyText,
  copyMessageText,
  formatMessageAbsoluteTime,
  formatMessageRelativeTime,
  formatMessageTurnCost,
  formatModelShortLabel,
  mobileMessageShowsActionBar,
  writeClipboardText,
  type MobileMessageControlActionId,
  type CopyMessageStatus,
} from '@/session/messageActions';
import {
  describeTextPreviewFailure,
  remoteFilePreviewKind,
  textPreviewStatusText,
  type TextFilePreviewState,
} from '@/session/filePreview';
import {
  groupMobileMarkdownSelectableBlocks,
  isMobileMarkdownImageDirectUrl,
  mobileMarkdownImageTitle,
  mobileMarkdownImageUrlForWorkdir,
  mobileMarkdownInlineImageSize,
  parseMobileMarkdown,
  parseMobileMarkdownInlines,
  type MobileMarkdownBlockGroup,
  type MobileMarkdownInline,
} from '@/session/messageMarkdown';
import {
  extractSessionLinkIds,
  isCindyDeepLinkUrl,
  parseProjectDeepLinkUrl,
  parseSessionDeepLinkUrl,
  projectDisplayName,
  shortSessionId,
  type SessionDeepLinkTarget,
} from '@/session/sessionLinks';
import {
  formatMobileSessionReferenceMetadata,
  mobileSessionReferenceMetadataKey,
  type MobilePersistedSessionReferenceMetadata,
} from '@/session/sessionReferences';
import {
  canOpenChatPathChip,
  chatPathLabelReadsAsFileReference,
  classifyChatPathLinkTarget,
  classifyInlineCodePathCandidate,
  resolveChatAbsPath,
  toWorkdirRel,
  type ChatPathCandidate,
} from '@/session/chatPathCandidate';
import { ChatFilePathContext, type ChatFilePathTarget } from '@/session/chatFilePathContext';
import {
  peekRemotePathVerdict,
  peekRemotePathVerdictForRender,
  remotePathVerdictKey,
  subscribeRemotePathVerdictChange,
  verifyRemotePathCached,
  type RemotePathVerdict,
} from '@/session/remotePathVerdict';
import {
  useRemoteSessionMessages,
  useRemoteSessions,
} from '@/session/remoteSessionStore';
import {
  compactSessionMessageLabel,
  mobileSessionMessageDisplayText,
} from '@/session/sessionMessageText';
import { buildMobileMarkdownTableColumnWidths } from '@/session/messageTableLayout';
import { buildPayloadHeaderLayout, buildPayloadModalSafeArea } from '@/session/payloadHeaderLayout';
import { buildPayloadBodyLayout, type PayloadBodyLayout } from '@/session/payloadBodyLayout';
import {
  buildMessageHierarchyLayout,
  type MessageHierarchyLayout,
} from '@/session/messageHierarchyLayout';
import {
  buildMessageContentLayout,
  type MessageContentLayout,
} from '@/session/messageContentLayout';
import { buildMobileReadableViewportLayout } from '@/session/responsiveViewportLayout';
import {
  formatDuration,
  type MobileAgentTaskItem,
  type MobileMessageItem,
  type MobileMessageRenderItem,
  type MobileThinkingItem,
  type MobileTodoCardItem,
  type MobileTodoItem,
  type MobileSubagentGroupItem,
  type MobileToolGroupItem,
  type MobileToolMediaItem,
  type MobileWorkChildItem,
  type MobileWorkGroupItem,
} from '@/session/messageRenderModel';
import {
  PendingSendBubble,
  type PendingSendBubbleActions,
} from '@/session/PendingSendBubble';
import { dedupeToolMediaByUrl } from '@cindy/maker-shared/message-render';
import { tokenizeThinkingText } from '@cindy/maker-shared/thinking-text';
import {
  buildAgentTaskCardModel,
  type AgentTaskCardModel,
  type AgentTaskStatus,
} from '@cindy/maker-shared/agent-task';
import {
  buildMessageActionBarPresentation,
  summarizeMessageBubblePresentation,
  summarizeTodoCardPresentation,
  summarizeToolGroupPresentation,
  summarizeToolRowPresentation,
  summarizeWorkGroupPresentation,
  todoStatusPresentation,
  type MessageActionBarItemId,
  type ToolRowPresentation,
  type ToolRowStatus,
} from '@/session/messagePresentation';
import {
  formatRemoteMediaSize,
  isDesktopLocalMediaUrl,
  isDirectPreviewableMediaUrl,
  type MobileResolvedRemoteMedia,
  type ResolveRemoteMediaFn,
} from '@/session/remoteMedia';
import {
  attachmentImageDisplaySize,
  mediaThumbnailPhase,
  shouldAutoResolveMediaThumbnail,
  type AttachmentImageIntrinsicSize,
  type MediaThumbnailResolveState,
} from '@/session/mediaThumbnail';
import { RemoteMediaPlayerWebView } from '@/session/mediaPlayerWebView';
import type {
  MobileMediaPlayerKind,
  MobileMediaPlayerStatus,
} from '@/session/mediaPlayerWebViewHtml';
import { formatMobileSystemCard } from '@/session/systemCard';
import {
  projectMobileWorkActivities,
  projectRecentMobileWorkActivities,
  type MobileProjectedThinkingActivity,
  type MobileProjectedToolActivity,
} from '@/session/workActivityProjection';
import { logUnhandledRenderItem } from '@/session/assertNever';
import type { OrcaCollabCard as OrcaCollabCardModel } from '@/session/orcaCollab';
import {
  buildMessageLoadEarlierAction,
  createMobileFollowEndPinState,
  evaluateMessageWindowUpdate,
  evaluateMobileFollowEndContentSizePin,
  mobileMessageListTopPadding,
  MOBILE_FOLLOW_END_PIN_SUPPRESS_MS,
  MOBILE_MESSAGE_LIST_BOTTOM_PADDING,
  type MessageScrollMetrics,
  mobileMessageListBottomPadding,
  previousUserMessageJumpTarget,
  resolveMobileNearBottomOnScroll,
  shouldAutoLoadEarlier,
  shouldUnpinMobileFollowOnDrag,
} from '@/session/messageScroll';
import { ImageLightbox, type ImageLightboxAnnotationConfig } from '@/session/ImageLightbox';
import {
  MermaidDiagramWebView,
  writeMermaidExportPngTemp,
  type MermaidDiagramWebViewHandle,
} from '@/session/mermaidWebView';
import { MathFormulaWebView } from '@/session/mathWebView';
import { latexToUnicodeApproximation } from '@cindy/maker-shared/math-markdown';
import type { RemoteTextFilePreviewResult } from '@/device-link/mobileMakerTransport';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { iconSize, iconStroke, monoFont, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { i18n } from '@/i18n';

const MESSAGE_CONTROL_HIT_SLOP = { bottom: 10, left: 10, right: 10, top: 10 };
// LegendList 变高 item 的初始估高(仅影响首帧布局定位,LegendList 挂载后按实测尺寸修正)。
/**
 * 冷开落底的 settle 窗口(ms):rAF 落底 + 初窗测量 + 贴底补滚在此窗口内基本结算,
 * 期间列表以 opacity 0 遮罩(规则 7 防两段式落底的可见跳动),到期揭开。
 * 取 300ms:初窗 ~15 个 render item 的测量在 2-4 帧内完成,补滚各一帧,慢设备留裕量;
 * 更长会放大「进入会话到内容可见」的感知延迟,不取。
 */
const MOBILE_INITIAL_ANCHOR_SETTLE_MS = 300;
/** Cold-open history fill is useful, but bounded so a short/duplicate host page cannot drain history forever. */
const MAX_INITIAL_HISTORY_AUTOFILL_PAGES = 3;
const MOBILE_MESSAGE_ESTIMATED_ITEM_SIZE = 140;
/** Running work groups expose only the same latest-five activity window as desktop. */
const MAX_LIVE_WORK_ACTIVITIES = 5;
// LegendList 预渲距离(px,视口外每侧):约 1 屏,挂载集小 → 滚动 mount 帧压进一帧内(见 listperf 实测)。
const MOBILE_MESSAGE_DRAW_DISTANCE = 800;
const FOLDABLE_HEADER_HIT_SLOP = { bottom: 10, left: 4, right: 4, top: 10 };
// 「跳到底部」浮标直径:比 composer 里的语音按钮(28)大一档但不压过它,Telegram 同款层级感。
const SCROLL_TO_BOTTOM_FAB_SIZE = 36;
const stylesStatic = StyleSheet.create({
  compactActivityIndicator: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  workActivityIconSlot: {
    alignItems: 'center',
    height: lineHeight.listBody,
    justifyContent: 'center',
    width: iconSize.md,
  },
});

/**
 * 消息正文可选中文本块的双端实现:
 * - iOS:RN 官方 Text 底层是 UILabel,selectable 只有「长按拷贝整块」、没有系统选择手柄
 *   (部分选择做不到,facebook/react-native#13938)。换用 react-native-uitextview
 *   (Bluesky 开源,真 UITextView):长按出系统手柄、支持块内部分选择,嵌套 span 样式与 onPress 保留。
 * - Android:RN Text selectable 本身就有系统选择手柄,维持 AppText(带全局字体缩放限幅)。
 * selectionColor 只在 RN Text 路径生效(UITextView 原生 spec 无此 prop,剥掉避免 Fabric 告警)。
 */
type MarkdownSelectableTextProps = ComponentProps<typeof Text> & {
  /**
   * iOS 是否使用可部分选中的 UITextView。超长展开正文禁用它并回退 RN Text:
   * UITextView 在折叠→展开时骤增为超高复用视图会偶发只留下巨高空白容器。
   */
  allowIosUITextView?: boolean;
};

function MarkdownSelectableText({
  allowIosUITextView = true,
  selectable,
  selectionColor,
  ...rest
}: MarkdownSelectableTextProps) {
  // chat-text-quote:宿主(MessageRenderer)启用采集时,给 iOS UITextView 传
  // menuActionLabel(系统选择菜单里插入「添加到对话」项,iOS 16+)并挂
  // onTextLayout(缓存逐行渲染文本)+ onMenuAction(菜单点按时按选区偏移切
  // 文本提交)。context 为 null(宿主未启用 / 非会话场景)时零开销走原路径。
  const quoteCtx = useContext(SelectionQuoteContext);
  const renderedLinesRef = useRef<readonly string[]>([]);
  if (selectable && allowIosUITextView && Platform.OS === 'ios') {
    if (!quoteCtx) {
      return (
        <UITextView
          maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER}
          selectable
          uiTextView
          {...rest}
        />
      );
    }
    return (
      <UITextView
        maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER}
        selectable
        uiTextView
        {...rest}
        onTextLayout={(e) => {
          // uitextview 自定义 spec 的 lines 是 string[](RN 核心 Text 是对象数组),
          // 双形态防御:确保缓存的是纯字符串行。
          const rawLines = e.nativeEvent.lines as unknown as readonly (string | { text: string })[];
          renderedLinesRef.current = rawLines.map((line) => (typeof line === 'string' ? line : line.text));
          rest.onTextLayout?.(e);
        }}
        // menuActionLabel / onMenuAction 是 uitextview patch 的扩展 prop,不在
        // RN Text props 里,组件内部私有附加(经 {...rest} 透传到原生组件)。
        {...{
          menuActionLabel: selectionQuoteMenuLabel(),
          onMenuAction: (event: { nativeEvent: { target: number; start: number; end: number } }) => {
            handleSelectionQuoteMenuAction(event, renderedLinesRef.current, quoteCtx);
          },
        }}
      />
    );
  }
  return <Text selectable={selectable} selectionColor={selectionColor} {...rest} />;
}

/**
 * iOS 可选中块里的嵌套 span:必须也是 UITextView(经库内祖先上下文渲染为原生 child),
 * 混入 RN Text 会破坏原生文本树。仅由 renderInline 在「块可选中且 iOS」时使用。
 */
function MarkdownSelectableSpan(props: ComponentProps<typeof Text>) {
  return <UITextView maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER} {...props} />;
}

/** Composer-ready user message body with product quotes kept out of raw text. */
export interface MobileMessageDraft {
  document: ComposerDocument;
  text: string;
  quotes: readonly ChatQuote[];
  /** marker 不进入可见输入框；未编辑时用这份原文保证 quote / prose 顺序不变。 */
  orderedBody?: string;
}

interface MessageActions {
  /** 长按/操作条「复制消息链接」:复制该消息的会话深链(带 ?message= 锚点)。 */
  onCopyMessageLink?: (clientId: string) => void;
  /** Insert this message's anchored link as an atom in the active composer. */
  onAddMessageToComposer?: (clientId: string) => void;
  /**
   * chat-text-quote:选中消息文字 → 系统选择菜单「添加到对话」项的采集回调
   * (会话页写入 chatQuoteStore)。未传时选区采集整体关闭(context 为 null,
   * 只读宿主零开销)。当前仅 iOS 16+ 生效(Android RN Text 无系统菜单扩展点)。
   */
  onQuoteSelection?: (quote: { text: string }) => void;
  onForkMessage?: (clientId: string, draft?: MobileMessageDraft) => void;
  onDeleteMessage?: (clientId: string) => void;
  onLoadEarlier?: () => void | Promise<void>;
  onOpenForkOrigin?: () => void;
  onOpenPayload?: (payload: MessagePayload) => void;
  /** 正文里会话深链 chip(xdt-maker://session/…)点击回调,app 内跳转。 */
  onOpenSessionLink?: (url: string) => void;
  onPreviewRewind?: (clientId: string, draft: MobileMessageDraft) => void;
  /** 待发送气泡(pending_send 项)的展开态与队列操作回调。 */
  pendingSend?: PendingSendBubbleActions;
  onReadTextFilePreview?: (filePath: string) => Promise<RemoteTextFilePreviewResult>;
  onReleaseRemoteMedia?: (sourceUrl: string, media: MobileResolvedRemoteMedia) => void;
  onResolveRemoteMedia?: ResolveRemoteMediaFn;
  busyClientId?: string | null;
  canLoadEarlier?: boolean;
  loadingEarlier?: boolean;
  screenWidth?: number;
  /** 会话是否流式中:驱动工具行 running/done 状态(未 settled 且流式中才显示进行中)。 */
  isSessionStreaming?: boolean;
}

export function MessageRenderer({
  topOverlayHeight,
  focusedItemKey,
  followLatestRequestKey,
  items,
  onCopyMessageLink,
  onAddMessageToComposer,
  onForkMessage,
  onDeleteMessage,
  onLoadEarlier,
  onOpenForkOrigin,
  onOpenSessionLink,
  onPreviewRewind,
  onQuoteSelection,
  pendingSend,
  onReadTextFilePreview,
  onReleaseRemoteMedia,
  onResolveRemoteMedia,
  onShareImage,
  imageAnnotation,
  busyClientId,
  canLoadEarlier,
  emptyTestID,
  bottomOverlayHeight,
  isSessionStreaming,
  loadingEarlier,
  focusedRequestKey,
  queueFooter,
  scrollResetKey,
  syncingWhileEmpty,
  testID,
  devExposeList,
}: {
  bottomOverlayHeight?: number;
  /** 顶部 chrome(绝对定位半透明工具栏)实测高度:内容顶部按此让位,详见 mobileMessageListTopPadding。 */
  topOverlayHeight?: number;
  focusedItemKey?: string | null;
  focusedRequestKey?: number | string | null;
  followLatestRequestKey?: number | string | null;
  items: readonly MobileMessageRenderItem[];
  emptyTestID?: string;
  /** 排队消息 inline 区(InlineQueueSection),渲染在最后一条消息之后、随内容滚动。 */
  queueFooter?: ReactNode;
  scrollResetKey?: string;
  /** 空列表且本次打开的首同步未完成:渲染「正在同步」占位(延迟显形防闪)而非「暂无消息」。 */
  syncingWhileEmpty?: boolean;
  testID?: string;
  /** 全屏图片查看器的分享回调(由会话屏落地本地文件后唤起系统分享单)。 */
  onShareImage?: (
    media: Extract<MessagePayload, { kind: 'media' }>['media'],
    displayUri: string,
    mimeType?: string,
    /** 取件已知的对象字节数:分享落盘可据此跳过超预算的 LRU 写入。 */
    sizeBytes?: number,
  ) => void | Promise<void>;
  /** 全屏图片查看器的圈点标注配置(画笔 → 发送到对话;由会话屏接线附件管线)。 */
  imageAnnotation?: ImageLightboxAnnotationConfig;
  /** DEV-only:把内部列表控制器暴露给性能 harness 驱动自动滚动(临时,profiling/回归测量用)。 */
  devExposeList?: (api: {
    scrollTo: (y: number) => void;
    getMetrics: () => { contentHeight: number; offsetY: number; viewportHeight: number };
  }) => void;
} & MessageActions) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const firstUserMessageClientId = findFirstUserMessageClientId(items);
  const focusedItemKeyRef = useRef(focusedItemKey);
  focusedItemKeyRef.current = focusedItemKey;
  const listRef = useRef<LegendListRef>(null);
  const windowDimensions = useWindowDimensions();
  const viewportLayout = useMemo(() => buildMobileReadableViewportLayout({
    screenHeight: windowDimensions.height,
    screenWidth: windowDimensions.width,
  }), [windowDimensions.height, windowDimensions.width]);
  const nearBottomRef = useRef(true);
  // ── 拖动手势追踪(贴底跟随的意图解除用)──
  // 拖动期间(onScrollBeginDrag ~ onScrollEndDrag)相对起点累计上移超过死区
  // → 立即解除跟随(shouldUnpinMobileFollowOnDrag),不看近底距离阈值——
  // 距离阈值(≥228px)在流式期间与程序化贴底滚动竞态,慢速小幅上滑会被反复拽回
  // (桌面版同源 bug 的手机版变体,见 messageScroll.ts)。
  const isDraggingRef = useRef(false);
  const dragStartOffsetYRef = useRef<number | null>(null);
  // 用户是否主动拖动过(区分「冷开初始布局」与「用户上翻」):自动加载更早只在用户真拖过之后才允许,
  // 否则短会话(只加载了少量最新消息但 hasOlderMessages)冷开时会落在 onStartReachedThreshold 内、
  // 未经用户操作就自动拉历史(review P2)。切会话重置。
  const userScrollForOlderRef = useRef(false);
  // 冷开时自动补齐短初窗,最多连续拉三页；用户主动浏览后改走既有不限页的近顶预取。
  const initialHistoryAutofillRemainingRef = useRef(MAX_INITIAL_HISTORY_AUTOFILL_PAGES);
  // 上一次自动 load-earlier 触发时的首项 key:相同 = 上次尝试无进展(失败 / 拉回重复页),
  // 不再自动重试,防止对着打不出进展的 host 无限拉取。用户重新拖动 / 切会话时清除。
  const lastAutoLoadEarlierKeyRef = useRef<string | null>(null);
  // 正在读「加载更早」拉回来的历史:抑制 handleContentSize 的大块撑高贴底,否则短会话(内容仍近底)
  // load-earlier 的 prepend 撑高会被误当成底部增长 → scrollToEnd 把用户从刚加载的历史拽回最新(review P1)。
  // 用户重新拖动 / 主动跳底 / 切会话时解除。
  const readingOlderRef = useRef(false);
  // 每次补页分配 generation：旧会话 / 旧请求的异步 settle 不得清掉新请求的抑制态。
  const readingOlderRequestGenerationRef = useRef(0);
  const previousFollowLatestRequestKeyRef = useRef(followLatestRequestKey);
  const previousItemKeysRef = useRef<readonly string[]>([]);
  const scrollMetricsRef = useRef<MessageScrollMetrics>({
    contentHeight: 0,
    offsetY: 0,
    viewportHeight: 0,
  });
  // 贴底补滚护栏状态(死区 + 振荡断路器,语义见 messageScroll.ts 的护栏段注释):
  // 掐断 onContentSizeChange → scrollToEnd → 重测 的洪泛环(JS 忙死、消息区空白)。
  const followEndPinStateRef = useRef(createMobileFollowEndPinState());
  // 断路到期后的 one-shot 贴底清账 timer:断路窗内错过的最终高度可能停在半空且
  // 之后再无 contentSize 事件,到期补一次(仍在贴底跟随时)把账清平(review P1)。
  const followEndPinRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 冷开落底是否已发起(每个 scrollResetKey 一次):替代 LegendList initialScrollAtEnd
  // (弃用原因见下方 LegendList props 注释)。首批 items commit 后 rAF 命令式落底一次,
  // 目标偏差由 handleContentSize 的贴底补滚随后续测量自然校正。
  const initialAnchorDoneRef = useRef(false);
  // 落底 rAF / 揭开 timer 的句柄(生命周期 = 每个 scrollResetKey 一轮,不挂 effect
  // cleanup——原因见冷开落底 effect 的注释;清旧在落底 effect 自身开头,卸载时兜底清)。
  const initialAnchorFrameRef = useRef<number | null>(null);
  const initialRevealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // settle 遮罩:落底两段式期间列表保持 opacity 0,settle 窗口后揭开(规则 7 防跳动)。
  const [listRevealed, setListRevealed] = useState(false);
  // 会话切换(scrollResetKey)的 ref 复位必须在渲染期同步完成,不能只靠下方的 reset effect:
  // effect 在 paint 后异步执行,而重挂的新列表(key={scrollResetKey})的首批 scroll /
  // onStartReached 回调、以及先于 reset effect 定义的 eligibility effect,都可能带着上个会话的
  // 「上翻意图」与去重记录先跑——冷开短窗口会在无用户操作时误触发自动拉历史(review P2)。
  // setState 类复位(浮标/红点等)不参与该竞态,仍留在下方 effect。
  const prevScrollResetKeyRef = useRef(scrollResetKey);
  if (prevScrollResetKeyRef.current !== scrollResetKey) {
    prevScrollResetKeyRef.current = scrollResetKey;
    nearBottomRef.current = true;
    isDraggingRef.current = false;
    dragStartOffsetYRef.current = null;
    userScrollForOlderRef.current = false;
    initialHistoryAutofillRemainingRef.current = MAX_INITIAL_HISTORY_AUTOFILL_PAGES;
    lastAutoLoadEarlierKeyRef.current = null;
    readingOlderRef.current = false;
    readingOlderRequestGenerationRef.current += 1;
    previousItemKeysRef.current = [];
    scrollMetricsRef.current = { contentHeight: 0, offsetY: 0, viewportHeight: 0 };
    followEndPinStateRef.current = createMobileFollowEndPinState();
    initialAnchorDoneRef.current = false;
    // settle 遮罩复位必须与列表重挂同帧(渲染期 setState,React 官方 prop-change 模式):
    // 走 effect 会晚一帧,新列表以旧 revealed=true 裸挂一帧,未锚定内容闪现。
    setListRevealed(false);
  }
  // DEV-only:把列表控制器 + 滚动 metrics 暴露给性能 harness(临时,profiling/回归测量用)。
  useEffect(() => {
    if (!__DEV__) return;
    devExposeList?.({
      scrollTo: (y: number) => listRef.current?.scrollToOffset({ animated: false, offset: y }),
      getMetrics: () => scrollMetricsRef.current,
    });
  }, [devExposeList]);
  const lastAppliedFocusKeyRef = useRef<string | null>(null);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [isAwayFromBottom, setIsAwayFromBottom] = useState(false);
  const [firstVisibleIndex, setFirstVisibleIndex] = useState(0);
  const [payload, setPayload] = useState<MessagePayload | null>(null);
  // 关闭回调必须引用稳定:内联闭包每次渲染换新,会经 ImageLightbox 透传成
  // LightboxPage 手势 useMemo 的依赖,流式回复期间每 token 重建手势图,
  // 可能打断进行中的捏合/拖动手势(rule 7)。
  const closePayload = useCallback(() => setPayload(null), []);
  const listData = useMemo(() => [...items], [items]);
  // 遮罩重武装(review P1):真冷开(无缓存)时列表以空挂载,落底 effect 的空分支已把
  // 遮罩揭开;首批消息到达(0→N)且本会话尚未落底时,必须在**渲染期**重新武装遮罩——
  // 等 effect 就晚一帧,长历史会先裸露顶部再跳底(规则 7)。渲染期 setState 同组件
  // 官方 prop-change 模式,prev 判定保证只在转变那一次触发。
  const prevListLengthRef = useRef(listData.length);
  if (prevListLengthRef.current !== listData.length) {
    if (prevListLengthRef.current === 0 && listData.length > 0
      && !initialAnchorDoneRef.current && listRevealed) {
      setListRevealed(false);
    }
    prevListLengthRef.current = listData.length;
  }
  const itemKeys = useMemo(() => listData.map((item) => item.key), [listData]);
  const firstItemKey = itemKeys[0] ?? null;
  // 本地缩略兜底映射版本:collect 内部对 cindy-oss-attach:// 附件读全局 store 做 overlay,
  // hydrate / 新注册后 gallery 需要重建,否则点开气泡本地图时 initialUrl 对不上图集条目。
  const sentThumbsVersion = useSentAttachmentThumbsVersion();
  const chatFilePathContext = useContext(ChatFilePathContext);
  const galleryImages = useMemo(
    () => collectMobileMessageGalleryImages(
      listData,
      chatFilePathContext?.workdir,
      chatFilePathContext?.remoteHostId,
      chatFilePathContext?.sessionId,
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sentThumbsVersion 是 collect 内部读的全局 store 的失效信号
    [
      chatFilePathContext?.remoteHostId,
      chatFilePathContext?.sessionId,
      chatFilePathContext?.workdir,
      listData,
      sentThumbsVersion,
    ],
  );
  // 稳定 lightbox images 的引用:galleryImages 在流式回复期间每 token 重建
  // (item 对象全新但语义未变),若直接透传,查看器的取件 effect / FlatList /
  // LightboxPage memo 每帧全部失效。语义相同(key/url/previewable 逐项一致)
  // 时复用上一份数组,查看器打开期间对流式更新完全免疫。
  const lightboxImagesRef = useRef<readonly MobileMessageGalleryImage[] | null>(null);
  const lightboxImages = useMemo(() => {
    if (!(payload?.kind === 'media' && payload.media.kind === 'image')) return null;
    const next = lightboxImagesForPayload(galleryImages, payload);
    const prev = lightboxImagesRef.current;
    if (prev && prev.length === next.length && prev.every((p, i) => {
      const n = next[i];
      return p.key === n.key
        && p.url === n.url
        && p.payload.media.url === n.payload.media.url
        && p.payload.media.previewable === n.payload.media.previewable;
    })) {
      return prev;
    }
    lightboxImagesRef.current = next;
    return next;
  }, [galleryImages, payload]);
  const bottomPadding = mobileMessageListBottomPadding(bottomOverlayHeight);
  const topPadding = mobileMessageListTopPadding(topOverlayHeight);
  const previousUserButtonTop = topPadding > 0 ? topPadding : null;
  // 上一次 topPadding,供顶部 chrome 高度变化时补偿 scroll offset(见下方 effect)。
  const prevTopPaddingRef = useRef(topPadding);
  const floatingBottomOffset = Math.max(
    spacing.lg,
    Math.ceil(bottomOverlayHeight ?? 0) + spacing.md,
  );
  // 浮标圆心与 composer 语音按钮圆心同列(设计要求:与右下角麦克风/输入框保持关系):
  // 从 composer 的真实布局常量推导,不写魔法数;宽屏(内容居中)时补上居中列的外侧留白。
  const scrollToBottomFabRight = useMemo(() => {
    const touchLayout = buildComposerTouchLayout({ screenWidth: windowDimensions.width });
    const micCenterFromRight = touchLayout.composerPaddingHorizontal
      + MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT
      + MOBILE_COMPOSER_CONTROL_SIZE / 2;
    const wideInset = viewportLayout.wideViewport
      ? Math.max(0, (windowDimensions.width - viewportLayout.contentMaxWidth) / 2)
      : 0;
    return Math.round(wideInset + micCenterFromRight - SCROLL_TO_BOTTOM_FAB_SIZE / 2);
  }, [viewportLayout.contentMaxWidth, viewportLayout.wideViewport, windowDimensions.width]);
  const loadEarlierAction = buildMessageLoadEarlierAction({
    hasOlderMessages: canLoadEarlier === true,
    loading: loadingEarlier === true,
    visibleMessageCount: listData.length,
  });
  const actions: MessageActions & { firstUserMessageClientId?: string } = useMemo(() => ({
    onAddMessageToComposer,
    onCopyMessageLink,
    onForkMessage,
    onDeleteMessage,
    onOpenForkOrigin,
    onOpenSessionLink,
    onPreviewRewind,
    onOpenPayload: setPayload,
    onResolveRemoteMedia,
    // 待发送气泡(pending_send 项)的展开态与队列操作:漏了这一项 actions.pendingSend 就是
    // undefined,渲染分支直接 null —— 气泡整个不画,乐观显示消失。
    pendingSend,
    busyClientId,
    firstUserMessageClientId,
    isSessionStreaming,
    screenWidth: viewportLayout.contentWidth,
  }), [
    busyClientId,
    firstUserMessageClientId,
    isSessionStreaming,
    onCopyMessageLink,
    onAddMessageToComposer,
    onDeleteMessage,
    onForkMessage,
    onOpenForkOrigin,
    onOpenSessionLink,
    onPreviewRewind,
    onResolveRemoteMedia,
    pendingSend,
    viewportLayout.contentWidth,
  ]);
  // chat-text-quote:选区采集 context。仅「会话页传了采集回调 + iOS」时启用
  // (Android RN Text 无系统菜单扩展点,v1 降级只读系统复制;只读宿主不传回调,
  // context 为 null,MarkdownSelectableText 零开销)。菜单点按 → 直接提交,
  // 无浮层状态。
  const selectionQuoteEnabled = !!onQuoteSelection && Platform.OS === 'ios';
  const selectionQuoteContextValue = useMemo(
    () => (selectionQuoteEnabled && onQuoteSelection
      ? { commitQuote: (text: string) => onQuoteSelection({ text }) }
      : null),
    [onQuoteSelection, selectionQuoteEnabled],
  );
  const previousUserTarget = useMemo(
    () => (
      isAwayFromBottom
        ? previousUserMessageJumpTarget(listData, firstVisibleIndex)
        : null
    ),
    [firstVisibleIndex, isAwayFromBottom, listData],
  );
  const showJumpToLatest = isAwayFromBottom && !hasNewMessages;
  const focusRunKey = focusedItemKey
    ? `${focusedRequestKey ?? 'default'}:${focusedItemKey}`
    : null;
  const viewabilityConfigRef = useRef({ itemVisiblePercentThreshold: 5 });
  const handleViewableItemsChangedRef = useRef((info: {
    viewableItems: ViewToken<MobileMessageRenderItem>[];
  }) => {
    let nextIndex: number | null = null;
    for (const token of info.viewableItems) {
      if (typeof token.index !== 'number') continue;
      nextIndex = nextIndex === null ? token.index : Math.min(nextIndex, token.index);
    }
    if (nextIndex !== null) setFirstVisibleIndex(nextIndex);
  });

  // 贴底跟随由 handleContentSize 的手动补滚承担(nearBottomRef 是跟随意图的唯一真相);
  // 跳底直接命令式 scrollToEnd。
  const scrollToBottom = useCallback(() => {
    nearBottomRef.current = true;
    readingOlderRef.current = false;
    // 用户主动跳底是明确的重锚意图:重建补滚护栏(清掉可能仍开着的断路窗,
    // 让跳底后的贴底跟随立即恢复;振荡若还在会重新跳闸,review P2)。在飞的
    // 断路清账 timer 一并作废——本次显式跳底就是清账。
    followEndPinStateRef.current = createMobileFollowEndPinState();
    if (followEndPinRecoveryTimerRef.current) {
      clearTimeout(followEndPinRecoveryTimerRef.current);
      followEndPinRecoveryTimerRef.current = null;
    }
    setIsAwayFromBottom(false);
    setHasNewMessages(false);
    void listRef.current?.scrollToEnd({ animated: true });
  }, []);

  const jumpToPreviousUserMessage = useCallback(() => {
    if (!previousUserTarget) return;
    // 上跳导航与拖动同为真实「上翻意图」:落点若在近顶区,自动加载更早应当接得上,
    // 不要求用户额外再拖一下。与拖动开始同语义,一并作废上次无进展的去重记录,
    // 否则上次失败/重复页后跳进近顶区仍会被去重短路(review P1)。
    userScrollForOlderRef.current = true;
    lastAutoLoadEarlierKeyRef.current = null;
    nearBottomRef.current = false;
    setIsAwayFromBottom(true);
    void listRef.current?.scrollToIndex({
      animated: true,
      index: previousUserTarget.index,
      viewPosition: 0.12,
    });
  }, [previousUserTarget]);

  // 「跳到最新」请求(会话外部触发):命令式滚到底,之后由 handleContentSize 补滚维持贴底。
  useEffect(() => {
    if (previousFollowLatestRequestKeyRef.current === followLatestRequestKey) return;
    previousFollowLatestRequestKeyRef.current = followLatestRequestKey;
    if (followLatestRequestKey === null || followLatestRequestKey === undefined) return;
    nearBottomRef.current = true;
    readingOlderRef.current = false;
    // 与 scrollToBottom 同语义:显式重锚清掉补滚护栏的断路窗与在飞清账 timer。
    followEndPinStateRef.current = createMobileFollowEndPinState();
    if (followEndPinRecoveryTimerRef.current) {
      clearTimeout(followEndPinRecoveryTimerRef.current);
      followEndPinRecoveryTimerRef.current = null;
    }
    setHasNewMessages(false);
    setIsAwayFromBottom(false);
    void listRef.current?.scrollToEnd({ animated: true });
  }, [followLatestRequestKey]);

  // 自动加载更早:电平触发判定(shouldAutoLoadEarlier),在所有可能改变判定结果的时机重评估
  // (scroll 事件 / LegendList onStartReached 边沿 / eligibility 变化 effect)。
  // 为什么不能只靠 onStartReached:它是边沿信号——触发过一次后要滚离顶部超过阈值 × 1.3 再回来
  // (或阈值内 data 变化)才会再发;这里的业务 guard(没拖动过 / 正在加载 / 入口未点亮)吞掉一次
  // 边沿后,条件就绪时不会有下一个边沿,用户就停在顶部干等(短加载窗口的会话冷开即中招:
  // 列表底部已落在近顶阈值内,边沿在拖动前就被消费,之后永远滚不出复位区 → 永久哑火)。
  // nearStart / atEnd 读 LegendList getState() 的实时账:它的 scroll 记账含 prepend 锚点补偿,
  // 而 app 侧 onScroll 的原生 offsetY 在 prepend 后不再代表「距内容顶端的距离」,不可用于判顶。
  // prepend 防跳由内置 maintainVisibleContentPosition 处理,无需手动开 maintain。
  // 冷开初始布局允许有界补三页,把短初窗上方的上下文补齐；真实上翻意图则继续沿用
  // 不限页的近顶预取。两条路径都受首项进展去重保护,失败/重复页不会循环打 host。
  const requestLoadEarlier = useCallback(() => {
    if (!onLoadEarlier) return;
    const generation = readingOlderRequestGenerationRef.current + 1;
    readingOlderRequestGenerationRef.current = generation;
    readingOlderRef.current = true;
    const releaseReadingOlder = () => {
      // Promise settle 后再让 LegendList 完成一帧 prepend / mVCP 布局；成功、空页、
      // 失败都必须释放，且旧请求不能干扰切会话后或后发的新请求。
      requestAnimationFrame(() => {
        if (readingOlderRequestGenerationRef.current === generation) {
          readingOlderRef.current = false;
        }
      });
    };
    try {
      const result = onLoadEarlier();
      void Promise.resolve(result).then(releaseReadingOlder, releaseReadingOlder);
    } catch {
      releaseReadingOlder();
    }
  }, [onLoadEarlier]);

  const attemptAutoLoadEarlier = useCallback(() => {
    if (!onLoadEarlier) return;
    // 热路径前置短路(滚动事件每 16ms 评估一次,getState() 每次新建状态对象):没有用户浏览意图
    // 且冷开预算已耗尽、或当前首项已尝试过时不碰 getState。完整判定仍以
    // shouldAutoLoadEarlier 为唯一真相,这里只做它的子集提前返回。
    const userScrolledForOlder = userScrollForOlderRef.current;
    const initialAutoFillAllowed = !userScrolledForOlder
      && initialHistoryAutofillRemainingRef.current > 0;
    if (!userScrolledForOlder && !initialAutoFillAllowed) return;
    if (firstItemKey !== null && lastAutoLoadEarlierKeyRef.current === firstItemKey) return;
    const listState = listRef.current?.getState();
    if (!listState) return;
    const eligible = shouldAutoLoadEarlier({
      actionDisabled: loadEarlierAction.disabled,
      actionVisible: loadEarlierAction.visible,
      atEnd: listState.isAtEnd,
      firstItemKey,
      initialAutoFillAllowed,
      lastAttemptedFirstItemKey: lastAutoLoadEarlierKeyRef.current,
      nearStart: listState.isNearStart,
      userScrolledForOlder,
    });
    if (!eligible) return;
    lastAutoLoadEarlierKeyRef.current = firstItemKey;
    if (initialAutoFillAllowed) initialHistoryAutofillRemainingRef.current -= 1;
    requestLoadEarlier();
  }, [firstItemKey, loadEarlierAction.disabled, loadEarlierAction.visible, onLoadEarlier, requestLoadEarlier]);

  // 近底/跟随态迁移 + 「跳到底部」浮标与新消息红点;metrics 也供 DEV harness 读取。
  // 「解除跟随」的主路径是拖动意图(shouldUnpinMobileFollowOnDrag):拖动中相对起点
  // 上移超过死区立即解除(nearBottomRef 翻 false 即关掉 handleContentSize 的贴底补滚)。
  // 「恢复跟随」走 resolveMobileNearBottomOnScroll:距离 + 明确向下方向。读历史
  // (readingOlderRef)期间禁止方向性恢复——load-earlier prepend 的 mVCP 补偿会产生
  // 程序化向下增量,短会话里会被误判成「用户滑回底部」。
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const metrics = {
      contentHeight: event.nativeEvent.contentSize.height,
      offsetY: event.nativeEvent.contentOffset.y,
      viewportHeight: event.nativeEvent.layoutMeasurement.height,
    };
    const previousOffsetY = scrollMetricsRef.current.offsetY;
    scrollMetricsRef.current = metrics;
    if (
      nearBottomRef.current
      && shouldUnpinMobileFollowOnDrag({
        dragging: isDraggingRef.current,
        dragStartOffsetY: dragStartOffsetYRef.current,
        metrics,
      })
    ) {
      nearBottomRef.current = false;
      setIsAwayFromBottom(true);
    } else {
      const nearBottom = resolveMobileNearBottomOnScroll({
        wasNearBottom: nearBottomRef.current,
        metrics,
        scrollDelta: readingOlderRef.current ? 0 : metrics.offsetY - previousOffsetY,
        bottomOverlayHeight,
      });
      nearBottomRef.current = nearBottom;
      setIsAwayFromBottom(!nearBottom);
      if (nearBottom) setHasNewMessages(false);
    }
    // 拖动进近顶区时 onStartReached 边沿可能早已被消费(见 attemptAutoLoadEarlier 注释),
    // 滚动事件兜底重评估;前置短路让稳态滚动只付 1~2 次 ref 比较的成本。
    attemptAutoLoadEarlier();
  }, [attemptAutoLoadEarlier, bottomOverlayHeight]);

  // 用户开始拖动 → 标记「上翻意图」,放行自动加载更早(onScrollBeginDrag 仅用户手势触发,
  // 程序化 scrollToEnd 不会触发,故不会误置);同时记录拖动起点 offset,供
  // shouldUnpinMobileFollowOnDrag 判「相对起点累计上移」。
  const handleScrollBeginDrag = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    isDraggingRef.current = true;
    dragStartOffsetYRef.current = event.nativeEvent.contentOffset.y;
    userScrollForOlderRef.current = true;
    // 新手势 = 允许重新尝试一次自动加载(上次失败 / 无进展的去重记录随手势作废)。
    lastAutoLoadEarlierKeyRef.current = null;
    // 用户重新拖动 → 结束「读历史」态;解除态下滑回底的跟随恢复由 handleScroll
    // 的方向判定负责(nearBottomRef 翻 true 即重新打开贴底补滚)。
    readingOlderRef.current = false;
    // 翻完 refs 立即补一次电平评估:列表已顶死时(Android 无 bounce 尤甚)这次拖动不产生
    // offset 变化,不会有 onScroll / onStartReached,ref 写入也不驱动 effect——没有这一刀,
    // 「失败后停在顶部再拖一下重试」的信号会整体丢失(review P2)。
    attemptAutoLoadEarlier();
  }, [attemptAutoLoadEarlier]);

  // 拖动结束(手指离开,可能进入惯性滚动)→ 关闭拖动追踪。惯性阶段的上滑不需要再判
  // 解除:上滑手势的拖动段必然已越过死区完成解除;下滑回底的恢复由 scroll 方向判定接手。
  const handleScrollEndDrag = useCallback(() => {
    isDraggingRef.current = false;
    dragStartOffsetYRef.current = null;
  }, []);

  const handleStartReached = useCallback(() => {
    attemptAutoLoadEarlier();
  }, [attemptAutoLoadEarlier]);

  // eligibility 变化时重评估:上一页加载结束(disabled 翻 false)、入口点亮(visible 翻 true)、
  // prepend 落地(firstItemKey 变)。覆盖「用户停在顶部等待、无滚动事件」的全部哑火场景;
  // 小页(payload 重试降到 1~5 条)prepend 后仍在近顶区也由此级联补拉,直到填满预取区。
  useEffect(() => {
    attemptAutoLoadEarlier();
  }, [attemptAutoLoadEarlier]);

  const handleListLayout = useCallback((event: LayoutChangeEvent) => {
    const viewportHeight = event.nativeEvent.layout.height;
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return;
    scrollMetricsRef.current = { ...scrollMetricsRef.current, viewportHeight };
  }, []);

  // 记录 contentHeight 供近底判定 fallback + DEV harness 就绪判定;并承担**唯一的贴底跟随**:
  // 内容长高(流式增长、大块一帧撑高、冷开测量结算)时,用户本就贴底(nearBottomRef,与
  // 「跳到底部」浮标同源)则无论这次长多少都跟到底(仿 filo onContentSizeChange → scrollToEnd);
  // 上翻历史时 nearBottomRef=false,不打断。animated:false → 即时跟随、不排队动画。
  // LegendList 内置 maintainScrollAtEnd 已弃用(见 LegendList props 注释),不存在双机制叠加。
  const handleContentSize = useCallback((_width: number, height: number) => {
    const { viewportHeight } = scrollMetricsRef.current;
    scrollMetricsRef.current = { ...scrollMetricsRef.current, contentHeight: height };
    // readingOlderRef:load-earlier 的 prepend 也会撑高 contentHeight,但那是顶部增长、不该贴底(review P1)。
    if (readingOlderRef.current) return;
    if (nearBottomRef.current && viewportHeight > 0 && height > viewportHeight) {
      // 补滚护栏:死区去噪 + 振荡断路,掐断「scrollToEnd → 重测 → onContentSizeChange」
      // 洪泛环(JS 忙死、冷开消息区空白;语义与参数见 messageScroll.ts 护栏段)。
      // 单调增长(流式/冷开/回填)不限流,每次跟进;只有高度往返振荡才跳闸。
      const decision = evaluateMobileFollowEndContentSizePin(followEndPinStateRef.current, {
        now: Date.now(),
        contentHeight: height,
      });
      if (decision.trippedNow) {
        // 诊断告警(每个护栏周期一次——护栏状态随会话切换/显式跳底重建后可再报):
        // 现场无日志通道,这条 warn 是洪泛环被触发的唯一取证点。
        console.warn(
          '[message-list] contentSize follow-pin circuit tripped: '
          + `oscillating item measurements suspected (height=${Math.round(height)}, viewport=${Math.round(viewportHeight)})`,
        );
      }
      if (decision.suppressionStarted) {
        // 断路到期 + 缓冲一帧后清账:仍在贴底跟随(用户没上翻)时补一次落底,
        // 覆盖「振荡在断路窗内自然停息、最终高度停在半空」的收尾状态。
        if (followEndPinRecoveryTimerRef.current) clearTimeout(followEndPinRecoveryTimerRef.current);
        followEndPinRecoveryTimerRef.current = setTimeout(() => {
          followEndPinRecoveryTimerRef.current = null;
          if (nearBottomRef.current && !readingOlderRef.current) {
            void listRef.current?.scrollToEnd({ animated: false });
          }
        }, MOBILE_FOLLOW_END_PIN_SUPPRESS_MS + 50);
      }
      if (decision.shouldScroll) {
        void listRef.current?.scrollToEnd({ animated: false });
      }
    }
  }, []);

  // 冷开落底(替代 initialScrollAtEnd,弃用原因见 LegendList props 注释):首批 items
  // commit 后 rAF 一次命令式落底。此刻测量未完备、目标可能偏短,但 nearBottomRef 冷开
  // 为 true,后续每次 contentSize 增长都由 handleContentSize 的贴底补滚继续拉到底,
  // 最终收敛在真实底部(与迁移 LegendList 前的手搓落底同机制)。落底→补滚是两段式的,
  // 肉眼可见「跳两下」(规则 7)——沿用老方案的 settle 遮罩:列表先以 opacity 0 挂载,
  // 落底发起后等一个 settle 窗口(初窗测量与补滚基本结算)再揭开,揭开后不再隐藏。
  // ⚠️ rAF / reveal timer 挂 ref 而非 effect cleanup:本 effect 依赖 listData.length,
  // settle 窗口内消息追加会触发 cleanup——若把 timer 交给 cleanup,它会被清掉且因
  // initialAnchorDoneRef 已置位不再重设,列表永久停在 opacity 0(即新一种白屏)。
  // 两者的真实生命周期是「每个 scrollResetKey 一轮」,清理归会话切换 effect 与卸载。
  useEffect(() => {
    if (initialAnchorDoneRef.current) return;
    if (listData.length === 0) {
      // 空会话没有落底问题,直接可见(空态/同步占位不该被遮罩藏住)。
      setListRevealed(true);
      return;
    }
    initialAnchorDoneRef.current = true;
    // 上个会话可能遗留的在飞句柄在此接管清理。不能放会话切换 reset effect:它声明
    // 在本 effect 之后,同一轮 commit 里会把这里刚排好的新句柄误清。
    if (initialAnchorFrameRef.current !== null) cancelAnimationFrame(initialAnchorFrameRef.current);
    if (initialRevealTimerRef.current) clearTimeout(initialRevealTimerRef.current);
    initialAnchorFrameRef.current = requestAnimationFrame(() => {
      initialAnchorFrameRef.current = null;
      void listRef.current?.scrollToEnd({ animated: false });
    });
    initialRevealTimerRef.current = setTimeout(() => {
      initialRevealTimerRef.current = null;
      setListRevealed(true);
    }, MOBILE_INITIAL_ANCHOR_SETTLE_MS);
  }, [listData.length, scrollResetKey]);

  // 会话切换(scrollResetKey):重置浮标/近底等 UI 状态;LegendList 本体经 key={scrollResetKey}
  // 重挂并重新落底(上方冷开落底 effect;initialAnchorDoneRef 已在渲染期同步块复位)。
  // 滚动/自动加载相关的 ref 复位已在渲染期同步块完成(见 prevScrollResetKeyRef,防切会话
  // 竞态误触发自动拉历史),此处不重复。
  useEffect(() => {
    lastAppliedFocusKeyRef.current = null;
    // 上个会话遗留的断路清账 timer 作废(护栏状态本体已在渲染期同步块重建)。
    // 冷开落底的 rAF / 揭开 timer 不在这清:清旧职责在落底 effect 自身(声明序原因见彼处)。
    if (followEndPinRecoveryTimerRef.current) {
      clearTimeout(followEndPinRecoveryTimerRef.current);
      followEndPinRecoveryTimerRef.current = null;
    }
    setIsAwayFromBottom(false);
    setFirstVisibleIndex(0);
    setHasNewMessages(false);
  }, [scrollResetKey]);
  // 卸载时清掉在飞的定时器/rAF(闭包引用 listRef,卸载后触发是无害 no-op,
  // 但不留悬挂句柄)。
  useEffect(() => () => {
    if (followEndPinRecoveryTimerRef.current) clearTimeout(followEndPinRecoveryTimerRef.current);
    if (initialAnchorFrameRef.current !== null) cancelAnimationFrame(initialAnchorFrameRef.current);
    if (initialRevealTimerRef.current) clearTimeout(initialRevealTimerRef.current);
  }, []);

  // 顶部 chrome(如连接横幅)出现/消失 → topPadding 变 → contentContainerStyle.paddingTop 变 →
  // 所有 item 随之上下移。LegendList 的 maintainVisibleContentPosition 只跟 data / item 尺寸变化、
  // 不管容器 padding → 可见消息会跳 padding 差值(迁移前由手搓 scrollToOffset 补偿,一并删了;
  // 此处按差值补回,review P1)。跳过补偿的条件是「近底且非读历史」——此时贴底补滚
  // (handleContentSize)会随后续 contentSize 事件把列表重新拉到底,不重复补;读历史期间
  // 补滚被 readingOlderRef 挡住,即便被判近底(短会话)也必须在这里补,否则 topPadding
  // 变化两边都不处理、可见消息仍跳(review P1 L683)。
  useEffect(() => {
    const prev = prevTopPaddingRef.current;
    prevTopPaddingRef.current = topPadding;
    const delta = topPadding - prev;
    if (delta === 0 || (nearBottomRef.current && !readingOlderRef.current)) return;
    const { offsetY } = scrollMetricsRef.current;
    void listRef.current?.scrollToOffset({ animated: false, offset: Math.max(0, offsetY + delta) });
  }, [topPadding]);

  // 深链/搜索:滚到指定消息(LegendList scrollToIndex 自带 offscreen 处理,无需 rAF/失败兜底)。
  useEffect(() => {
    if (!focusedItemKey || !focusRunKey) {
      lastAppliedFocusKeyRef.current = null;
      return;
    }
    if (lastAppliedFocusKeyRef.current === focusRunKey) return;
    const index = listData.findIndex((item) => item.key === focusedItemKey);
    if (index < 0) return;
    lastAppliedFocusKeyRef.current = focusRunKey;
    // 深链 / 搜索定位是明确的历史浏览意图。定位后落在近顶区时继续自动补页,
    // 不要求用户再拖动一次才能看到目标上方上下文。
    userScrollForOlderRef.current = true;
    lastAutoLoadEarlierKeyRef.current = null;
    nearBottomRef.current = false;
    setIsAwayFromBottom(true);
    void listRef.current?.scrollToIndex({ animated: true, index, viewPosition: 0.45 });
  }, [focusRunKey, focusedItemKey, listData]);

  // 新消息红点:滚离底时来新消息(尾部 append)→ 提示。贴底时由 handleContentSize 补滚
  // 自动跟随、不提示。wasNearBottom 只看 nearBottomRef(跟随态唯一真相):以前 || 距离兜底
  // 会在「意图解除后仍停在近底阈值带内」时把状态判回跟随——标志说在跟、补滚却已解除,
  // 红点被吞。ref 由 handleScroll / 意图解除 / 跳转路径维护,冷开与切会话初始为 true,
  // 无需距离兜底。
  useEffect(() => {
    const decision = evaluateMessageWindowUpdate({
      previousKeys: previousItemKeysRef.current,
      nextKeys: itemKeys,
      wasNearBottom: nearBottomRef.current,
    });
    if (!focusedItemKey && decision.shouldAutoFollow && decision.autoFollowTarget === 'content-end') {
      setHasNewMessages(false);
      setIsAwayFromBottom(false);
    } else if (decision.showNewMessageIndicator) {
      setHasNewMessages(true);
    }
    previousItemKeysRef.current = itemKeys;
  }, [focusedItemKey, itemKeys]);

  const handleLoadEarlierPress = useCallback(() => {
    requestLoadEarlier();
  }, [requestLoadEarlier]);

  const renderMessageItem = useCallback(({ item }: { item: MobileMessageRenderItem }) => (
    <RenderItemView
      actions={actions}
      focused={item.key === focusedItemKey}
      item={item}
    />
  ), [actions, focusedItemKey]);

  return (
    // chat-text-quote:Provider 恒挂载(值可为 null),避免启用态翻转时整棵消息树
    // 因 Provider 增删而重挂;value 稳定(useMemo),不触发订阅方重渲。
    <SelectionQuoteContext.Provider value={selectionQuoteContextValue}>
    <View style={styles.messageFrame}>
      <LegendList
        // 每会话重挂:alignItemsAtEnd + initialScrollAtEnd 让新会话干净地重新锚到底部
        // (替代手搓的隐藏+rAF 落底 + open-settle)。
        key={scrollResetKey}
        data={listData}
        keyExtractor={(item) => item.key}
        renderItem={renderMessageItem}
        recycleItems={false}
        estimatedItemSize={MOBILE_MESSAGE_ESTIMATED_ITEM_SIZE}
        drawDistance={MOBILE_MESSAGE_DRAW_DISTANCE}
        // 冷开落底不用 initialScrollAtEnd、贴底跟随不用 maintainScrollAtEnd:两者的内部
        // 程序化滚动(冷开锚定 watchdog 的 fallback 补滚、贴底的 pending 自我续排)在特定
        // 内容形态下会与布局结算互相触发,形成无限 onScroll 风暴把 JS 线程打满——表现为
        // 冷开会话消息区空白、无 loading、返回键无响应,只能杀 App(2026-07 模拟器逐项
        // 二分实锤,3.3.2 / 3.3.3 均复现)。落底改为下方 rAF 一次命令式 scrollToEnd,
        // 后续贴底由 handleContentSize 的手动补滚(带振荡断路器)接管。
        alignItemsAtEnd
        maintainScrollAtEnd={false}
        maintainVisibleContentPosition={{ data: true, size: true }}
        contentContainerStyle={[
          styles.messages,
          { paddingBottom: bottomPadding, paddingTop: topPadding },
          viewportLayout.wideViewport && styles.messagesWide,
          viewportLayout.wideViewport && { maxWidth: viewportLayout.contentMaxWidth },
        ]}
        ListEmptyComponent={syncingWhileEmpty
          ? <SyncingMessages />
          : <EmptyMessages testID={emptyTestID} />}
        ListHeaderComponent={
          loadEarlierAction.visible ? (
            <MessageListActionButton
              accessibilityLabel={loadEarlierAction.accessibilityLabel}
              disabled={loadEarlierAction.disabled}
              onPress={handleLoadEarlierPress}
              style={styles.loadEarlierButton}
              testID="message.loadEarlierButton"
            >
              <Text style={styles.loadEarlierText}>{loadEarlierAction.label}</Text>
            </MessageListActionButton>
          ) : null
        }
        ListFooterComponent={queueFooter ? <>{queueFooter}</> : null}
        onLayout={handleListLayout}
        onContentSizeChange={handleContentSize}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onStartReached={handleStartReached}
        onStartReachedThreshold={2}
        scrollEventThrottle={16}
        ref={listRef}
        style={[styles.messageList, !listRevealed && styles.messageListSettling]}
        testID={testID ?? 'message.list'}
        viewabilityConfig={viewabilityConfigRef.current}
        onViewableItemsChanged={handleViewableItemsChangedRef.current}
      />
      {previousUserTarget && previousUserButtonTop !== null ? (
        <MessageListActionButton
          accessibilityLabel={t('message.renderer.previousQuestionJump', { preview: previousUserTarget.preview || t('message.renderer.noPreview') })}
          onPress={jumpToPreviousUserMessage}
          style={[styles.previousUserButton, { top: previousUserButtonTop }]}
          testID="message.previousUserButton"
        >
          <ArrowUp color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.regular} />
        </MessageListActionButton>
      ) : null}
      {hasNewMessages || showJumpToLatest ? (
        // 跳到底部浮标(Telegram 风):右下角半透明圆形 chevron,弱存在感;
        // 有未读新消息时不换样式,只在圆标右上角加一颗 CTA 色小圆点提示。
        <MessageListActionButton
          accessibilityLabel={hasNewMessages ? t('message.renderer.newMessagesToBottom') : t('message.renderer.jumpToBottom')}
          onPress={scrollToBottom}
          style={[styles.scrollToBottomFab, { bottom: floatingBottomOffset, right: scrollToBottomFabRight }]}
          testID={hasNewMessages ? 'message.newMessageButton' : 'message.jumpToLatestButton'}
        >
          <ChevronDown color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.regular} />
          {hasNewMessages ? <View style={styles.scrollToBottomDot} testID="message.newMessageDot" /> : null}
        </MessageListActionButton>
      ) : null}
      {payload?.kind === 'media' && payload.media.kind === 'image' && lightboxImages ? (
        // 图片走 IM 级全屏查看器(手势缩放/下滑关闭/横滑翻页);其余 payload 走通用查看器。
        <ImageLightbox
          annotation={imageAnnotation}
          images={lightboxImages}
          initialUrl={payload.media.url}
          onClose={closePayload}
          onResolveRemoteMedia={onResolveRemoteMedia}
          onShareImage={onShareImage}
        />
      ) : (
        <MessagePayloadModal
          imageAnnotation={imageAnnotation}
          onClose={closePayload}
          onReadTextFilePreview={onReadTextFilePreview}
          onReleaseRemoteMedia={onReleaseRemoteMedia}
          onResolveRemoteMedia={onResolveRemoteMedia}
          onShareImage={onShareImage}
          payload={payload}
        />
      )}
    </View>
    </SelectionQuoteContext.Provider>
  );
}

const RenderItemView = memo(function RenderItemView({
  item,
  actions,
  focused = false,
}: {
  item: MobileMessageRenderItem | MobileWorkChildItem;
  actions: MessageActions & { firstUserMessageClientId?: string };
  focused?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  // 「user 行渲染系统卡」形态(silent-stop 自动续跑 agentMeta.autoResume):渲染层
  // 降级为 kind='system' 再进 MessageBubble——presentation 的 isUserAligned 判定是
  // `align==='user' || kind==='user'`,保持 user kind 会右对齐成用户气泡并挂上
  // fork / rewind 等 user 操作行(对齐桌面 MessageStream 提前 return SystemCard 的
  // 语义,review P2)。只是渲染拷贝,normalize 层 kind='user' 的 turn 边界不受影响;
  // useMemo 保引用稳定,不破坏 MessageBubble 的 memo。
  const systemCardUserItem = useMemo(
    () => (
      item.type === 'message'
        && !item.message.orcaCard
        && item.message.kind === 'user'
        && item.message.systemCardType
        ? { ...item, message: { ...item.message, kind: 'system' as const } }
        : null
    ),
    [item],
  );
  const hookSourceUserItem = useMemo(
    () => (
      item.type === 'message' && item.message.kind === 'user' && item.message.hookSource
        ? { ...item, message: { ...item.message, kind: 'system' as const, align: 'agent' as const } }
        : null
    ),
    [item],
  );
  let node: ReactNode;
  switch (item.type) {
    case 'message':
      node = item.message.orcaCard
        ? <OrcaCollabCard card={item.message.orcaCard} screenWidth={actions.screenWidth} />
        : <MessageBubble item={hookSourceUserItem ?? systemCardUserItem ?? item} actions={actions} />;
      break;
    case 'thinking':
      node = (
        <ThinkingCard
          item={item}
          screenWidth={actions.screenWidth}
          isSessionStreaming={actions.isSessionStreaming === true}
        />
      );
      break;
    case 'tool_group':
      node = <ToolGroupCard item={item} actions={actions} />;
      break;
    case 'tool_media':
      node = <ToolMediaBlock item={item} actions={actions} />;
      break;
    case 'todo':
      node = (
        <TodoCard
          animated={item.isStreaming === true}
          item={item}
          screenWidth={actions.screenWidth}
        />
      );
      break;
    case 'agent_task':
      node = <AgentTaskCard item={item} screenWidth={actions.screenWidth} />;
      break;
    case 'work_group':
      node = <WorkGroupCard item={item} actions={actions} />;
      break;
    case 'subagent_group':
      node = <SubagentCard item={item} actions={actions} />;
      break;
    case 'fork_origin':
      node = <ForkOriginMarker onOpenForkOrigin={actions.onOpenForkOrigin} />;
      break;
    case 'pending_send':
      // 待发送气泡。actions.pendingSend 由会话页恒传;真缺失时**跳过这一项**(不渲染),
      // 而不是渲染一个点不动的气泡 —— 没有回调的气泡无法取消 / 编辑 / 重试,画出来只会
      // 让用户对着死气泡操作。渲染路径无 ErrorBoundary,这里也不抛,免得整列崩掉。
      node = actions.pendingSend
        ? (
          <PendingSendBubble
            actions={actions.pendingSend}
            item={item}
            resolveRemoteMedia={actions.onResolveRemoteMedia}
          />
        )
        : null;
      break;
    default:
      // 穷尽性保证:给 render-item union 加新变体却漏处理 → typecheck 报错(入参 never)。运行时降级为
      // log+skip(node 保持空)而非 throw —— render 路径无 ErrorBoundary,不能让单个未知 item 崩整列。
      logUnhandledRenderItem(item);
      break;
  }
  return (
    <View style={focused ? styles.focusedItem : undefined} testID={focused ? 'message.focusedItem' : undefined}>
      {node}
    </View>
  );
});

function ForkOriginMarker({ onOpenForkOrigin }: { onOpenForkOrigin?: () => void }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.forkOriginRow} testID="message.forkOrigin">
      <View style={styles.forkOriginLine} />
      <MessageListActionButton
        accessibilityLabel={t('message.renderer.openForkOrigin')}
        onPress={onOpenForkOrigin}
        style={styles.forkOriginButton}
        testID="message.forkOriginButton"
      >
        <Split color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
        <Text style={styles.forkOriginText}>{t('message.renderer.viewForkOrigin')}</Text>
      </MessageListActionButton>
      <View style={styles.forkOriginLine} />
    </View>
  );
}

function EmptyMessages({ testID }: { testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  return (
    <View style={styles.emptyCard} testID={testID ?? 'message.empty'}>
      <Text style={styles.emptyTitle}>{t('message.renderer.emptyMessages')}</Text>
    </View>
  );
}

/**
 * 首同步进行中的消息区占位(spinner + 「正在同步」)。延迟显形:同步在窗口内完成时
 * 保持空白直接上内容,避免快速路径闪一帧 spinner(视觉连续性)。
 */
const SYNCING_PLACEHOLDER_DELAY_MS = 200;

function SyncingMessages() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), SYNCING_PLACEHOLDER_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return <View style={styles.emptyCard} testID="message.syncingPending" />;
  return (
    <View style={styles.emptyCard} testID="message.syncing">
      <ActivityIndicator color={colors.textTertiary} size="small" />
      <Text style={styles.syncingTitle}>{t('message.renderer.syncing')}</Text>
    </View>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function MessageListActionButton({
  accessibilityLabel,
  children,
  disabled = false,
  onPress,
  style,
  testID,
}: {
  accessibilityLabel: string;
  children: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const interactionDisabled = disabled || !onPress;
  // mount 入场:150ms 淡入 + 0.92→1 轻缩放(浮标条件挂载,此前瞬间硬现)。
  // 单 Value 同驱 opacity/scale,native driver 一次性动画;reduce-motion
  // (含 null 未知态)从 1 起步不播。消失走 unmount 直接卸,不做 exit。
  const reduceMotionEnabled = useReduceMotionEnabled();
  const appear = useRef(new Animated.Value(reduceMotionEnabled === false ? 0 : 1)).current;
  useEffect(() => {
    if (reduceMotionEnabled !== false) {
      appear.setValue(1);
      return;
    }
    Animated.timing(appear, {
      duration: motionDuration.fast,
      easing: Easing.bezier(...motionEasing.out),
      isInteraction: false,
      toValue: 1,
      useNativeDriver: true,
    }).start();
    // 仅 mount 播一次:reduceMotionEnabled 运行中翻转不重放入场。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const appearStyle = {
    opacity: appear,
    transform: [{ scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }],
  };
  // pressed 用受控 state 而非函数型 style:createAnimatedComponent 只解析
  // 静态 props 里的 AnimatedNode,函数型 style 的返回值不会被解析,
  // Animated.Value 会以原始对象漏进底层 View 的 style(非法 prop)。
  const [pressed, setPressed] = useState(false);
  return (
    <AnimatedPressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: interactionDisabled }}
      disabled={interactionDisabled}
      onPress={interactionDisabled ? undefined : onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[
        style,
        appearStyle,
        pressed && !interactionDisabled && styles.pressed,
        interactionDisabled && styles.disabled,
      ]}
      testID={testID}
    >
      {children}
    </AnimatedPressable>
  );
}

function MessageBubble({
  item,
  actions,
}: {
  item: MobileMessageItem;
  actions: MessageActions & { firstUserMessageClientId?: string };
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<CopyMessageStatus | 'idle' | 'copying'>('idle');
  const [actionSheetOpen, setActionSheetOpen] = useState(false);
  // chat-text-quote:只解析持久化 quotesEncoded 明确标记的产品引用消息，避免
  // 把用户手写的 Markdown blockquote 误当产品引用。兼容 desktop 的交错
  // marker 块和 mobile 的前置引用。旧 markerless 消息保持 leading-only，
  // 避免把正文里的用户 Markdown blockquote 误当产品引用。手机版逐条渲染紧凑
  // quote chip，正文不泄露内部 marker/source 行；fork / rewind 直接携带完整
  // ComposerDocument，无损恢复 quote、pasted-text 与 Slash。orca 协同消息已走
  // orcaCard 分支,不进本路径。
  const quoteSegments = useMemo(
    () => (item.message.kind === 'user'
      && item.message.quotesEncoded === true
      && !item.message.systemCardType
      && item.message.body
      ? parseChatQuoteSegments(item.message.body)
      : []),
    [
      item.message.body,
      item.message.kind,
      item.message.quotesEncoded,
      item.message.systemCardType,
    ],
  );
  const messageQuotes = quoteSegments.flatMap((segment) => (
    segment.kind === 'quote' ? [segment.quote] : []
  ));
  const bubbleBody = messageQuotes.length > 0
    ? joinChatQuoteTextSegments(quoteSegments)
    : item.message.body;
  const sentInlineTokens = useMemo(
    () => (item.message.kind === 'user'
      ? buildVisibleSentInlineTokens(
          item.message.body,
          quoteSegments.length > 0
            ? quoteSegments
            : item.message.body ? [{ kind: 'text' as const, text: item.message.body }] : [],
          item.message.pastedTextRanges,
          item.message.slashCommandRanges,
        )
      : []),
    [
      item.message.body,
      item.message.kind,
      item.message.pastedTextRanges,
      item.message.slashCommandRanges,
      quoteSegments,
    ],
  );
  const hasSentInlineAtoms = sentInlineTokens.some((token) => token.kind !== 'text');
  const rendersSentInlineBody = hasSentInlineAtoms;
  const displayBubbleBody = hasSentInlineAtoms
    ? sentInlineTokensDisplayText(sentInlineTokens)
    : bubbleBody;
  const composerDraftDocument = useMemo(
    () => (item.message.kind === 'user'
      ? composerDocumentFromSerializedMessage(item.message.body, {
          quotesEncoded: item.message.quotesEncoded,
          agentReferences: item.message.agentReferences,
          pastedTextRanges: item.message.pastedTextRanges,
          slashCommandRanges: item.message.slashCommandRanges,
        })
      : null),
    [
      item.message.body,
      item.message.agentReferences,
      item.message.kind,
      item.message.pastedTextRanges,
      item.message.quotesEncoded,
      item.message.slashCommandRanges,
    ],
  );
  const presentation = summarizeMessageBubblePresentation({
    align: item.message.align,
    attachmentCount: item.message.attachments?.length ?? 0,
    body: displayBubbleBody,
    hasSystemCard: !!item.message.systemCardType,
    isStreaming: item.message.isStreaming,
    kind: item.message.kind,
    mediaCount: item.message.media?.length ?? 0,
    secondaryBody: item.message.secondaryBody,
  });
  const isUser = presentation.isUserAligned;
  const isStreamingAssistant = item.message.kind === 'assistant' && item.message.isStreaming === true;
  const clientId = messageClientId(item);
  const isFirstUserMessage = item.message.kind === 'user' && clientId === actions.firstUserMessageClientId;
  const copyText = buildMobileMessageCopyText(item.message);
  const canUseCompletedActions = !isStreamingAssistant;
  // 操作行只挂在每轮收尾正文、且该行确实是一条发言(判据见
  // mobileMessageShowsActionBar):中间句不再逐条带复制/分叉/时间,系统边界卡整行
  // 不挂。user 消息、流式「生成中」状态与正文的文本选择(canSelectVisibleText)
  // 不受影响。
  const showCompletedActionBar = mobileMessageShowsActionBar({
    hasSystemCard: !!item.message.systemCardType,
    isStreamingAssistant,
    isTurnFinalAssistant: item.message.isTurnFinalAssistant === true,
    kind: item.message.kind,
  });
  const canCopy = showCompletedActionBar && copyText.trim().length > 0;
  const canSelectVisibleText = canUseCompletedActions && copyText.trim().length > 0;
  const relativeTime = showCompletedActionBar ? formatMessageRelativeTime(item.message.createdAt) : '';
  const absoluteTime = formatMessageAbsoluteTime(item.message.createdAt);
  const turnCost = showCompletedActionBar && item.message.kind === 'assistant'
    ? formatMessageTurnCost(item.message.turnMoney)
    : '';
  const canFork = !!(
    showCompletedActionBar
    && clientId
    && actions.onForkMessage
    && (item.message.kind === 'assistant' || (item.message.kind === 'user' && !isFirstUserMessage))
  );
  const canRewind = !!(
    showCompletedActionBar
    && clientId
    && actions.onPreviewRewind
    && item.message.kind === 'user'
    && !isFirstUserMessage
  );
  const canDelete = !!(
    showCompletedActionBar
    && clientId
    && actions.onDeleteMessage
    && actions.isSessionStreaming !== true
    && (item.message.kind === 'user' || item.message.kind === 'assistant')
  );
  const canCopyLink = !!(showCompletedActionBar && clientId && actions.onCopyMessageLink);
  const canAddToChat = !!(showCompletedActionBar && clientId && actions.onAddMessageToComposer);
  const contentLayout = useMemo(() => buildMessageContentLayout({
    screenWidth: actions.screenWidth,
  }), [actions.screenWidth]);
  // 长消息自动收起(对齐桌面 UserMessage 的两档阈值):自动化任务注入的消息
  // (agentMeta.origin → automationOrigin)是模板化调度 prompt,用更紧的阈值
  // 并只留 3 行;手打消息 14 行阈值 / 收起留 10 行。判定以真实排版为准:粗筛
  // 命中的消息在气泡里挂隐藏测量 Text,onTextLayout 实测行数,回调到达前用
  // 纯文本估算兜底(避免先整段渲染再跳变收起)。
  const automationOrigin = item.message.kind === 'user' ? item.message.automationOrigin : undefined;
  const hookSource = item.message.hookSource;
  const collapseThreshold = automationOrigin
    ? AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD
    : LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD;
  const collapsedLineCount = automationOrigin
    ? AUTOMATION_USER_MESSAGE_COLLAPSED_LINES
    : LONG_USER_MESSAGE_COLLAPSED_LINES;
  // hook 来源消息在 RenderItemView 中会降级为左对齐 system kind，避免暴露
  // 本地 user 消息的 fork / rewind / delete 操作；它仍可能携带至多 20k 文本，
  // 因此必须继续复用长消息的有界测量与折叠保护。
  const collapseMeasureEnabled = (isUser || hookSource !== undefined)
    && (item.message.kind === 'user' || hookSource !== undefined)
    && !item.message.systemCardType
    && !!displayBubbleBody
    && mayExceedVisualLineThreshold(displayBubbleBody, collapseThreshold);
  // 实测行数与被测 body 绑定存储:FlatList 复用组件实例时 body 可能原地变化
  // (服务端同步补丁等),旧实测值若不随内容失效,会在下一次 onTextLayout 到达
  // 前产生"过期行数"的错误收起判定;body 不匹配时视为未测量,回落估算兜底。
  const [measuredBody, setMeasuredBody] = useState<{ body: string; lines: number } | null>(null);
  const measuredBodyLines =
    measuredBody && measuredBody.body === displayBubbleBody ? measuredBody.lines : null;
  const [longMessageExpanded, setLongMessageExpanded] = useState(false);
  // 折叠判定单向闩锁(绑定 body,FlatList 复用换消息时自动失效):测量 Text
  // 的排版宽度跟随气泡宽度,而气泡宽度又随折叠状态变化(展开态的 markdown
  // 块级内容——公式 WebView / 表格等——会把气泡撑到最大宽)。行数恰好骑在
  // 阈值边界的消息会「收起态测 N 行 → 判展开 → 展开态测 N+1 行 → 判收起」
  // 无限振荡(2026-07 数学公式块实测:14/15 行边界整屏闪动)。闩锁让「该
  // 收起」的判定只进不出:后续宽度变化跌回阈值以下不再自动展开;用户手动
  // 点「展开」走 longMessageExpanded,不受闩锁影响。
  const [collapseLatchBody, setCollapseLatchBody] = useState<string | null>(null);
  const collapseLatched = collapseLatchBody === displayBubbleBody;
  const collapseResolved = collapseMeasureEnabled
    && resolveUserMessageCollapse(displayBubbleBody, measuredBodyLines, collapseThreshold);
  useEffect(() => {
    if (collapseResolved && !collapseLatched) setCollapseLatchBody(displayBubbleBody);
  }, [collapseResolved, collapseLatched, displayBubbleBody]);
  const shouldCollapseLongMessage = (collapseMeasureEnabled && collapseLatched) || collapseResolved;
  const longMessageCollapsed = shouldCollapseLongMessage && !longMessageExpanded;
  const messageMenu = useMemo(() => buildMobileMessageMenu({
    canAddToChat,
    canCopyLink,
    canDelete,
    canFork,
    canRewind,
  }), [canAddToChat, canCopyLink, canDelete, canFork, canRewind]);
  const actionBar = useMemo(() => buildMessageActionBarPresentation({
    align: isUser ? 'user' : 'agent',
    canCopy,
    hasMoreActions: messageMenu.length > 0,
    hasTime: !!relativeTime,
    hasTurnCost: !!turnCost,
    isStreaming: isStreamingAssistant,
  }), [canCopy, isStreamingAssistant, isUser, messageMenu.length, relativeTime, turnCost]);
  const hasActions = actionBar.items.length > 0;
  const actionBusy = !!clientId && actions.busyClientId === clientId;
  const disabled = !!actions.busyClientId;

  useEffect(() => {
    if (copyState === 'idle' || copyState === 'copying') return;
    const timer = setTimeout(() => setCopyState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [copyState]);

  const copyMessage = useCallback(() => {
    if (!canCopy || copyState === 'copying') return;
    setCopyState('copying');
    void copyMessageText(copyText).then(setCopyState);
  }, [canCopy, copyState, copyText]);
  const selectControlAction = useCallback((id: MobileMessageControlActionId) => {
    if (id === 'copy') {
      copyMessage();
      return;
    }
    if (id === 'rewind' && clientId) {
      actions.onPreviewRewind?.(clientId, {
        document: composerDraftDocument ?? composerDocumentFromSerializedMessage(item.message.body),
        text: bubbleBody,
        quotes: messageQuotes,
        ...(item.message.quotesEncoded === true ? { orderedBody: item.message.body } : {}),
      });
      return;
    }
    if (id === 'fork' && clientId) {
      actions.onForkMessage?.(
        clientId,
        item.message.kind === 'user'
          ? {
              document: composerDraftDocument ?? composerDocumentFromSerializedMessage(item.message.body),
              text: bubbleBody,
              quotes: messageQuotes,
              ...(item.message.quotesEncoded === true ? { orderedBody: item.message.body } : {}),
            }
          : undefined,
      );
      return;
    }
    if (id === 'delete' && clientId) {
      actions.onDeleteMessage?.(clientId);
    }
  }, [
    actions,
    bubbleBody,
    clientId,
    composerDraftDocument,
    copyMessage,
    item.message.body,
    item.message.kind,
    item.message.quotesEncoded,
    messageQuotes,
  ]);
  const selectMenuAction = useCallback((id: MobileMessageMenuActionId) => {
    if (!clientId) return;
    if (id === 'fork') return selectControlAction('fork');
    if (id === 'rewind') return selectControlAction('rewind');
    if (id === 'delete') return selectControlAction('delete');
    if (id === 'add-to-chat') return actions.onAddMessageToComposer?.(clientId);
    actions.onCopyMessageLink?.(clientId);
  }, [actions, clientId, selectControlAction]);
  // 时间只展示发送时间；消息锚点复制移入语义明确的 More 菜单。
  const timeText = relativeTime ? (
    <Text
      accessibilityLabel={absoluteTime ? t('message.renderer.sentTime', { time: absoluteTime }) : undefined}
      key="time"
      style={styles.messageActionMeta}
      testID="message.timeText"
    >
      {relativeTime}
    </Text>
  ) : null;
  const costText = turnCost ? (
    <Text
      accessibilityLabel={item.message.turnCostIsEstimate ? t('message.renderer.turnCostEstimate', { cost: turnCost }) : t('message.renderer.turnCost', { cost: turnCost })}
      key="cost"
      style={styles.messageActionMeta}
      testID="message.turnCostText"
    >
      {turnCost}
    </Text>
  ) : null;
  const streamingStatus = isStreamingAssistant ? (
    <StreamingStatusText
      accessibilityLabel={t('message.renderer.messageGenerating')}
      style={styles.streamingStatus}
      testID="message.streamingStatus"
    >
      {t('message.renderer.generating')}
    </StreamingStatusText>
  ) : null;
  // 附件条对齐桌面版:渲染在气泡外、文字气泡上方(用户消息右对齐);
  // 纯图片消息(无正文)不再渲染空气泡背景。
  const attachmentStripNode = item.message.attachments?.length ? (
    <AttachmentStrip
      align={isUser ? 'right' : 'left'}
      attachments={item.message.attachments}
      layout={contentLayout}
      onOpen={actions.onOpenPayload}
      onResolveRemoteMedia={actions.onResolveRemoteMedia}
    />
  ) : null;
  const hasBubbleContent = !!(
    item.message.systemCardType || displayBubbleBody || item.message.secondaryBody
  );
  // 气泡是纯 View,不承接任何手势:文本选择走正文原生 Text selectable(长按文字就地选择复制),
  // 气泡上不能挂 Pressable——它会参与触摸协商,干扰正文里表格/代码块横向 ScrollView 的拖动。
  const bubble = (
    <View
      style={[
        styles.bubble,
        presentation.density === 'compact' && styles.bubbleCompact,
        presentation.density === 'rich' && styles.bubbleRich,
        isUser ? styles.userBubble : styles.agentBubble,
        hookSource && styles.hookSourceBubble,
      ]}
      testID={isUser ? 'message.userBubble' : 'message.agentBubble'}
    >
      {hookSource ? (
        <View style={styles.hookSourceHeader} testID="message.hookSource">
          <Send color={colors.textSecondary} size={iconSize.xs} strokeWidth={iconStroke.regular} />
          <Text numberOfLines={1} style={styles.hookSourceTitle}>
            {`Cindy · ${hookSource.im === 'telegram' ? 'Telegram' : 'Slack'}`}
          </Text>
          {hookSource.channelName ? (
            <Text numberOfLines={1} style={styles.hookSourceChannel}>
              {hookSource.channelName}
            </Text>
          ) : null}
        </View>
      ) : null}
      {item.message.systemCardType ? (
        <MobileSystemCard
          data={item.message.systemCardData}
          type={item.message.systemCardType}
        />
      ) : displayBubbleBody ? (
        longMessageCollapsed ? (
          // 收起态降级为纯文本(对齐桌面:被裁切的富文本节点不该保留交互),
          // 展开后恢复 MarkdownBody 的完整渲染。文本选择不因收起而丢失:
          // 走与正文/secondaryBody 同款的 MarkdownSelectableText(iOS 用
          // UITextView,原生支持 numberOfLines 截断,长按有系统选择手柄)。
          <MarkdownSelectableText
            numberOfLines={collapsedLineCount}
            selectable={canSelectVisibleText}
            style={styles.messageText}
            testID="message.collapsedBody"
          >
            {displayBubbleBody}
          </MarkdownSelectableText>
        ) : rendersSentInlineBody ? (
          <SentInlineAtomBody
            layout={contentLayout}
            markdownImageCacheKey={item.message.key}
            onOpenPayload={actions.onOpenPayload}
            onOpenSessionLink={actions.onOpenSessionLink}
            selectable={canSelectVisibleText}
            sessionReferences={item.message.sessionReferences}
            tokens={sentInlineTokens}
          />
        ) : (
          <MarkdownBody
            allowIosUITextView={!shouldCollapseLongMessage}
            markdownImageCacheKey={item.message.key}
            layout={contentLayout}
            onOpenPayload={actions.onOpenPayload}
            onOpenSessionLink={actions.onOpenSessionLink}
            sessionReferences={item.message.sessionReferences}
            selectable={canSelectVisibleText}
            streaming={isStreamingAssistant}
            text={bubbleBody}
          />
        )
      ) : null}
      {collapseMeasureEnabled ? (
        // 收起判定的测量节点:与正文同宽(left/right = 气泡 padding)同字号的
        // 纯文本,absolute 不占布局、opacity 0 不可见、pointerEvents none 不挡
        // 触摸。这里只需知道行数是否越过阈值,因此最多排到 threshold + 1 行:
        // 不让不可见节点为超长消息完整排版,避免 iOS 产生额外的超高原生
        // 文本布局,Android 也不用承担无意义的完整排版开销。展开态的巨高
        // 空白由上方 MarkdownBody 的 RN Text fallback 单独处理。
        // 无障碍两端都要屏蔽:accessibilityElementsHidden 管 iOS VoiceOver
        // (opacity 0 不会让 VoiceOver 跳过,漏了会把正文重复朗读一遍),
        // importantForAccessibility 管 Android TalkBack。
        <View
          accessibilityElementsHidden
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={styles.collapseMeasureWrap}
        >
          <Text
            numberOfLines={collapseThreshold + 1}
            onTextLayout={(e) => setMeasuredBody({
              body: displayBubbleBody,
              lines: e.nativeEvent.lines.length,
            })}
            style={styles.messageText}
          >
            {displayBubbleBody}
          </Text>
        </View>
      ) : null}
      {shouldCollapseLongMessage ? (
        // 展开/收起入口用 Text onPress(与操作条 timeText 同款):气泡内禁挂
        // Pressable(参与触摸协商,干扰正文横向 ScrollView 手势,见
        // messageSelectionDesktopFirst 契约),Text onPress 只在自身文字区响应。
        <Text
          accessibilityLabel={longMessageExpanded ? t('message.renderer.collapseMessage') : t('message.renderer.expandMessage')}
          accessibilityRole="button"
          onPress={() => setLongMessageExpanded((expanded) => !expanded)}
          style={styles.collapseToggleText}
          suppressHighlighting
          testID="message.collapseToggle"
        >
          {longMessageExpanded ? t('message.renderer.collapse') : t('message.renderer.expand')}
        </Text>
      ) : null}
      {item.message.secondaryBody ? (
        <MarkdownSelectableText selectable={canSelectVisibleText} style={styles.detailText}>
          {item.message.secondaryBody}
        </MarkdownSelectableText>
      ) : null}
    </View>
  );

  return (
    <View
      style={[
        styles.messageItem,
        isUser ? styles.userMessageItem : styles.agentMessageItem,
      ]}
    >
      {automationOrigin ? (
        // 自动化任务注入的消息:气泡上方渲来源标签(对齐桌面;手机版暂不做
        // 点击跳转自动化页,纯展示)。
        <View style={styles.automationOriginRow} testID="message.automationOrigin">
          <Timer color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.thin} />
          <Text numberOfLines={1} style={styles.automationOriginText}>
            {automationOrigin.scheduleName
              ? t('message.renderer.automationOriginNamed', { name: automationOrigin.scheduleName })
              : t('message.renderer.automationOrigin')}
          </Text>
        </View>
      ) : null}
      {attachmentStripNode}
      {hasBubbleContent || (!attachmentStripNode && messageQuotes.length === 0) ? bubble : null}
      {item.message.kind === 'assistant' && item.message.modelMismatch ? (
        // 模型降级提示(对齐桌面 AssistantMessage):所选模型本轮被上游静默替换,
        // 常显在气泡下方,icon 用 warning 橙、文字保持 tertiary 灰阶。
        <View style={styles.modelMismatchRow} testID="message.modelMismatch">
          <TriangleAlert color={colors.statusAccent} size={iconSize.xs} strokeWidth={iconStroke.thin} />
          <Text numberOfLines={2} style={styles.modelMismatchText}>
            {t('message.renderer.modelMismatch', {
              actual: formatModelShortLabel(item.message.modelMismatch.actual) || item.message.modelMismatch.actual,
              selected: formatModelShortLabel(item.message.modelMismatch.selected) || item.message.modelMismatch.selected,
            })}
          </Text>
        </View>
      ) : null}
      {hasActions ? (
        <View
          style={[
            styles.messageActionBar,
            actionBar.align === 'right' ? styles.userMessageActionBar : styles.agentMessageActionBar,
          ]}
          testID="message.actionBar"
        >
          {actionBar.items.map((id) => {
            if (id === 'streaming') return <View key="streaming">{streamingStatus}</View>;
            if (id === 'time') return timeText;
            if (id === 'cost') return costText;
            if (id === 'more') {
              return (
                <MessageMoreButton
                  buttonSize={actionBar.buttonSize}
                  disabled={disabled || actionBusy}
                  iconSize={actionBar.iconSize}
                  key="more"
                  onPress={() => setActionSheetOpen(true)}
                />
              );
            }
            if (isMessageControlActionId(id)) {
              return (
                <MessageControlButton
                  buttonSize={actionBar.buttonSize}
                  copyState={copyState}
                  disabled={disabled || actionBusy || (id === 'copy' && copyState === 'copying')}
                  id={id}
                  key={id}
                  iconSize={actionBar.iconSize}
                  onPress={() => selectControlAction(id)}
                />
              );
            }
            return null;
          })}
        </View>
      ) : null}
      <MessageActionSheet
        items={messageMenu}
        onAction={selectMenuAction}
        onClose={() => setActionSheetOpen(false)}
        visible={actionSheetOpen}
      />
    </View>
  );
}

function copyActionLabel(state: CopyMessageStatus | 'idle' | 'copying'): string {
  if (state === 'copying') return i18n.t('message.renderer.copyStateCopying');
  if (state === 'copied') return i18n.t('message.renderer.copyStateCopied');
  if (state === 'failed') return i18n.t('message.renderer.copyStateFailed');
  return i18n.t('message.renderer.copyStateCopy');
}

/**
 * 流式思考的实时时长(对齐桌面 ThinkingCard 的 500ms tick):active 时每 500ms
 * 刷新一次自 sinceIso 起的耗时;非 active 或时间戳无效时返回 null(标题回退静态文案)。
 */
function useLiveElapsedMs(active: boolean, sinceIso: string | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  if (!active || !sinceIso) return null;
  const since = Date.parse(sinceIso);
  if (!Number.isFinite(since)) return null;
  return Math.max(0, now - since);
}

/** Lightweight shared reasoning markup (`**strong**` and code spans only). */
function ThinkingInlineText({ content }: { content: string }) {
  const styles = useThemedStyles(makeStyles);
  const tokens = useMemo(() => tokenizeThinkingText(content), [content]);
  return (
    <>
      {tokens.map((token, index) => {
        if (token.kind === 'strong') {
          return <Text key={`strong-${index}`} style={styles.thinkingStrong}>{token.value}</Text>;
        }
        if (token.kind === 'code') {
          return <Text key={`code-${index}`} style={styles.thinkingCode}>{token.value}</Text>;
        }
        return token.value;
      })}
    </>
  );
}

function ThinkingCard({
  item,
  isSessionStreaming = false,
  screenWidth,
}: {
  item: MobileThinkingItem;
  isSessionStreaming?: boolean;
  screenWidth?: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const layout = useMemo(() => buildMessageHierarchyLayout({
    screenWidth,
    summaryCount: 0,
  }), [screenWidth]);
  // 运行中判定要求消息自身仍在流式(isStreaming),避免历史被中断的思考
  // (durationMs 永久缺失)在会话再次流式时误转实时计时。
  const running = !item.redacted
    && item.durationMs === undefined
    && isSessionStreaming
    && item.message.isStreaming === true;
  const elapsedMs = useLiveElapsedMs(running, item.message.createdAt);
  const title = item.redacted
    ? t('message.renderer.thinkingHidden')
    : item.durationMs !== undefined
      ? t('message.renderer.thinkingDone', { duration: formatDuration(item.durationMs) })
      : elapsedMs !== null
        ? t('message.renderer.thinkingActive', { elapsed: formatDuration(elapsedMs) })
        : t('message.renderer.thinkingProcess');
  return (
    <FoldablePanel
      blockId={item.key}
      title={title}
      layout={layout}
      variant="plain"
    >
      <Rail layout={layout}>
        <Text style={[styles.detailText, styles.italicText]}>
          {item.redacted
            ? t('message.renderer.thinkingEmpty')
            : <ThinkingInlineText content={item.message.body || t('message.renderer.thinkingNoContent')} />}
        </Text>
      </Rail>
    </FoldablePanel>
  );
}

function ToolGroupCard({
  item,
  actions,
}: {
  item: MobileToolGroupItem;
  actions: MessageActions & { firstUserMessageClientId?: string };
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const rowOptions = useMemo(
    () => ({ isSessionStreaming: actions.isSessionStreaming === true }),
    [actions.isSessionStreaming],
  );
  const presentation = summarizeToolGroupPresentation(item, rowOptions);
  const header = presentation.header;
  const toolRows = useMemo(() => item.tools.map((tool) => ({
    key: tool.key,
    presentation: summarizeToolRowPresentation(tool, rowOptions),
    tool,
  })), [item.tools, rowOptions]);
  const layout = useMemo(() => buildMessageHierarchyLayout({
    screenWidth: actions.screenWidth,
    summaryCount: header.summaryCount,
  }), [actions.screenWidth, header.summaryCount]);
  const contentLayout = useMemo(() => buildMessageContentLayout({
    screenWidth: actions.screenWidth,
  }), [actions.screenWidth]);
  return (
    <FoldablePanel
      blockId={item.key}
      chevronPosition={header.chevronPosition}
      chevronSize={header.chevronSize}
      title={header.title}
      subtitle={header.subtitle ?? undefined}
      leadingIcon={presentation.hasRunning
        ? <CompactActivityIndicator color={colors.textTertiary} size={header.iconSize} />
        : <Bot color={colors.textTertiary} size={header.iconSize} strokeWidth={iconStroke.regular} />}
      layout={layout}
      testID="message.toolGroupToggle"
      variant={header.variant}
    >
      <Rail layout={layout}>
        <View style={styles.workActivityStack}>
          {toolRows.map(({ key, presentation: row, tool }) => (
            <ToolActionRow
              key={key}
              actions={actions}
              contentLayout={contentLayout}
              row={row}
              tool={tool}
            />
          ))}
        </View>
      </Rail>
    </FoldablePanel>
  );
}

/**
 * 单条工具行(对齐桌面 AgentActionRow 的「一行摘要,点击就地展开详情」模型):
 * 折叠态只有 状态图标 + 一行摘要 + chevron;点击行头就地展开 detail / diff /
 * 媒体条 / 结果预览,再点收起。展开态走共享进程内记忆(blockId 前缀 `toolrow-`,
 * 与组级 `tools-` key 空间天然隔离)。无详情可展的行不显示 chevron、不可点击。
 */
function ToolActionRow({
  actions,
  contentLayout,
  row,
  rowKey,
  tool,
}: {
  actions: MessageActions & { firstUserMessageClientId?: string };
  contentLayout: MessageContentLayout;
  row: ToolRowPresentation;
  rowKey?: string;
  tool: NormalizedRemoteMessage;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  // 媒体不在行内渲染:tool 产出的图/视频由紧随 tool_group 的独立 ToolMediaBlock
  // 承载(对齐桌面 AgentActionRow「媒体跳出折叠卡」的语义),行内不再重复。
  const hasDetails = !!(row.detail || tool.body || tool.diff || tool.secondaryBody);
  const [expanded, toggleExpanded] = useFoldableExpandedState(`toolrow-${rowKey ?? tool.key}`, false);
  const showDetails = expanded && hasDetails;
  const chevronNode = hasDetails
    ? (expanded
      ? <ChevronDown color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
      : <ChevronRight color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />)
    : null;
  return (
    <View style={styles.toolRow} testID="message.toolRow">
      <Pressable
        accessibilityLabel={expanded ? t('message.renderer.collapseRow', { label: row.label }) : t('message.renderer.expandRow', { label: row.label })}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        disabled={!hasDetails}
        hitSlop={{ bottom: 10, top: 10 }}
        onPress={toggleExpanded}
        style={({ pressed }) => [
          styles.toolRowHeader,
          pressed && hasDetails && styles.pressed,
        ]}
        testID="message.toolRowToggle"
      >
        <ToolRowStatusIcon hasError={row.hasError} status={row.status} />
        <Text style={[styles.toolName, styles.toolNameFlex]} numberOfLines={1}>{row.label}</Text>
        {chevronNode}
      </Pressable>
      {showDetails ? (
        <View style={styles.toolRowDetails}>
          {row.detail || tool.body ? (
            <Text style={styles.toolRowDetailText}>{row.detail ?? tool.body}</Text>
          ) : null}
          {tool.diff ? <DiffPreview diff={tool.diff} layout={contentLayout} onOpen={actions.onOpenPayload} /> : null}
          {tool.secondaryBody ? <ToolResultPreview layout={contentLayout} tool={tool} onOpen={actions.onOpenPayload} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function TodoCard({
  animated,
  item,
  screenWidth,
}: {
  animated: boolean;
  item: MobileTodoCardItem;
  screenWidth?: number;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const presentation = summarizeTodoCardPresentation(item);
  const header = presentation.header;
  const layout = useMemo(() => buildMessageHierarchyLayout({
    screenWidth,
    summaryCount: header.summaryCount,
  }), [header.summaryCount, screenWidth]);
  return (
    <>
      <FoldablePanel
        title={header.title}
        subtitle={header.subtitle ?? undefined}
        chevronPosition={header.chevronPosition}
        chevronSize={header.chevronSize}
        defaultExpanded={header.defaultExpanded}
        leadingIcon={<ListTodo color={colors.textPrimary} size={header.iconSize} strokeWidth={iconStroke.regular} />}
        layout={layout}
        variant={header.variant}
      >
        <View style={[styles.stackSmall, { gap: layout.stackSmallGap }]}>
          {item.todos.map((todo, index) => (
            <TodoRow
              animated={animated}
              key={`${todo.content}:${index}`}
              layout={layout}
              todo={todo}
            />
          ))}
        </View>
      </FoldablePanel>
    </>
  );
}

function TodoRow({
  animated,
  layout,
  todo,
}: {
  animated: boolean;
  layout: MessageHierarchyLayout;
  todo: MobileTodoItem;
}) {
  const styles = useThemedStyles(makeStyles);
  const presentation = todoStatusPresentation(todo.status);
  return (
    <View
      style={[
        styles.todoRow,
        {
          gap: layout.todoRowGap,
          minHeight: layout.todoRowMinHeight,
        },
        todo.status === 'pending' && styles.todoRowPending,
      ]}
      testID="message.todoRow"
    >
      <View style={[styles.todoMark, { width: layout.todoMarkWidth }]}>
        <TodoStatusIcon animated={animated} status={presentation.status} />
      </View>
      <View style={styles.todoCopy}>
        <Text
          style={[
            styles.todoText,
            todo.status === 'pending' && styles.todoPending,
            todo.status === 'completed' && styles.todoDone,
          ]}
          numberOfLines={2}
        >
          {todo.content}
        </Text>
      </View>
    </View>
  );
}

/** 桌面同款紧凑 spinner：LoaderCircle 弧形图标、1 秒一圈。
 * 固定外框避免运行态/完成态切换时发生布局位移。 */
function CompactActivityIndicator({ color, size }: { color: string; size: number }) {
  const [reduceMotionEnabled, setReduceMotionEnabled] = useState<boolean | null>(null);
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (active) setReduceMotionEnabled(enabled);
      })
      .catch(() => {
        if (active) setReduceMotionEnabled(false);
      });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotionEnabled,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    if (reduceMotionEnabled !== false) {
      rotation.stopAnimation();
      rotation.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.timing(rotation, {
      duration: 1000,
      easing: Easing.linear,
      isInteraction: false,
      toValue: 1,
      useNativeDriver: true,
    }));
    loop.start();
    return () => {
      loop.stop();
      rotation.setValue(0);
    };
  }, [reduceMotionEnabled, rotation]);
  const rotate = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });
  return (
    <View style={[stylesStatic.compactActivityIndicator, { height: size, width: size }]}>
      <Animated.View style={reduceMotionEnabled === false ? { transform: [{ rotate }] } : undefined}>
        <LoaderCircle color={color} size={size} strokeWidth={iconStroke.regular} />
      </Animated.View>
    </View>
  );
}

/** 工具动作图标优先表达运行态；结束后再区分失败与成功。 */
function ToolRowStatusIcon({
  hasError,
  status,
}: {
  hasError: boolean;
  status: ToolRowStatus;
}) {
  const { colors } = useTheme();
  return (
    <View style={stylesStatic.workActivityIconSlot}>
      {status === 'running'
        ? <CompactActivityIndicator color={colors.textTertiary} size={iconSize.sm} />
        : hasError
          ? <CircleAlert color={colors.errorText} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          : <Check color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />}
    </View>
  );
}

function TodoStatusIcon({
  animated,
  status,
}: {
  animated: boolean;
  status: MobileTodoItem['status'];
}) {
  const { colors } = useTheme();
  if (status === 'completed') {
    return <CircleCheck color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.thin} />;
  }
  if (status === 'in_progress' && animated) {
    return <CompactActivityIndicator color={colors.textPrimary} size={iconSize.lg} />;
  }
  if (status === 'in_progress') {
    return <CircleDashed color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.thin} />;
  }
  return <Circle color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.thin} />;
}

// 在调用点求值,避免模块顶层把 i18n.t 结果冻结成常量(冻结语言)。
function agentTaskStatusLabel(status: AgentTaskStatus): string {
  switch (status) {
    case 'running':
      return i18n.t('message.renderer.statusRunning');
    case 'completed':
      return i18n.t('message.renderer.statusCompleted');
    case 'failed':
      return i18n.t('message.renderer.statusFailed');
    case 'stopped':
      return i18n.t('message.renderer.statusStopped');
  }
}

const AGENT_TASK_PROVIDER_LABEL: Record<AgentTaskCardModel['provider'], string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

function AgentTaskStatusIcon({ status, size = iconSize.md }: { status: AgentTaskStatus; size?: number }) {
  const { colors } = useTheme();
  // Black/white reverse design: status reads from the icon SHAPE, not colour (no reds).
  if (status === 'completed') return <CircleCheck color={colors.textPrimary} size={size} strokeWidth={iconStroke.regular} />;
  if (status === 'failed') return <CircleAlert color={colors.errorText} size={size} strokeWidth={iconStroke.regular} />;
  if (status === 'stopped') return <CircleStop color={colors.textTertiary} size={size} strokeWidth={iconStroke.regular} />;
  if (status === 'running') return <CompactActivityIndicator color={colors.textTertiary} size={size} />;
  return <CircleDashed color={colors.textTertiary} size={size} strokeWidth={iconStroke.regular} />;
}

function buildAgentTaskMeta(model: AgentTaskCardModel): string[] {
  const parts: string[] = [AGENT_TASK_PROVIDER_LABEL[model.provider], agentTaskStatusLabel(model.status)];
  if (typeof model.totalTokens === 'number') parts.push(`${model.totalTokens} tokens`);
  if (typeof model.toolUses === 'number') parts.push(i18n.t('message.renderer.toolUseCount', { n: model.toolUses }));
  if (typeof model.durationMs === 'number') parts.push(formatDuration(model.durationMs));
  return parts;
}

function readAgentTaskToolInput(toolCall: MobileAgentTaskItem['toolCall']): unknown {
  const content = toolCall?.source.content;
  return content && typeof content === 'object' && !Array.isArray(content)
    ? (content as Record<string, unknown>).input
    : undefined;
}

/**
 * Sub-agent task card (Claude `Task`/`Agent`, Codex `collab:*`) — mobile parity with the
 * desktop `AgentTaskCard`. Header shows the task title + a status-shaped icon; meta row carries
 * provider/status/usage; expanding reveals the prompt, summary, last tool, and output file.
 * Content comes from the shared `buildAgentTaskCardModel` (linked tool-call input + live update).
 */
function AgentTaskCard({
  item,
  screenWidth,
}: {
  item: MobileAgentTaskItem;
  screenWidth?: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const model = useMemo(
    () => buildAgentTaskCardModel({
      toolName: item.toolCall?.label,
      toolInput: readAgentTaskToolInput(item.toolCall),
      update: item.update,
      // 重连后 agent_task_update(live-only)为空,已完成子任务的唯一完成信号是配对工具结果
      // (持久化在 secondaryBody)。喂给 model 后 status 兜底为 completed、summary 显示结果(与 desktop 对齐)。
      result: item.toolCall?.secondaryBody,
    }),
    [item.toolCall, item.update],
  );
  const title = model.title ?? t('message.renderer.subagentTaskTitle');
  const subtitle = buildAgentTaskMeta(model).join(' · ');
  const layout = useMemo(
    () => buildMessageHierarchyLayout({ screenWidth, summaryCount: 0 }),
    [screenWidth],
  );
  const hasDetails = !!(model.description || model.summary || model.lastToolName || model.outputFile);
  return (
    <FoldablePanel
      blockId={item.key}
      title={title}
      subtitle={subtitle || undefined}
      chevronPosition="trailing"
      chevronSize={14}
      leadingIcon={<AgentTaskStatusIcon status={model.status} />}
      layout={layout}
      variant="card"
      testID="message.agentTaskToggle"
    >
      {hasDetails ? (
        <View style={[styles.stackSmall, { gap: layout.stackSmallGap }]}>
          {model.description ? <Text style={styles.detailText}>{model.description}</Text> : null}
          {model.summary ? <Text style={styles.detailText}>{model.summary}</Text> : null}
          {model.lastToolName ? <Text style={styles.detailText}>{t('message.renderer.recentTool', { name: model.lastToolName })}</Text> : null}
          {model.outputFile ? <Text style={styles.detailText}>{t('message.renderer.outputFile', { file: model.outputFile })}</Text> : null}
        </View>
      ) : (
        <Text style={styles.detailText}>{t('message.renderer.noMoreDetail')}</Text>
      )}
    </FoldablePanel>
  );
}

function WorkGroupCard({
  item,
  actions,
}: {
  item: MobileWorkGroupItem;
  actions: MessageActions & { firstUserMessageClientId?: string };
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const presentation = summarizeWorkGroupPresentation(item);
  const header = presentation.header;
  const isStreaming = item.isStreaming === true;
  const [expanded, toggleExpanded] = useFoldableExpandedState(item.key, false);
  const layout = useMemo(() => buildMessageHierarchyLayout({
    screenWidth: actions.screenWidth,
    summaryCount: header.summaryCount,
  }), [actions.screenWidth, header.summaryCount]);
  const contentLayout = useMemo(() => buildMessageContentLayout({
    screenWidth: actions.screenWidth,
  }), [actions.screenWidth]);
  const liveActivities = useMemo(
    () => projectRecentMobileWorkActivities(item.children, isStreaming, MAX_LIVE_WORK_ACTIVITIES),
    [isStreaming, item.children],
  );
  const activityProjection = useMemo(
    () => (expanded || !isStreaming
      ? projectMobileWorkActivities(item.children, isStreaming)
      : null),
    [expanded, isStreaming, item.children],
  );
  const isLivePreviewVisible = isStreaming && !expanded && liveActivities.length > 0;
  const startedAtIso = item.startedAtMs !== undefined
    ? new Date(item.startedAtMs).toISOString()
    : undefined;
  const elapsedMs = useLiveElapsedMs(isStreaming, startedAtIso);
  const explorationSummary = activityProjection?.isPureExploration
    ? [
        activityProjection.explorationCounts.read > 0
          ? t('message.renderer.filesRead', { n: activityProjection.explorationCounts.read })
          : null,
        activityProjection.explorationCounts.search > 0
          ? t('message.renderer.searchCount', { n: activityProjection.explorationCounts.search })
          : null,
        activityProjection.explorationCounts.list > 0
          ? t('message.renderer.listCount', { n: activityProjection.explorationCounts.list })
          : null,
      ].filter((value): value is string => value !== null).join(' · ')
    : '';
  const title = [
    presentation.title,
    explorationSummary,
  ].filter(Boolean).join(' · ');
  const onToggle = toggleExpanded;
  const livePreview = isLivePreviewVisible ? (
    <Rail layout={layout}>
      <View style={styles.workActivityStack}>
        {liveActivities.map((activity) => (
          activity.kind === 'tool'
            ? (
                <WorkToolActivityRow
                  key={activity.key}
                  actions={actions}
                  activity={activity}
                  contentLayout={contentLayout}
                />
              )
            : <WorkThinkingPreviewRow key={activity.key} activity={activity} />
        ))}
      </View>
    </Rail>
  ) : undefined;
  return (
    <FoldablePanel
      chevronPosition={header.chevronPosition}
      chevronSize={header.chevronSize}
      controlledExpanded={expanded}
      collapsedBody={livePreview}
      onControlledToggle={onToggle}
      title={title}
      subtitle={header.subtitle ?? undefined}
      trailingMeta={isStreaming && elapsedMs !== null
        ? <Text style={styles.workGroupElapsed}>{formatDuration(elapsedMs)}</Text>
        : undefined}
      leadingIcon={isStreaming
        ? <CompactActivityIndicator color={colors.textTertiary} size={header.iconSize} />
        : <Layers color={colors.textTertiary} size={header.iconSize} strokeWidth={iconStroke.regular} />}
      layout={layout}
      testID="message.workGroupToggle"
      variant={header.variant}
    >
      <Rail layout={layout}>
        <View style={styles.workGroupStack}>
          {item.children.map((child) => {
            if (child.type === 'thinking') {
              return <ExpandedWorkThinkingRow key={child.key} item={child} />;
            }
            if (child.type === 'tool_group') {
              return (
                <View key={child.key} style={styles.workActivityStack}>
                  {(activityProjection?.toolActivitiesByChildKey.get(child.key) ?? []).map((activity) => (
                    <WorkToolActivityRow
                      key={activity.key}
                      actions={actions}
                      activity={activity}
                      contentLayout={contentLayout}
                    />
                  ))}
                </View>
              );
            }
            return <RenderItemView key={child.key} item={child} actions={actions} />;
          })}
        </View>
      </Rail>
    </FoldablePanel>
  );
}

function WorkToolActivityRow({
  actions,
  activity,
  contentLayout,
}: {
  actions: MessageActions & { firstUserMessageClientId?: string };
  activity: MobileProjectedToolActivity;
  contentLayout: MessageContentLayout;
}) {
  const tool = activity.message.normalized;
  const row = useMemo(() => summarizeToolRowPresentation(tool, {
    isSessionStreaming: actions.isSessionStreaming === true,
    intentOverride: activity.intentOverride,
    statusOverride: activity.status,
  }), [actions.isSessionStreaming, activity.intentOverride, activity.status, tool]);
  return (
    <ToolActionRow
      actions={actions}
      contentLayout={contentLayout}
      row={row}
      rowKey={activity.key}
      tool={tool}
    />
  );
}

function WorkThinkingPreviewRow({
  activity,
}: {
  activity: MobileProjectedThinkingActivity;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={styles.workThinkingRow}
      testID="message.workThinkingPreview"
    >
      <View style={stylesStatic.workActivityIconSlot}>
        <Sparkles color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
      </View>
      <Text numberOfLines={1} style={[styles.workActivityText, styles.italicText, styles.workThinkingText]}>
        <ThinkingInlineText content={activity.content} />
      </Text>
    </View>
  );
}

function ExpandedWorkThinkingRow({
  item,
}: {
  item: MobileThinkingItem;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [expanded, toggleExpanded] = useFoldableExpandedState(`work-${item.key}`, false);
  const [measuredLineCount, setMeasuredLineCount] = useState(1);
  const rawContent = item.message.body.trim();
  const canExpand = rawContent.includes('\n') || measuredLineCount > 1;
  return (
    <Pressable
      accessibilityLabel={expanded ? t('message.renderer.collapseThinking') : t('message.renderer.expandThinking')}
      accessibilityRole="button"
      accessibilityState={{ expanded: canExpand ? expanded : undefined }}
      disabled={!canExpand}
      onPress={canExpand ? toggleExpanded : undefined}
      style={({ pressed }) => [
        styles.workThinkingRow,
        expanded && styles.workThinkingRowExpanded,
        pressed && canExpand && styles.pressed,
      ]}
      testID="message.workThinkingToggle"
    >
      <View style={stylesStatic.workActivityIconSlot}>
        <Sparkles color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
      </View>
      <View style={styles.workThinkingText}>
        <Text
          numberOfLines={expanded ? undefined : 1}
          style={[styles.workActivityText, styles.italicText]}
        >
          <ThinkingInlineText content={rawContent || t('message.renderer.thinkingNoContent')} />
        </Text>
        {!expanded ? (
          <View
            accessibilityElementsHidden
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
            style={styles.workThinkingMeasureWrap}
          >
            <Text
              numberOfLines={2}
              onTextLayout={(event) => setMeasuredLineCount(event.nativeEvent.lines.length)}
              style={[styles.workActivityText, styles.italicText]}
            >
              <ThinkingInlineText content={rawContent || t('message.renderer.thinkingNoContent')} />
            </Text>
          </View>
        ) : null}
      </View>
      {canExpand
        ? expanded
          ? <ChevronDown color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          : <ChevronRight color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
        : null}
    </Pressable>
  );
}

// 真·子 agent 嵌套卡片(手机端净新能力):复用 FoldablePanel(与 ToolGroupCard/WorkGroupCard 同款折叠
// 路径,滚动安全已验证)、默认折叠;展开递归渲染内层 childItems(经 RenderItemView)+ 子 agent 终稿。
// 颜色全走主题 token,不新增 hex。
function SubagentCard({
  item,
  actions,
}: {
  item: MobileSubagentGroupItem;
  actions: MessageActions & { firstUserMessageClientId?: string };
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const title = item.header.subagentType
    ? t('message.renderer.subagentTyped', { type: item.header.subagentType })
    : t('message.renderer.subagent');
  const statusText = item.status === 'running'
    ? t('message.renderer.statusRunning')
    : item.durationMs !== undefined
      ? t('message.renderer.workedDuration', { duration: formatDuration(item.durationMs) })
      : t('message.renderer.statusCompleted');
  const subtitle = [item.header.description, statusText].filter(Boolean).join(' · ');
  return (
    <CollabCardShell
      blockId={item.key}
      leadingIcon={<Bot color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />}
      title={title}
      subtitle={subtitle || undefined}
      screenWidth={actions.screenWidth}
      testID="message.subagentToggle"
    >
      {(layout) => (
        <View style={[styles.stack, { gap: layout.stackGap }]}>
          {/* 两级展开(与 WorkGroupCard 同规则):内层子卡保持各自折叠头行,按需下钻。 */}
          {item.childItems.map((child) => (
            <RenderItemView key={child.key} item={child} actions={actions} />
          ))}
          {item.summary ? (
            <View style={styles.stackSmall}>
              <Text style={styles.foldSubtitle}>{t('message.renderer.subagentSummary')}</Text>
              <Text selectable style={styles.detailText} testID="message.subagentSummary">
                {item.summary}
              </Text>
            </View>
          ) : null}
        </View>
      )}
    </CollabCardShell>
  );
}

function FoldablePanel({
  blockId,
  title,
  subtitle,
  children,
  collapsedBody,
  controlledExpanded,
  defaultExpanded = false,
  layout,
  variant,
  footer,
  testID,
  leadingIcon,
  trailingMeta,
  onControlledToggle,
  chevronSize = 18,
  chevronPosition = 'leading',
}: {
  /**
   * 传入则展开态走共享进程内记忆(默认折叠,虚拟化重挂/切会话/重分组不丢,
   * 见 expandedBlockMemory),**此时 defaultExpanded 无效**;不传则回退
   * 本地 state + defaultExpanded(TodoCard / Orca 协同卡这类默认展开、无需记忆的卡)。
   */
  blockId?: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Optional running preview rendered while the full body remains collapsed. */
  collapsedBody?: ReactNode;
  /** Controlled mode used by work groups with a preview state separate from expansion. */
  controlledExpanded?: boolean;
  /** 仅无 blockId 的本地 state 路径生效;blockId 存在时由共享记忆决定(默认折叠)。 */
  defaultExpanded?: boolean;
  layout: MessageHierarchyLayout;
  variant: 'plain' | 'card';
  footer?: ReactNode;
  testID?: string;
  leadingIcon?: ReactNode;
  trailingMeta?: ReactNode;
  onControlledToggle?: () => void;
  chevronSize?: number;
  chevronPosition?: 'leading' | 'trailing';
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [rememberedExpanded, toggleRememberedExpanded] = useFoldableExpandedState(blockId, defaultExpanded);
  const expanded = controlledExpanded ?? rememberedExpanded;
  const toggleExpanded = onControlledToggle ?? toggleRememberedExpanded;
  const headerLayoutStyle = variant === 'plain'
    ? styles.foldHeaderPlain
    : {
      gap: layout.foldHeaderGap,
      minHeight: layout.foldHeaderMinHeight,
      paddingHorizontal: layout.foldHeaderPaddingHorizontal,
      paddingVertical: layout.foldHeaderPaddingVertical,
    };
  const chevron = expanded ? (
    <ChevronDown color={colors.textTertiary} size={chevronSize} strokeWidth={iconStroke.regular} />
  ) : (
    <ChevronRight color={colors.textTertiary} size={chevronSize} strokeWidth={iconStroke.regular} />
  );
  return (
    <View style={variant === 'card' ? styles.foldCard : styles.foldPlain}>
      <FoldableHeaderButton
        accessibilityLabel={expanded ? t('message.renderer.collapseRow', { label: title }) : t('message.renderer.expandRow', { label: title })}
        expanded={expanded}
        hitSlop={variant === 'plain' ? FOLDABLE_HEADER_HIT_SLOP : undefined}
        onPress={toggleExpanded}
        style={headerLayoutStyle}
        testID={testID}
      >
        {chevronPosition === 'leading' ? chevron : null}
        {leadingIcon}
        <View style={styles.foldText}>
          <Text
            style={[
              styles.foldTitle,
              variant === 'plain' && styles.foldTitlePlain,
            ]}
            numberOfLines={1}
          >
            {title}
          </Text>
          {subtitle ? <Text style={styles.foldSubtitle} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
        {trailingMeta}
        {chevronPosition === 'trailing' ? chevron : null}
      </FoldableHeaderButton>
      {footer}
      {expanded ? (
        <View style={[
          styles.foldBody,
          variant === 'plain'
            ? styles.foldBodyPlain
            : {
              paddingBottom: layout.foldBodyPaddingBottom,
              paddingHorizontal: layout.foldBodyPaddingHorizontal,
            },
        ]}>
          {children}
        </View>
      ) : collapsedBody ? (
        <View style={[
          styles.foldBody,
          variant === 'plain'
            ? styles.foldBodyPlain
            : {
              paddingBottom: layout.foldBodyPaddingBottom,
              paddingHorizontal: layout.foldBodyPaddingHorizontal,
            },
        ]}>
          {collapsedBody}
        </View>
      ) : null}
    </View>
  );
}

function FoldableHeaderButton({
  accessibilityLabel,
  children,
  expanded,
  hitSlop,
  onPress,
  style,
  testID,
}: {
  accessibilityLabel: string;
  children: ReactNode;
  expanded: boolean;
  hitSlop?: typeof FOLDABLE_HEADER_HIT_SLOP;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      hitSlop={hitSlop}
      onPress={onPress}
      style={({ pressed }) => [
        styles.foldHeader,
        style,
        pressed && styles.pressed,
      ]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

function Rail({ children, layout }: { children: ReactNode; layout: MessageHierarchyLayout }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={[styles.rail, { paddingLeft: layout.railPaddingLeft }]}>{children}</View>;
}

// 协同卡片统一外壳:FoldablePanel(card 变体)+ leadingIcon + title + 可折叠 body(经 Rail 缩进)。
// 子 agent 嵌套卡(SubagentCard)与 Orca 协同卡(OrcaCollabCard,派活/回报)共用同一套 chrome,
// 视觉一致;各自数据路径独立(SubagentCard 走 parentUuid 分组,OrcaCollabCard 走 message.orcaCard)。
// children 用 render-prop 拿到 layout(内层 stack 间距等)。
function CollabCardShell({
  blockId,
  leadingIcon,
  title,
  subtitle,
  defaultExpanded = false,
  screenWidth,
  testID,
  children,
}: {
  blockId?: string;
  leadingIcon: ReactNode;
  title: string;
  subtitle?: string;
  /** 仅无 blockId 时生效(Orca 协同卡默认展开);blockId 存在时由共享记忆决定。 */
  defaultExpanded?: boolean;
  screenWidth?: number;
  testID?: string;
  children: (layout: MessageHierarchyLayout) => ReactNode;
}) {
  const layout = useMemo(() => buildMessageHierarchyLayout({
    screenWidth,
    summaryCount: 0,
  }), [screenWidth]);
  return (
    <FoldablePanel
      blockId={blockId}
      title={title}
      subtitle={subtitle}
      defaultExpanded={defaultExpanded}
      leadingIcon={leadingIcon}
      layout={layout}
      testID={testID}
      variant="card"
    >
      <Rail layout={layout}>{children(layout)}</Rail>
    </FoldablePanel>
  );
}

// Agent 引擎显示名(codex → Codex,其余 → Claude Code)。模块级常量:不依赖任何 prop/state,
// 提到组件外避免 MobileAgentSwitchCard 每次重渲染都重建闭包。
const agentSwitchEngineLabel = (kind: unknown): string => (kind === 'codex' ? 'Codex' : 'Claude Code');

// 交接正文是否为英文格式(与 desktop SystemCard.tsx 同款判据)。content.handoff 是持久化
// 数据:英文化之前落库的行仍是中文正文,升级后展开老卡片看到的就是中文——标题里「原文为
// 英文」那句只能对新格式说。判据取英文结束标记的公共尾巴:三种英文标记都含它,旧中文标记不含。
const ENGLISH_HANDOFF_TERMINATOR_TAIL = "; the user's new message follows ==";

function isEnglishSourceHandoff(handoff: string): boolean {
  // 锚在尾部而非 includes(与 desktop SystemCard.tsx 同款):正文里嵌着历史原文,
  // 可能自身就含这段尾串,那样旧中文交接会被误判成英文。
  return handoff.trimEnd().endsWith(ENGLISH_HANDOFF_TERMINATOR_TAIL);
}

// session-agent-switch 边界卡 —— 1:1 对齐桌面 SystemCard.tsx 的 AgentSwitchCard:
// 「分隔线 + 居中药丸」语言(⇄ + 已从 X 切换到 Y + · 目标模型 + 可选 · 已续接原会话),
// 而非通用盒子卡片。药丸可点展开交接摘要面板(切换时发给新引擎的上下文全文,数据来自
// desktop 落库 agent_switch 行 content.handoff)。全灰度、走主题 token,无 chromatic 色。
function MobileAgentSwitchCard({ data }: { data?: Record<string, unknown> }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const from = agentSwitchEngineLabel(data?.fromAgentKind);
  const to = agentSwitchEngineLabel(data?.toAgentKind);
  const toModel = typeof data?.toModel === 'string' ? data.toModel : '';
  const handoff = typeof data?.handoff === 'string' ? data.handoff : '';
  const resumed = data?.resumed === true;
  const label = t('message.renderer.agentSwitchLabel', { from, to });

  return (
    <View style={styles.agentSwitchWrap} testID="message.systemCard.agent-switch">
      <View style={styles.agentSwitchRow}>
        <View style={styles.agentSwitchDivider} />
        <Pressable
          onPress={handoff ? () => setExpanded((v) => !v) : undefined}
          disabled={!handoff}
          accessibilityRole={handoff ? 'button' : undefined}
          accessibilityLabel={handoff ? t('message.renderer.agentSwitchViewHandoff', { label }) : label}
          style={styles.agentSwitchPill}
        >
          <ArrowLeftRight color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.regular} />
          <Text style={styles.agentSwitchPillText} numberOfLines={1}>{label}</Text>
          {toModel ? (
            <>
              <Text style={styles.agentSwitchDot}>·</Text>
              <Text style={styles.agentSwitchModel} numberOfLines={1}>{toModel}</Text>
            </>
          ) : null}
          {resumed ? (
            <>
              <Text style={styles.agentSwitchDot}>·</Text>
              <Text style={styles.agentSwitchPillText} numberOfLines={1}>{t('message.renderer.sessionResumedPill')}</Text>
            </>
          ) : null}
          {handoff ? (
            expanded
              ? <ChevronDown color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.regular} />
              : <ChevronRight color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.regular} />
          ) : null}
        </Pressable>
        <View style={styles.agentSwitchDivider} />
      </View>
      {expanded && handoff ? (
        <View style={styles.agentSwitchHandoffPanel}>
          <Text style={styles.agentSwitchHandoffTitle}>
            {t(
              isEnglishSourceHandoff(handoff)
                ? 'message.renderer.handoffContentDescEnglishSource'
                : 'message.renderer.handoffContentDesc',
            )}
          </Text>
          {/* 交接全文内联展开:卡片本身在消息列表(LegendList)内,不再套内层 ScrollView——
              Android 上嵌套竖向滚动会被父列表截获手势导致内层滚不动(Fabric 更甚)。
              内联让外层列表统一滚动,iOS/Android 行为一致。 */}
          <Text selectable style={styles.agentSwitchHandoffText}>{handoff}</Text>
        </View>
      ) : null}
    </View>
  );
}

function MobileSystemCard({
  data,
  type,
}: {
  data?: Record<string, unknown>;
  type: NonNullable<NormalizedRemoteMessage['systemCardType']>;
}) {
  const styles = useThemedStyles(makeStyles);
  // agent-switch 走专用「分隔线 + 药丸」渲染(对齐桌面),不落通用盒子卡片。
  if (type === 'agent-switch') return <MobileAgentSwitchCard data={data} />;
  const card = formatMobileSystemCard(type, data);
  return (
    <View style={styles.systemCard} testID={`message.systemCard.${type}`}>
      <Text style={styles.systemCardTitle}>{card.title}</Text>
      {card.subtitle ? <Text style={styles.systemCardBody}>{card.subtitle}</Text> : null}
      {card.body ? <Text style={styles.systemCardBody}>{card.body}</Text> : null}
      {card.rows.length > 0 ? (
        <View style={styles.systemCardRows}>
          {card.rows.map((row, index) => (
            <View key={`${row.label}:${index}`} style={styles.systemCardRow}>
              <Text style={styles.systemCardLabel} numberOfLines={1}>{row.label}</Text>
              <Text style={styles.systemCardValue}>{row.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// Orca 协同卡片:Lead 派活(dispatch)/ worker 回报(report)。与 SubagentCard 共用 CollabCardShell
// chrome(同款 leadingIcon+title+可折叠 body),视觉一致;数据路径仍是 message.orcaCard,不碰 parentUuid。
// 默认展开(协同消息是 Lead 对话的主内容),正文可选中(长按复制)。识别/文案抽取在 @/session/orcaCollab。
function OrcaCollabCard({ card, screenWidth }: { card: OrcaCollabCardModel; screenWidth?: number }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const body = card.body && card.body.trim() ? card.body : null;
  // body 为空时不渲染折叠件(无 chevron、无空 body 区),退化成静态卡,只显图标 + 标题。
  if (!body) {
    return (
      <View style={styles.foldCard} testID={`message.orcaCard.${card.variant}`}>
        <View style={styles.orcaStaticHeader}>
          <Bot color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
          <Text style={styles.foldTitle} numberOfLines={1}>{card.title}</Text>
        </View>
      </View>
    );
  }
  return (
    <CollabCardShell
      leadingIcon={<Bot color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />}
      title={card.title}
      defaultExpanded
      screenWidth={screenWidth}
      testID={`message.orcaCard.${card.variant}`}
    >
      {() => (
        <Text selectable style={styles.systemCardBody} testID="message.orcaCardBody">
          {body}
        </Text>
      )}
    </CollabCardShell>
  );
}

// 消息正文统一走原生 markdown 渲染(流式与完成态同一条路径,完成时无"原生→WebView"的切换跳变)。
// 文本选择 = 完成态消息的各块 Text 原生 selectable:长按文字就地弹系统选择手柄/Copy 菜单,
// 不跳转界面;整条复制走操作条按钮。选择按块进行(原生 Text 能力边界,跨段选择做不到)。
/** Sent user atoms stay compact while their full wire text remains copyable/sendable. */
function SentInlineAtomBody({
  layout,
  markdownImageCacheKey,
  onOpenPayload,
  onOpenSessionLink,
  selectable,
  sessionReferences,
  tokens,
}: {
  layout: MessageContentLayout;
  markdownImageCacheKey?: string;
  onOpenPayload?: (payload: MessagePayload) => void;
  onOpenSessionLink?: (url: string) => void;
  selectable: boolean;
  sessionReferences?: readonly MobilePersistedSessionReferenceMetadata[];
  tokens: readonly SentInlineToken[];
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.sentInlineAtomBody} testID="message.sentInlineAtoms">
      {tokens.map((token, index) => {
        if (token.kind === 'quote') {
          return (
            <InlineQuoteChip
              key={`quote:${token.quote.sourcePath ?? 'chat'}:${index}:${token.quote.text}`}
              quote={token.quote}
            />
          );
        }
        if (token.kind === 'pasted') {
          return (
            <InlineReferenceChip
              accessibilityLabel={token.display}
              icon={<FileText color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />}
              key={`pasted:${index}`}
              label={token.display}
              onPress={onOpenPayload
                ? () => onOpenPayload(buildTextPayload('Pasted text', token.text))
                : undefined}
              testID="message.pastedTextChip"
            />
          );
        }
        if (token.kind === 'slash') {
          return (
            <InlineReferenceChip
              accessibilityLabel={token.text}
              key={`slash:${index}`}
              label={token.text}
              testID="message.slashCommandChip"
            />
          );
        }
        return token.text ? (
          <View key={`text:${index}`} style={styles.sentInlineTextChunk}>
            <MarkdownBody
              layout={layout}
              markdownImageCacheKey={markdownImageCacheKey}
              onOpenPayload={onOpenPayload}
              onOpenSessionLink={onOpenSessionLink}
              selectable={selectable}
              sessionReferences={sessionReferences}
              streaming={false}
              text={token.text}
            />
          </View>
        ) : null;
      })}
    </View>
  );
}

function MarkdownBody({
  allowIosUITextView = true,
  markdownImageCacheKey,
  layout,
  onOpenPayload,
  onOpenSessionLink,
  sessionReferences,
  selectable,
  streaming,
  text,
}: {
  /** 超长展开正文在 iOS 回退 RN Text,避免超高 UITextView 空白;仍保留整块复制。 */
  allowIosUITextView?: boolean;
  /** 本地 Markdown 图片的稳定消息身份,避免后续消息复用同一路径的旧媒体缓存。 */
  markdownImageCacheKey?: string;
  layout: MessageContentLayout;
  onOpenPayload?: (payload: MessagePayload) => void;
  /** 会话深链 chip 点击回调(app 内跳转)。 */
  onOpenSessionLink?: (url: string) => void;
  /** 当前落库消息里的展示安全引用摘要，按 sessionId + anchor 精确匹配链接。 */
  sessionReferences?: readonly MobilePersistedSessionReferenceMetadata[];
  /** 完成态消息为 true:各块 Text 开原生选中(含内嵌图片 View 的块除外,Android 上有风险)。 */
  selectable?: boolean;
  /** 消息流式中:文件 chip 层跳过远端验证。 */
  streaming?: boolean;
  text: string;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const chatFilePathContext = useContext(ChatFilePathContext);
  const blocks = useMemo(() => parseMobileMarkdown(text), [text]);
  // Android 的 selectable Text 内嵌 View(直连内联图)行为未定义,含这类 inline 的块不开选中。
  const inlinesSelectable = useCallback((inlines: readonly MobileMarkdownInline[]) => (
    selectable === true
    && !inlines.some((inline) => inline.type === 'image' && isMobileMarkdownImageDirectUrl(inline.url))
  ), [selectable]);
  // 正文 Markdown 图片(![](url) / 安全 <img>)点击后走既有媒体 payload 查看器,与附件图片同一条链路。
  const openMarkdownImage = useCallback((url: string, alt?: string) => {
    if (!onOpenPayload) return;
    const resolvedUrl = mobileMarkdownImageUrlForWorkdir(
      url,
      chatFilePathContext?.workdir,
      markdownImageCacheKey,
      chatFilePathContext?.remoteHostId,
      chatFilePathContext?.sessionId,
    );
    if (!resolvedUrl) return;
    const title = mobileMarkdownImageTitle(resolvedUrl, alt);
    // http(s) 直连预览;xdt 系 scheme 非直连,ImageLightbox 经 remote-media resolver 取图。
    onOpenPayload(buildMediaPayload(
      { kind: 'image', url: resolvedUrl, title, previewable: isMobileMarkdownImageDirectUrl(resolvedUrl) },
      title,
    ));
  }, [
    chatFilePathContext?.remoteHostId,
    chatFilePathContext?.sessionId,
    chatFilePathContext?.workdir,
    markdownImageCacheKey,
    onOpenPayload,
  ]);
  // 会话深链 chip 标题:渲染期同步从会话镜像查(WebView 静态 HTML 无法事后
  // patch)。不含深链的消息恒为 undefined,不影响 html memo 稳定性。
  const sessionLinkIds = useMemo(() => extractSessionLinkIds(text), [text]);
  const remoteSessions = useRemoteSessions();
  const sessionLinkTitles = useMemo(() => {
    if (sessionLinkIds.length === 0) return undefined;
    const map: Record<string, string> = {};
    for (const id of sessionLinkIds) {
      const title = remoteSessions.find((s) => s.id === id)?.title?.trim();
      if (title) map[id] = title;
    }
    return Object.keys(map).length > 0 ? map : undefined;
  }, [sessionLinkIds, remoteSessions]);
  const sessionReferenceDetails = useMemo(() => {
    if (!sessionReferences?.length) return undefined;
    const details: Record<string, string> = {};
    for (const metadata of sessionReferences) {
      details[mobileSessionReferenceMetadataKey(metadata.sessionId, metadata.messageClientId)] =
        formatMobileSessionReferenceMetadata(metadata);
    }
    return details;
  }, [sessionReferences]);
  const renderInlines = useCallback(
    (
      inlines: readonly MobileMarkdownInline[],
      SpanText?: typeof Text,
      baseStyle?: StyleProp<TextStyle>,
      keyPrefix?: string,
    ) => (
      inlines.map((inline, index) => renderInline(inline, index, styles, {
        baseStyle,
        keyPrefix,
        onOpenImage: openMarkdownImage,
        onOpenSessionLink,
        sessionReferenceDetails,
        sessionLinkTitles,
        SpanText,
        streaming,
      }))
    ),
    [onOpenSessionLink, openMarkdownImage, sessionLinkTitles, sessionReferenceDetails, streaming, styles],
  );
  // 连续纯文本块合并为 text_run(跨段选择),代码块/表格/mermaid/含直连图块保持独立。
  const groups = useMemo(() => groupMobileMarkdownSelectableBlocks(blocks), [blocks]);
  // 块可选中且 iOS → 嵌套 span 必须是 UITextView 家族;其余场景缺省 RN Text。
  const spanFor = useCallback((blockSelectable: boolean) => (
    blockSelectable && allowIosUITextView && Platform.OS === 'ios'
      ? MarkdownSelectableSpan
      : undefined
  ), [allowIosUITextView]);
  // 文本运行组:连续纯文本块(段落/标题/列表项)合进同一个原生文本视图,
  // 原生选择手柄即可横跨段落(单个 text view 是 iOS/Android 原生选择的天然边界)。
  // 段间距用「lineHeight = markdownBodyGap 的空行 span」还原:原生文本树内没有块级 gap 可用,
  // 一个高度恰为 gap 的空行在视觉上与原块间距一致。列表项在树内表达为「marker 前缀 span + 正文」
  // (无悬挂缩进;任务项以 ☑/☐ 字符替代原边框小方块)。
  const renderTextRun = (group: Extract<MobileMarkdownBlockGroup, { type: 'text_run' }>): ReactNode => {
    const runSelectable = selectable === true;
    const RunSpan = spanFor(runSelectable) ?? Text;
    return (
      <MarkdownSelectableText
        allowIosUITextView={allowIosUITextView}
        key={group.key}
        selectable={runSelectable}
        selectionColor={colors.surfaceChip}
        style={styles.messageText}
        testID="message.markdownTextRun"
      >
        {group.blocks.flatMap((block, index) => {
          const spans: ReactNode[] = [];
          if (index > 0) {
            spans.push(
              <RunSpan key={`${block.key}:gap`} style={{ lineHeight: layout.markdownBodyGap }}>
                {'\n\n'}
              </RunSpan>,
            );
          }
          const baseStyle: StyleProp<TextStyle> = block.type === 'heading'
            ? [styles.markdownHeading, headingSizeStyle(styles, block.level)]
            : styles.messageText;
          if (block.type === 'list_item') {
            const task = typeof block.checked === 'boolean';
            spans.push(
              <RunSpan
                key={`${block.key}:marker`}
                style={[styles.messageText, styles.markdownListMarkerInline]}
              >
                {task ? (block.checked ? '☑ ' : '☐ ') : block.ordered ? `${block.marker} ` : '• '}
              </RunSpan>,
            );
          }
          spans.push(...renderInlines(block.inlines, spanFor(runSelectable), baseStyle, block.key));
          return spans;
        })}
      </MarkdownSelectableText>
    );
  };
  return (
    <View
      style={[styles.markdownBody, { gap: layout.markdownBodyGap }]}
      testID="message.markdownBody"
    >
      {groups.map((group) => {
        if (group.type === 'text_run') {
          return renderTextRun(group);
        }
        const block = group.block;
        if (block.type === 'mermaid') {
          // 内联图表按「图片」形态呈现:无卡片 chrome、无标签文字、无按钮,
          // 就是一块圆角图表;点击任意位置打开沉浸式全屏详情(透明 Pressable
          // 盖住整块——WebView 会吞掉触摸事件,不盖层拿不到点击)。
          return (
            <View key={block.key} testID="message.mermaidPreviewButton">
              <MermaidDiagramWebView source={block.text} testID="message.mermaidDiagram" />
              {onOpenPayload ? (
                <Pressable
                  accessibilityLabel={t('message.renderer.openDiagramDetail')}
                  accessibilityRole="button"
                  onPress={() => onOpenPayload(buildMermaidPayload(block.text))}
                  style={StyleSheet.absoluteFill}
                  testID="message.mermaidPreviewTap"
                />
              ) : null}
            </View>
          );
        }
        if (block.type === 'math') {
          // display 公式:WebView + KaTeX(形态对齐 mermaid 块,无 chip 卡壳——
          // 公式在视觉上是正文的一部分,背景与气泡底色一致)。
          return (
            <MathFormulaWebView
              key={block.key}
              source={block.text}
              testID="message.mathFormula"
            />
          );
        }
        if (block.type === 'code') {
          return (
            <View key={block.key} style={styles.markdownCodeFrame}>
              <ScrollView
                horizontal
                style={styles.markdownCodeScroll}
                contentContainerStyle={[
                  styles.markdownCodeContent,
                  {
                    paddingHorizontal: layout.codePaddingHorizontal,
                    paddingVertical: layout.codePaddingVertical,
                  },
                ]}
              >
                <HighlightedCodeText
                  SpanComponent={spanFor(selectable === true) ?? Text}
                  allowIosUITextView={allowIosUITextView}
                  language={block.language}
                  selectable={selectable === true}
                  selectionColor={colors.surfaceChip}
                  styles={styles}
                  text={block.text}
                />
              </ScrollView>
            </View>
          );
        }
        if (block.type === 'heading') {
          const headingStyle = [
            styles.markdownHeading,
            headingSizeStyle(styles, block.level),
          ];
          const headingSelectable = inlinesSelectable(block.inlines);
          return (
            <MarkdownSelectableText
              allowIosUITextView={allowIosUITextView}
              key={block.key}
              selectable={headingSelectable}
              selectionColor={colors.surfaceChip}
              style={headingStyle}
              testID="message.markdownHeading"
            >
              {renderInlines(block.inlines, spanFor(headingSelectable))}
            </MarkdownSelectableText>
          );
        }
        if (block.type === 'blockquote') {
          return (
            <View key={block.key} style={styles.markdownQuote} testID="message.markdownQuote">
              <MarkdownSelectableText
                allowIosUITextView={allowIosUITextView}
                selectable={inlinesSelectable(block.inlines)}
                selectionColor={colors.surfaceChip}
                style={[styles.messageText, styles.markdownQuoteText]}
              >
                {renderInlines(block.inlines, spanFor(inlinesSelectable(block.inlines)))}
              </MarkdownSelectableText>
            </View>
          );
        }
        if (block.type === 'list_item') {
          const task = typeof block.checked === 'boolean';
          return (
            <View
              key={block.key}
              style={[styles.markdownListRow, { gap: layout.markdownListGap }]}
              testID={task ? 'message.markdownTaskItem' : undefined}
            >
              <Text style={[
                styles.markdownListMarker,
                { width: layout.markdownListMarkerWidth },
                task && styles.markdownTaskMarker,
              ]}>
                {task ? (block.checked ? '✓' : '') : block.ordered ? block.marker : '•'}
              </Text>
              <MarkdownSelectableText
                allowIosUITextView={allowIosUITextView}
                selectable={inlinesSelectable(block.inlines)}
                selectionColor={colors.surfaceChip}
                style={[styles.messageText, styles.markdownListText]}
              >
                {renderInlines(block.inlines, spanFor(inlinesSelectable(block.inlines)))}
              </MarkdownSelectableText>
            </View>
          );
        }
        if (block.type === 'table') {
          const columnWidths = buildMobileMarkdownTableColumnWidths({
            header: block.header,
            rows: block.rows,
            minWidth: layout.markdownTableCellMinWidth,
          });
          return (
            <ScrollView
              horizontal
              key={block.key}
              style={styles.markdownTableScroll}
              testID="message.markdownTable"
            >
              <View style={styles.markdownTable}>
                <View style={[styles.markdownTableRow, styles.markdownTableHeaderRow]}>
                  {columnWidths.map((columnWidth, index) => {
                    const cell = block.header[index] ?? [];
                    return (
                      <MarkdownSelectableText
                        allowIosUITextView={allowIosUITextView}
                        key={`${block.key}:th:${index}`}
                        selectable={inlinesSelectable(cell)}
                        selectionColor={colors.surfaceChip}
                        style={[
                          styles.markdownTableCell,
                          { width: columnWidth },
                          styles.markdownTableHeaderCell,
                        ]}
                      >
                        {renderInlines(cell, spanFor(inlinesSelectable(cell)))}
                      </MarkdownSelectableText>
                    );
                  })}
                </View>
                {block.rows.map((row) => (
                  <View key={row.key} style={styles.markdownTableRow}>
                    {columnWidths.map((columnWidth, index) => {
                      const cell = row.cells[index] ?? [];
                      return (
                        <MarkdownSelectableText
                          allowIosUITextView={allowIosUITextView}
                          key={`${row.key}:td:${index}`}
                          selectable={inlinesSelectable(cell)}
                          selectionColor={colors.surfaceChip}
                          style={[styles.markdownTableCell, { width: columnWidth }]}
                        >
                          {renderInlines(cell, spanFor(inlinesSelectable(cell)))}
                        </MarkdownSelectableText>
                      );
                    })}
                  </View>
                ))}
              </View>
            </ScrollView>
          );
        }
        return (
          <MarkdownSelectableText
            allowIosUITextView={allowIosUITextView}
            key={block.key}
            selectable={inlinesSelectable(block.inlines)}
            selectionColor={colors.surfaceChip}
            style={styles.messageText}
          >
            {renderInlines(block.inlines, spanFor(inlinesSelectable(block.inlines)))}
          </MarkdownSelectableText>
        );
      })}
    </View>
  );
}

/**
 * 文件/目录路径 chip 的共享执行体(远程会话文件交互,对齐桌面 #631 的 chip 点亮
 * 语义)。inline code 与本地路径链接两种形态共用:候选先经被控端精确 stat 验证——
 * 文件/目录点亮可点(文件 → Quick Look 预览页;目录 → 文件浏览器定位),明确
 * 不存在保持纯文本,链路断等无法判定时乐观点亮(点击后预览页自己的错误 UX 兜底)。
 * workdir 外的绝对路径同样候选(对齐桌面):文件走被控端 absPath 取件通道预览,
 * 目录因文件浏览器只认 workdir 内而保持纯文本(canOpenChatPathChip)。
 * 无会话上下文(context null)/ 流式中 → plainStyle 纯文本渲染。
 */
function ChatPathChipSpan({
  candidate,
  chipStyle,
  display,
  plainStyle,
  SpanText,
  streaming,
}: {
  candidate: ChatPathCandidate | null;
  chipStyle: StyleProp<TextStyle>;
  /** span 显示文本(code 形态 = 原文;链接形态 = 链接 label)。 */
  display: string;
  plainStyle: StyleProp<TextStyle>;
  SpanText: typeof Text;
  streaming?: boolean;
}) {
  const ctx = useContext(ChatFilePathContext);
  // workdir 外候选不再一票否决:relPath 为 null 表示 workdir 外,文件仍可经
  // absPath 通道打开,可开性由 canOpenChatPathChip 在 verdict 定 kind 后裁决。
  const target = useMemo(() => {
    if (!ctx || !candidate) return null;
    const absPath = resolveChatAbsPath(candidate.href, ctx.workdir);
    return { absPath, relPath: toWorkdirRel(ctx.workdir, absPath) };
  }, [candidate, ctx]);
  // verdict 是**缓存的纯派生**,chip 不自己存结论:ForRender 版会把 TTL 未过期的负缓存
  // 回成 'unknown',于是断链期间的乐观点亮也来自缓存。自存一份的话收不到缓存变化 ——
  // 同一路径出现在多个 chip 上时,A 按 unknown 点亮、B 拿到确定的 nonfile,A 会一直
  // 带着下划线可点(PR #1144 review 实捉,桌面同款)。
  const readVerdict = useCallback(
    () =>
      ctx && target
        ? peekRemotePathVerdictForRender(ctx.deviceId, ctx.workdir, target.absPath)
        : undefined,
    [ctx, target],
  );
  const [verdict, setVerdict] = useState<RemotePathVerdict | undefined>(readVerdict);

  // 本 key 的缓存变化(确定态落库 / 负缓存到期)→ 递增,**驱动下面的验证副作用重跑**。
  // 按 key 过滤:一屏几十个 chip 各自订阅,全量广播会让首屏 N 次 stat 引发 N×N 次重渲染。
  //
  // ⚠️ 这里必须递增一个计数、不能只 setVerdict(readVerdict()):`readVerdict` 是
  // `[ctx, target]` 的稳定 useCallback,通知**不改变验证副作用的任何依赖**,那个副作用
  // 就不会重跑 → 再也不发 verifyRemotePathCached。TTL 到期时负缓存已被删、又没有确定态,
  // ForRender 回 undefined,于是 chip 只完成「降级成纯文本」、没完成「重验」,挂载期间
  // 永不自愈 —— 比重构前(一直乐观点亮)更糟。桌面同一处把 cacheGen 放进了验证副作用的
  // 依赖,手机漏了这一环(PR #1144 review 实捉:第 10 轮重构只做对了桌面那一半)。
  const [cacheGen, setCacheGen] = useState(0);
  useEffect(() => {
    if (!ctx || !target) return;
    const mine = remotePathVerdictKey(ctx.deviceId, ctx.workdir, target.absPath);
    return subscribeRemotePathVerdictChange((key) => {
      if (key === mine) setCacheGen((n) => n + 1);
    });
  }, [ctx, target]);

  useEffect(() => {
    // 无条件按当前缓存重新派生(升级 / 降级同一条路)。
    setVerdict(readVerdict());
    if (!ctx || !target) return;
    // 有确定结论就不必重验;unknown 的限流由 verifyRemotePathCached 的负缓存承担。
    if (peekRemotePathVerdict(ctx.deviceId, ctx.workdir, target.absPath)) return;
    // 流式中不发验证:半截路径会产生大量无意义 stat(与桌面 isStreaming gate 同理)。
    if (streaming) return;
    let cancelled = false;
    void verifyRemotePathCached(ctx.deviceId, ctx.workdir, target.absPath, ctx.statPath).then(() => {
      // 不看返回值:结论已落缓存,统一重新派生。
      if (!cancelled) setVerdict(readVerdict());
    });
    return () => {
      cancelled = true;
    };
    // cacheGen:本 key 的缓存状态变化(TTL 到期 / 别处写入确定态)→ 重新派生 + 必要时重验。
  }, [ctx, streaming, target, readVerdict, cacheGen]);

  // 点亮门槛分两档(见 ChatPathCandidate.ambiguousShape 的说明):
  //   - 形状明确是路径(绝对路径 / 尾斜杠目录 / 分隔符+扩展名):unknown(链路断 /
  //     stat 异常)照旧乐观点亮,绝不因断链把整条消息的 chip 全灭掉;
  //   - 歧义形状(裸名 `array.map`、分隔符无扩展 `and/or`——与 `package.json`、
  //     `src/components` 词法同形,分不开):必须等远端明确回 file / directory 才点亮。
  //     否则链路一抖,满屏普通行内 code 都变成可点的假链接——「可点」的视觉信号一旦
  //     不可信,加强它只会让误判更醒目(DESIGN.md §14.5 规则 5)。
  const verdictAllowsLit = candidate?.ambiguousShape
    ? verdict === 'file' || verdict === 'directory'
    : verdict !== undefined && verdict !== 'nonfile';
  const lit = !!ctx && !!candidate && !!target && verdictAllowsLit;
  if (!lit) {
    return <SpanText style={plainStyle}>{display}</SpanText>;
  }
  const kind: 'file' | 'directory' =
    verdict === 'directory' || (verdict === 'unknown' && candidate.directoryShape) ? 'directory' : 'file';
  if (!canOpenChatPathChip(kind, target.relPath)) {
    return <SpanText style={plainStyle}>{display}</SpanText>;
  }
  const chipTarget: ChatFilePathTarget = {
    kind,
    relPath: target.relPath,
    absPath: target.absPath,
    ...(kind === 'file' && candidate.line !== undefined ? { line: candidate.line } : {}),
  };
  return (
    <SpanText
      onLongPress={ctx.onLongPressPath ? () => ctx.onLongPressPath?.(chipTarget) : undefined}
      onPress={() => ctx.onOpenPath(chipTarget)}
      style={chipStyle}
      testID="message.markdownPathChip"
    >
      {display}
    </SpanText>
  );
}

/**
 * 「下划线 ⇔ 可点」的**唯一判据**(DESIGN.md §14.5 规则①要求双向成立:可点的一定有
 * 下划线,有下划线的一定可点)。onPress 缺席时不给 `markdownLink`,所以在结构上
 * 无法造出「有下划线却点不动」的元素。
 *
 * 为什么要收成一处:PR #1144 的两轮 review 各捉到一个反例(文件阅读器的会话 chip、
 * 以及同一面上本就带下划线 + pointer 的图片 chip),根因都是「加不加下划线」与
 * 「有没有 onPress」在各自的分支里独立决定 —— 判据分散必然漂移。本文件的会话 chip /
 * 图片 chip 的 onPress 也是条件式的(handler 由上层可选注入),同款隐患成立。
 *
 * 所有可点 inline 一律经此取样式,**不要在 case 分支里直接写 `styles.markdownLink`**
 * (chatPathCandidate.test.ts 有源码级守卫钉住这条)。路径 chip 不走这里:它的可点性
 * 由 ChatPathChipSpan 的 `lit` 单点裁决,同样是「一个判据」。
 */
function clickableInlineStyle(
  styles: ReturnType<typeof makeStyles>,
  onPress: undefined | (() => void),
  base: StyleProp<TextStyle>,
  extra?: StyleProp<TextStyle>,
): StyleProp<TextStyle> {
  return [base, onPress ? styles.markdownLink : undefined, extra];
}

/** 本地路径链接形态的路径 chip 包装:candidate 按 url memo,保证引用稳定——
 *  renderInline 是普通函数,若在其内直接 classify 会每次 render 产新对象,
 *  击穿 ChatPathChipSpan 的 memo/effect 依赖,unknown verdict(不落缓存)的
 *  chip 会随重渲染熄灭再点亮地闪烁(bot review 实捉,规则 7)。 */
function LinkPathChipSpan({
  url,
  display,
  bare,
  baseStyle,
  SpanText,
  styles,
  streaming,
}: {
  url: string;
  display: string;
  /** 正文裸写的路径(非作者手写的 `[label](url)`),决定点亮后是否套等宽 chip。 */
  bare?: boolean;
  baseStyle?: StyleProp<TextStyle>;
  SpanText: typeof Text;
  styles: ReturnType<typeof makeStyles>;
  streaming?: boolean;
}) {
  const candidate = useMemo(() => classifyChatPathLinkTarget(url), [url]);
  // 点亮后是否套等宽 chip,按 DESIGN.md §14.5 的落地推论分三档(与桌面
  // shouldRenderCodeReferenceLabel 的分流一一对应):
  //   - 正文裸写的路径 → **不套**。它的未点亮态是普通正文,套上会让同一句里点亮的
  //     `src/a.ts` 与未点亮的 `src/b.ts` 在字体、底色、下划线三处齐变。
  //   - 作者手写、label 读起来是文件引用(`[README.md](path)`)→ **套**。那是作者的
  //     排版意图,对齐桌面 FileTargetChip。
  //   - 作者手写、散文 label(`[看这份规则](path)`)→ 不套,对齐桌面 ResolvedLocalLink。
  const codeStyled = useMemo(
    () => !bare && candidate !== null && chatPathLabelReadsAsFileReference(display, candidate, url),
    [bare, candidate, display, url],
  );
  return (
    <ChatPathChipSpan
      candidate={candidate}
      chipStyle={
        codeStyled
          ? [baseStyle, styles.markdownInlineCode, styles.markdownPathChip]
          : [baseStyle, styles.markdownPathChip]
      }
      display={display}
      // 未点亮一律回落正文样式(与桌面一致:未解析的 local-candidate 渲染成纯 span)。
      plainStyle={baseStyle}
      SpanText={SpanText}
      streaming={streaming}
    />
  );
}

/** inline code 形态的路径 chip 包装:候选判定 + code 底色样式。 */
function InlineCodePathSpan({
  text,
  baseStyle,
  SpanText,
  styles,
  streaming,
}: {
  text: string;
  baseStyle?: StyleProp<TextStyle>;
  SpanText: typeof Text;
  styles: ReturnType<typeof makeStyles>;
  streaming?: boolean;
}) {
  const candidate = useMemo(() => classifyInlineCodePathCandidate(text), [text]);
  return (
    <ChatPathChipSpan
      candidate={candidate}
      chipStyle={[baseStyle, styles.markdownInlineCode, styles.markdownPathChip]}
      display={text}
      plainStyle={[baseStyle, styles.markdownInlineCode]}
      SpanText={SpanText}
      streaming={streaming}
    />
  );
}

function renderInline(
  inline: MobileMarkdownInline,
  index: number,
  styles: ReturnType<typeof makeStyles>,
  ctx: {
    /** text_run 合并树里,每个 span 都要自带块级基础样式(扁平两级 flatten 不做深层继承)。 */
    baseStyle?: StyleProp<TextStyle>;
    /** text_run 合并树里多个块共父,key 需要块级前缀防冲突。 */
    keyPrefix?: string;
    onOpenImage?: (url: string, alt?: string) => void;
    onOpenPayload?: (payload: MessagePayload) => void;
    onOpenSessionLink?: (url: string) => void;
    sessionReferenceDetails?: Readonly<Record<string, string>>;
    sessionLinkTitles?: Readonly<Record<string, string>>;
    /** 块可选中且 iOS 时为 MarkdownSelectableSpan(嵌套进 UITextView 原生树);缺省 RN Text。 */
    SpanText?: typeof Text;
    /** 消息流式中:文件 chip 层跳过远端验证(半截路径不发 stat)。 */
    streaming?: boolean;
  } = {},
): ReactNode {
  const SpanText = ctx.SpanText ?? Text;
  const openImage = ctx.onOpenImage ?? (ctx.onOpenPayload
    ? (url: string, alt?: string) => {
        const title = mobileMarkdownImageTitle(url, alt);
        ctx.onOpenPayload?.(buildMediaPayload(
          { kind: 'image', url, title, previewable: isMobileMarkdownImageDirectUrl(url) },
          title,
        ));
      }
    : undefined);
  const spanKey = (suffix: string) => (ctx.keyPrefix ? `${ctx.keyPrefix}:${suffix}` : suffix);
  switch (inline.type) {
    case 'text':
      return <SpanText key={spanKey(`text:${index}`)} style={ctx.baseStyle}>{inline.text}</SpanText>;
    case 'link': {
      const session = parseSessionDeepLinkUrl(inline.url);
      if (session) {
        return (
          <MarkdownSessionLinkSpan
            baseStyle={ctx.baseStyle}
            inline={inline}
            key={spanKey(`session-link:${index}:${inline.url}`)}
            onOpenSessionLink={ctx.onOpenSessionLink}
            session={session}
            sessionReferenceDetails={ctx.sessionReferenceDetails}
            sessionLinkTitles={ctx.sessionLinkTitles}
            SpanText={SpanText}
            styles={styles}
          />
        );
      }
      // 非 session 的 Cindy 深链(project 等,双 scheme:cindy 主 + xdt-maker
      // 兼容存量;桌面端粘贴 chip 化后按 `[标题](深链)` / 裸链接发送):手机端
      // 没有对应跳转目标,渲染 label 纯文本;绝不落 Linking.openURL(这些
      // scheme 未注册到手机 OS,openURL 必失败,还会在部分 Android 上弹系统
      // 报错)。裸项目链接(text === url,侧边栏复制的无标题形态)推导目录名
      // 展示,不给用户看 percent-encoded 原串(review P2)。
      if (isCindyDeepLinkUrl(inline.url)) {
        const explicitLabel =
          inline.text.trim() && inline.text.trim() !== inline.url ? inline.text.trim() : null;
        const projectTarget = explicitLabel ? null : parseProjectDeepLinkUrl(inline.url);
        const display =
          explicitLabel
          ?? (projectTarget ? projectDisplayName(projectTarget.workingDir) : inline.url);
        return (
          <SpanText key={spanKey(`xdt-link:${index}:${inline.url}`)} style={ctx.baseStyle}>
            {display}
          </SpanText>
        );
      }
      // 本地路径链接([README.md](/abs/README.md:17)):走文件 chip 链路——
      // 存在则点亮进预览/文件浏览器,不存在/未验证只显示 label 纯文本,
      // 绝不落 Linking.openURL(本地路径交给系统必失败)。此处 classify 只做
      // 分支判定(廉价纯函数),对象引用不下传;组件内按 url 重新 memo 一份。
      if (classifyChatPathLinkTarget(inline.url)) {
        return (
          <LinkPathChipSpan
            key={spanKey(`path-link:${index}:${inline.url}`)}
            bare={inline.bare}
            baseStyle={ctx.baseStyle}
            display={inline.text}
            SpanText={SpanText}
            streaming={ctx.streaming}
            styles={styles}
            url={inline.url}
          />
        );
      }
      // onPress 与下划线取同一个值,不可能一边有一边没有。
      const openExternalUrl = () => {
        void Linking.openURL(inline.url).catch(() => undefined);
      };
      return (
        <SpanText
          key={spanKey(`link:${index}:${inline.url}`)}
          onPress={openExternalUrl}
          style={clickableInlineStyle(styles, openExternalUrl, ctx.baseStyle)}
        >
          {inline.text}
        </SpanText>
      );
    }
    case 'strong':
      return <SpanText key={spanKey(`strong:${index}`)} style={[ctx.baseStyle, styles.markdownStrong]}>{inline.text}</SpanText>;
    case 'emphasis':
      return <SpanText key={spanKey(`em:${index}`)} style={[ctx.baseStyle, styles.markdownEmphasis]}>{inline.text}</SpanText>;
    case 'code':
      return (
        <InlineCodePathSpan
          key={spanKey(`code:${index}`)}
          baseStyle={ctx.baseStyle}
          SpanText={SpanText}
          streaming={ctx.streaming}
          styles={styles}
          text={inline.text}
        />
      );
    case 'strikethrough':
      return <SpanText key={spanKey(`strike:${index}`)} style={[ctx.baseStyle, styles.markdownStrike]}>{inline.text}</SpanText>;
    case 'math':
      // inline 公式:原生 Text 流内嵌不了 KaTeX,用 Unicode 近似(上标 ²、
      // 希腊字母、√ 等)保持文本流/选择/性能;复杂公式的精确渲染走 display
      // 块的 WebView KaTeX。
      return (
        <SpanText key={spanKey(`math:${index}`)} style={[ctx.baseStyle, styles.markdownMathInline]}>
          {latexToUnicodeApproximation(inline.text)}
        </SpanText>
      );
    case 'image': {
      // openImage 由上层可选注入 → 缺席时 chip 不可点,下划线也必须跟着不加
      // (clickableInlineStyle 保证两者同源)。
      const openImageChip = openImage ? () => openImage(inline.url, inline.alt) : undefined;
      // xdt 系非直连图:RN Image 无法直接加载内部 scheme,渲染可点 chip,
      // 点开后由 ImageLightbox 经 remote-media resolver 取图。
      if (!isMobileMarkdownImageDirectUrl(inline.url)) {
        return (
          <SpanText
            key={spanKey(`image:${index}:${inline.url}`)}
            onPress={openImageChip}
            style={clickableInlineStyle(styles, openImageChip, ctx.baseStyle)}
            testID="message.markdownInlineImageChip"
          >
            {inline.alt || i18n.t('message.renderer.imageFallbackTitle')}
          </SpanText>
        );
      }
      // 直连图统一按缩略图形态渲染(无法预知原图比例,cover 裁切 + 封顶尺寸),流式与完成态同一条路径;点按走全屏查看原图。
      // Android 不支持 <Text> 直接内嵌 <Image>(不渲染/行为未定义),用「Text 内嵌显式尺寸 View 包 Image」
      // 的形态承载(RN 对 Text 内嵌 View 双端支持,要求显式尺寸;规则 15,Android 真机待验证)。
      const size = mobileMarkdownInlineImageSize(inline);
      return (
        <Text
          key={`image:${index}:${inline.url}`}
          onPress={openImage ? () => openImage(inline.url, inline.alt) : undefined}
          testID="message.markdownInlineImage"
        >
          <View style={size}>
            <Image
              accessibilityLabel={inline.alt || i18n.t('message.renderer.imageFallbackTitle')}
              resizeMode="cover"
              source={{ uri: inline.url }}
              style={[styles.markdownInlineImage, size]}
            />
          </View>
        </Text>
      );
    }
  }
}

function MarkdownSessionLinkSpan({
  baseStyle,
  inline,
  onOpenSessionLink,
  session,
  sessionReferenceDetails,
  sessionLinkTitles,
  SpanText,
  styles,
}: {
  baseStyle?: StyleProp<TextStyle>;
  inline: Extract<MobileMarkdownInline, { type: 'link' }>;
  onOpenSessionLink?: (url: string) => void;
  session: SessionDeepLinkTarget;
  sessionReferenceDetails?: Readonly<Record<string, string>>;
  sessionLinkTitles?: Readonly<Record<string, string>>;
  SpanText: typeof Text;
  styles: ReturnType<typeof makeStyles>;
}) {
  const messages = useRemoteSessionMessages(session.sessionId);
  const explicit =
    inline.text.trim() && inline.text.trim() !== inline.url ? inline.text.trim() : null;
  const targetMessage = session.messageClientId
    ? messages.find((message) => (
        message.clientId === session.messageClientId || message.id === session.messageClientId
      ))
    : null;
  const messageLabel = targetMessage ? mobileSessionMessageDisplayText(targetMessage) : null;
  const title = session.messageClientId
    ? compactSessionMessageLabel(messageLabel ?? shortSessionId(session.messageClientId))
    : explicit
      ?? sessionLinkTitles?.[session.sessionId]
      ?? i18n.t('message.renderer.sessionChipFallback', { id: shortSessionId(session.sessionId) });
  const detail = sessionReferenceDetails?.[
    mobileSessionReferenceMetadataKey(session.sessionId, session.messageClientId)
  ];
  // handler 由上层可选注入 → 缺席时 chip 不可点,下划线也必须跟着不加
  // (clickableInlineStyle 保证两者同源)。
  const openSessionLink = onOpenSessionLink ? () => onOpenSessionLink(inline.url) : undefined;
  return (
    <SpanText
      onPress={openSessionLink}
      style={clickableInlineStyle(styles, openSessionLink, baseStyle, styles.sessionLinkChipText)}
    >
      {`${session.messageClientId ? '❝' : '↳'} ${title}${detail ? ` · ${detail}` : ''}`}
    </SpanText>
  );
}

function AttachmentStrip({
  attachments,
  align,
  layout,
  onOpen,
  onResolveRemoteMedia,
}: {
  attachments: readonly NormalizedAttachment[];
  align: 'left' | 'right';
  layout: MessageContentLayout;
  onOpen?: (payload: MessagePayload) => void;
  onResolveRemoteMedia?: ResolveRemoteMediaFn;
}) {
  const styles = useThemedStyles(makeStyles);
  // 订阅本地缩略兜底版本:hydrate / 新注册落盘后,已渲染的 cindy-oss-attach:// 气泡
  // 自动从占位卡切到本地图(返回值不消费,订阅本身驱动重渲染)。
  useSentAttachmentThumbsVersion();
  const { imageAttachments, fileAttachments } = partitionMessageAttachments(attachments);
  const alignStyle = align === 'right' ? styles.attachmentStripRight : styles.attachmentStripLeft;

  return (
    <View style={[styles.attachmentStrip, alignStyle, { gap: layout.attachmentGap }]}>
      {/* 图片附件对齐桌面版:逐张竖排(不换行拼贴),各自按原始宽高比 contain。
          overlay:本机上传的图在被控端物化改写前 url 仍是 cindy-oss-attach://,本地
          兜底命中时替换成 file:// 直接渲染(payload 同源替换,点开查看器同图)。 */}
      {imageAttachments.map(applySentAttachmentThumbOverlay).map((item, index) => (
        <MediaPreview
          key={`${item.kind}:${item.uri ?? item.name}:${index}`}
          label={item.name}
          layout={layout}
          media={{ kind: 'image', url: item.uri ?? '', previewable: item.previewable }}
          onOpen={onOpen ? () => onOpen(buildAttachmentPayload(item)) : undefined}
          onResolveRemoteMedia={onResolveRemoteMedia}
          variant="attachment"
        />
      ))}
      {fileAttachments.length > 0 ? (
        <View style={[
          styles.attachmentFileColumn,
          {
            gap: layout.attachmentGap,
            maxWidth: layout.fileChipMaxWidth,
          },
          align === 'right' && styles.attachmentFileColumnRight,
        ]}>
          {fileAttachments.map((item, index) => (
            <FileChip
              key={`${item.kind}:${item.path ?? item.name}:${index}`}
              layout={layout}
              name={item.name}
              onOpen={onOpen ? () => onOpen(buildAttachmentPayload(item)) : undefined}
              path={item.path}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * ToolMediaBlock — tool 产出媒体的独立视觉消息(对齐桌面 'tool_media' RenderItem):
 * agent 出的图 / 视频(lizi_art、飞书拉图等)跳出 tool_group 折叠卡,紧跟其后作为
 * 独立块渲染,用户不展开工具行也能一眼看到。图片走 attachment 变体(原始宽高比
 * contain 进 max 框,xdt-image:// 经取件队列懒取缩略图);video/audio 保持占位
 * 卡片、点开查看器播放。媒体按 url 去重(与 shared 发射判定同一口径)。
 */
function ToolMediaBlock({
  item,
  actions,
}: {
  item: MobileToolMediaItem;
  actions: MessageActions & { firstUserMessageClientId?: string };
}) {
  const styles = useThemedStyles(makeStyles);
  const contentLayout = useMemo(() => buildMessageContentLayout({
    screenWidth: actions.screenWidth,
  }), [actions.screenWidth]);
  const media = useMemo(
    () => dedupeToolMediaByUrl(item.tools.flatMap((tool) => tool.media ?? [])),
    [item.tools],
  );
  const openPayload = actions.onOpenPayload;
  if (media.length === 0) return null;
  return (
    <View
      style={[styles.toolMediaBlock, { gap: contentLayout.attachmentGap }]}
      testID="message.toolMediaBlock"
    >
      {media.map((entry, index) => (
        <MediaPreview
          key={`${entry.kind}:${entry.url}:${index}`}
          label={entry.title || mediaLabel(entry)}
          layout={contentLayout}
          media={entry}
          onOpen={openPayload
            ? () => openPayload(buildMediaPayload(entry, entry.title || mediaLabel(entry)))
            : undefined}
          onResolveRemoteMedia={actions.onResolveRemoteMedia}
          variant={entry.kind === 'image' ? 'attachment' : 'card'}
        />
      ))}
    </View>
  );
}

/**
 * 附件图原图尺寸的模块级缓存(键 = 源 media.url,跨 presign 刷新稳定)。
 * FlatList 虚拟化反复 unmount/remount MediaPreview,组件态存不住尺寸;
 * 上限兜底防长会话无界增长(整表清空即可,丢了只是多一次 getSize)。
 */
const attachmentIntrinsicSizeCache = new Map<string, AttachmentImageIntrinsicSize>();
const ATTACHMENT_INTRINSIC_CACHE_MAX = 500;

/**
 * MediaPreview — 聊天列表里的媒体缩略图 / 占位卡片。
 * 图片:可直接预览的(http/data:)直接渲染缩略图;桌面端媒体(xdt-image://)mount 时
 * 经取件队列懒取件后渲染缩略图(取件中为同尺寸静默占位帧,失败回落占位卡片文案但
 * 保持同尺寸帧避免列表 reflow)。点击一律走 onOpen 打开 payload 查看器看原图。
 * video/audio 与非桌面端不可预览图片保持占位卡片现状。
 *
 * variant(对齐桌面版 ChatImageView 的两档):
 *   - 'card'      :工具产出媒体,固定小帧 cover 裁切;
 *   - 'attachment':用户消息图片附件,按原始宽高比 contain 进 max 框(桌面
 *     user-attached 同款 280×180 语义),圆角、无边框、无文件名。
 */
function MediaPreview({
  layout,
  media,
  label,
  onOpen,
  onResolveRemoteMedia,
  variant = 'card',
}: {
  layout: MessageContentLayout;
  media: NormalizedToolMedia;
  label: string;
  onOpen?: () => void;
  onResolveRemoteMedia?: ResolveRemoteMediaFn;
  variant?: 'card' | 'attachment';
}) {
  const styles = useThemedStyles(makeStyles);
  const preview = summarizeMessagePayloadPreview(buildMediaPayload(media, label));
  const autoResolve = shouldAutoResolveMediaThumbnail(media, !!onResolveRemoteMedia);
  const [resolveState, setResolveState] = useState<MediaThumbnailResolveState>({ status: 'idle' });
  // attachment 变体的原图尺寸。初值走模块级缓存:FlatList 虚拟化会反复
  // unmount/remount 本组件,不缓存的话每次划回都重新 getSize、重演一次
  // 占位帧 → 真图尺寸的切换(规则 7 的跳变)。
  const [intrinsicSize, setIntrinsicSize] = useState<AttachmentImageIntrinsicSize | null>(
    () => attachmentIntrinsicSizeCache.get(media.url) ?? null,
  );
  // Image 加载失败(典型:presign 过期)只强制重取一次,防 onError↔重取死循环。
  const imageRetryUsedRef = useRef(false);

  const resolveThumbnail = useCallback((forceRefresh: boolean, signal?: AbortSignal) => {
    if (!onResolveRemoteMedia) return;
    let cancelled = false;
    setResolveState({ status: 'loading' });
    void onResolveRemoteMedia(
      // thumbnail:列表缩略图只要被控端缩好的小图(1024px webp inline 回包),
      // 不为一个气泡预览拉整张原图;点开查看器仍按原图键另行取件(可缩放)。
      { kind: media.kind, url: media.url, previewable: media.previewable, thumbnail: media.kind === 'image' },
      { signal, forceRefresh },
    )
      .then((resolved) => {
        if (!cancelled && !signal?.aborted) setResolveState({ status: 'ready', media: resolved });
      })
      .catch(() => {
        if (!cancelled && !signal?.aborted) setResolveState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [media.kind, media.previewable, media.url, onResolveRemoteMedia]);

  useEffect(() => {
    if (!autoResolve) return;
    imageRetryUsedRef.current = false;
    const controller = new AbortController();
    const cancel = resolveThumbnail(false, controller.signal);
    return () => {
      cancel?.();
      controller.abort();
    };
  }, [autoResolve, resolveThumbnail]);

  const phase = mediaThumbnailPhase(media, resolveState, !!onResolveRemoteMedia);
  const thumbUri = phase.kind === 'direct' ? media.url : phase.kind === 'resolved' ? phase.uri : null;

  const handleImageError = useCallback(() => {
    if (imageRetryUsedRef.current) {
      setResolveState({ status: 'error' });
      return;
    }
    imageRetryUsedRef.current = true;
    resolveThumbnail(true);
  }, [resolveThumbnail]);

  // attachment 变体:异步量原图宽高并写入模块级缓存;失败置 -1 走 max 框回落帧,
  // 图仍照常渲染(不作为出图门控,见下)。已有尺寸(含缓存命中)不重复测量。
  useEffect(() => {
    if (variant !== 'attachment' || !thumbUri || intrinsicSize) return;
    let cancelled = false;
    Image.getSize(
      thumbUri,
      (width, height) => {
        if (attachmentIntrinsicSizeCache.size >= ATTACHMENT_INTRINSIC_CACHE_MAX) {
          attachmentIntrinsicSizeCache.clear();
        }
        attachmentIntrinsicSizeCache.set(media.url, { height, width });
        if (!cancelled) setIntrinsicSize({ height, width });
      },
      () => {
        if (!cancelled) setIntrinsicSize({ height: -1, width: -1 });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [variant, thumbUri, intrinsicSize, media.url]);

  if (variant === 'attachment'
    && (phase.kind === 'direct' || phase.kind === 'resolving' || phase.kind === 'resolved'
      || (phase.kind === 'fallback' && (phase.reason === 'error' || phase.reason === 'unsupported-mime')))) {
    const displaySize = attachmentImageDisplaySize(
      intrinsicSize,
      layout.attachmentImageMaxWidth,
      layout.attachmentImageMaxHeight,
    );
    return (
      <MessageContentOpenButton
        accessibilityLabel={`${preview.actionLabel} ${preview.title}`}
        onPress={onOpen}
        style={styles.attachmentImageWrap}
        testID="message.mediaPreviewButton"
      >
        {phase.kind === 'fallback' ? (
          // 取件失败保持附件帧尺寸(不回落小卡片帧造成 reflow);点开查看器可重试。
          <View
            style={[styles.attachmentImagePending, styles.attachmentImageFallback, displaySize]}
            testID="message.mediaThumbFallback"
          >
            <Text style={styles.mediaKind}>{preview.meta[0] ?? payloadMediaKindLabel(media.kind)}</Text>
            <Text style={styles.mediaHint} numberOfLines={2}>{preview.detail}</Text>
          </View>
        ) : thumbUri ? (
          <Image
            // 有 uri 立即渲染真图,不等 getSize(direct 图有立即可用的 URI,
            // 门控只会平白多一帧灰底占位;尺寸未知时先 max 框 contain letterbox,
            // getSize 返回后收敛到真实比例)。contain 而非 cover:帧比例与原图
            // 一致时两者等价;max 框帧时保证不裁内容。
            resizeMode="contain"
            source={{ uri: thumbUri }}
            onError={phase.kind === 'resolved' ? handleImageError : undefined}
            style={[styles.attachmentImage, displaySize]}
          />
        ) : (
          <View style={[styles.attachmentImagePending, displaySize]} testID="message.mediaThumbLoading" />
        )}
      </MessageContentOpenButton>
    );
  }

  if (phase.kind === 'direct' || phase.kind === 'resolving' || phase.kind === 'resolved'
    || (phase.kind === 'fallback' && (phase.reason === 'error' || phase.reason === 'unsupported-mime'))) {
    const uri = thumbUri;
    const frameSize = { height: layout.imagePreviewHeight, width: layout.imagePreviewWidth };
    return (
      <MessageContentOpenButton
        accessibilityLabel={`${preview.actionLabel} ${preview.title}`}
        onPress={onOpen}
        style={[
          styles.imagePreviewWrap,
          { width: layout.imagePreviewWidth },
        ]}
        testID="message.mediaPreviewButton"
      >
        {uri ? (
          <Image
            resizeMode="cover"
            source={{ uri }}
            onError={phase.kind === 'resolved' ? handleImageError : undefined}
            style={[styles.imagePreview, frameSize]}
          />
        ) : phase.kind === 'resolving' ? (
          <View style={[styles.imagePreview, frameSize]} testID="message.mediaThumbLoading" />
        ) : (
          <View
            style={[styles.imagePreview, styles.imagePreviewFallback, frameSize]}
            testID="message.mediaThumbFallback"
          >
            <Text style={styles.mediaKind}>{preview.meta[0] ?? payloadMediaKindLabel(media.kind)}</Text>
            <Text style={styles.mediaHint} numberOfLines={2}>{preview.detail}</Text>
          </View>
        )}
      </MessageContentOpenButton>
    );
  }

  return (
    <MessageContentOpenButton
      accessibilityLabel={`${preview.actionLabel} ${preview.title}`}
      onPress={onOpen}
      style={[
        styles.mediaPlaceholder,
        {
          minHeight: layout.mediaPlaceholderMinHeight,
          width: layout.mediaPreviewWidth,
        },
      ]}
      testID="message.mediaPreviewButton"
    >
      <Text style={styles.mediaKind}>{preview.meta[0] ?? payloadMediaKindLabel(media.kind)}</Text>
      <Text style={styles.mediaTitle} numberOfLines={1}>{preview.title}</Text>
      <Text style={styles.mediaHint} numberOfLines={2}>
        {preview.detail}
      </Text>
    </MessageContentOpenButton>
  );
}

const FILE_CHIP_TEST_IDS = {
  default: 'message.filePreviewButton',
  pdf: 'message.filePreviewButton.pdf',
  drawio: 'message.filePreviewButton.drawio',
} as const;

const FILE_FALLBACK_STATUS_TEST_IDS = {
  pdf: 'message.fileFallbackStatus.pdf',
  drawio: 'message.fileFallbackStatus.drawio',
  other: 'message.fileFallbackStatus.other',
} as const;

function fileChipTestId(pathOrName: string): string {
  const kind = remoteFilePreviewKind(pathOrName);
  if (kind === 'pdf') return FILE_CHIP_TEST_IDS.pdf;
  if (kind === 'drawio') return FILE_CHIP_TEST_IDS.drawio;
  return FILE_CHIP_TEST_IDS.default;
}

function filePreviewStatusTestId(kind: ReturnType<typeof remoteFilePreviewKind>): string {
  if (kind === 'pdf') return FILE_FALLBACK_STATUS_TEST_IDS.pdf;
  if (kind === 'drawio') return FILE_FALLBACK_STATUS_TEST_IDS.drawio;
  if (kind !== 'text') return FILE_FALLBACK_STATUS_TEST_IDS.other;
  return 'message.filePreviewStatus';
}

function FileChip({
  layout,
  name,
  onOpen,
  path,
}: {
  layout: MessageContentLayout;
  name: string;
  onOpen?: () => void;
  path?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const preview = summarizeMessagePayloadPreview(buildFilePayload(name, path ?? ''));
  return (
    <MessageContentOpenButton
      accessibilityLabel={`${preview.actionLabel} ${name}`}
      onPress={onOpen}
      style={[
        styles.fileChip,
        {
          maxWidth: layout.fileChipMaxWidth,
          minHeight: layout.fileChipMinHeight,
        },
      ]}
      testID={fileChipTestId(path ?? name)}
    >
      <View style={[styles.fileIconFrame, { width: layout.fileChipIconWidth }]}>
        <FileIcon color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
      </View>
      <View style={styles.fileText}>
        <Text style={styles.fileName} numberOfLines={1}>{preview.title}</Text>
      </View>
    </MessageContentOpenButton>
  );
}

function DiffPreview({
  diff,
  layout,
  onOpen,
}: {
  diff: NormalizedToolDiff;
  layout: MessageContentLayout;
  onOpen?: (payload: MessagePayload) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const first = diff.segments[0];
  const payload = buildDiffPayload(diff);
  const preview = summarizeMessagePayloadPreview(payload);
  return (
    <MessageContentOpenButton
      accessibilityLabel={`${preview.actionLabel} ${preview.title}`}
      onPress={onOpen ? () => onOpen(payload) : undefined}
      style={[
        styles.diffCard,
        {
          gap: layout.diffCardGap,
          padding: layout.diffCardPadding,
        },
      ]}
      testID="message.diffPreviewButton"
    >
      <Text style={styles.diffPath} numberOfLines={1}>{preview.title}</Text>
      <Text style={styles.diffStats}>{preview.meta.join(' · ')}</Text>
      {first ? (
        <View style={styles.diffRows}>
          {first.oldString ? (
            <Text style={[styles.diffLine, styles.diffDelete]} numberOfLines={2}>
              - {first.oldString}
            </Text>
          ) : null}
          {first.newString ? (
            <Text style={[styles.diffLine, styles.diffAdd]} numberOfLines={2}>
              + {first.newString}
            </Text>
          ) : null}
        </View>
      ) : null}
      {diff.segments.length > 1 ? (
        <Text style={styles.diffMore}>{t('message.renderer.diffEditCount', { n: diff.segments.length })}</Text>
      ) : null}
    </MessageContentOpenButton>
  );
}

const TOOL_RESULT_PREVIEW_MAX_CHARS = 520;

function ToolResultPreview({
  layout,
  tool,
  onOpen,
}: {
  layout: MessageContentLayout;
  tool: NormalizedRemoteMessage;
  onOpen?: (payload: MessagePayload) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const payload = buildToolResultPayload(tool);
  if (!payload) return null;
  const preview = summarizeMessagePayloadPreview(payload, { maxPreviewChars: TOOL_RESULT_PREVIEW_MAX_CHARS });
  // 「查看内容」hint 只在纯文本结果确实被截断(字符上限或行数上限)时显示——预览已
  // 完整呈现的短结果不需要这行提示(整个框仍可点开全屏)。非 text 类 payload(媒体/
  // diff 等)的 actionLabel 是打开方式说明,保持常显。长单行折行导致的视觉截断检测
  // 不到,漏显 hint 危害低(框可点),不为它引入逐行测量。
  const clipped = payload.body.trim().length > TOOL_RESULT_PREVIEW_MAX_CHARS
    || preview.previewText.split('\n').length > layout.toolResultMaxLines;
  const showHint = payload.kind !== 'text' || clipped;
  return (
    <MessageContentOpenButton
      accessibilityLabel={`${preview.actionLabel} ${preview.title}`}
      onPress={onOpen ? () => onOpen(payload) : undefined}
      style={styles.toolResultPreview}
      testID="message.toolPayloadButton"
    >
      <Text style={styles.toolResult} numberOfLines={layout.toolResultMaxLines}>{preview.previewText}</Text>
      {showHint ? <Text style={styles.toolResultHint}>{preview.actionLabel}</Text> : null}
    </MessageContentOpenButton>
  );
}

function MessageContentOpenButton({
  accessibilityLabel,
  children,
  disabled = false,
  onPress,
  style,
  testID,
}: {
  accessibilityLabel: string;
  children: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const interactionDisabled = disabled || !onPress;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: interactionDisabled }}
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

function MessagePayloadModal({
  payload,
  imageAnnotation,
  onClose,
  onReadTextFilePreview,
  onReleaseRemoteMedia,
  onResolveRemoteMedia,
  onShareImage,
}: {
  payload: MessagePayload | null;
  /** 图表导出图的标注配置(来自聊天 lightbox 的同一份 chatAnnotation)。 */
  imageAnnotation?: ImageLightboxAnnotationConfig;
  onClose(): void;
  onReadTextFilePreview?: (filePath: string) => Promise<RemoteTextFilePreviewResult>;
  onReleaseRemoteMedia?: (sourceUrl: string, media: MobileResolvedRemoteMedia) => void;
  onResolveRemoteMedia?: ResolveRemoteMediaFn;
  onShareImage?: ComponentProps<typeof ImageLightbox>['onShareImage'];
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [payloadCopyState, setPayloadCopyState] = useState<PayloadHeaderCopyState>('idle');
  const payloadCopySeqRef = useRef(0);
  // 沉浸式图表查看器的导出:WebView 内光栅化 → 临时 PNG → 系统分享单
  // (含「存储图像 / 拷贝」,与图片消息同款路径)。
  const [mermaidExporting, setMermaidExporting] = useState(false);
  const mermaidViewRef = useRef<MermaidDiagramWebViewHandle | null>(null);
  // 图表标注:导出图的 lightbox 渲染在**本 Modal 的 children 里**——RN Modal 从
  // 所在组件树的 VC present,挂在外层(session 屏)树里会因该 VC 已 present 本
  // Modal 而挂起排队,表现为「点了没反应,关图表后标注才弹出」。嵌进来后 inner
  // Modal 从本 Modal 的 VC present,真正叠在图表之上;取消回图表,提交两层全关。
  const [annotatePayload, setAnnotatePayload] = useState<Extract<MessagePayload, { kind: 'media' }> | null>(null);
  const closeAnnotatePayload = useCallback(() => setAnnotatePayload(null), []);
  const annotateImages = useMemo(
    () => annotatePayload ? lightboxImagesForPayload([], annotatePayload) : null,
    [annotatePayload],
  );
  const annotateLightboxAnnotation = useMemo<ImageLightboxAnnotationConfig | undefined>(() => {
    if (!imageAnnotation) return undefined;
    return {
      ...imageAnnotation,
      onSubmit: async (image, uri, strokes, ctx) => {
        await imageAnnotation.onSubmit(image, uri, strokes, ctx);
        onClose(); // 提交成功:图表查看器一并关闭,回聊天看托盘
      },
    };
  }, [imageAnnotation, onClose]);
  const payloadSummary = useMemo(
    () => payload ? summarizeMessagePayload(payload) : null,
    [payload],
  );
  const payloadPreview = useMemo(
    () => payload ? summarizeMessagePayloadPreview(payload) : null,
    [payload],
  );
  const payloadDetailText = payloadHeaderDetailText(payloadPreview, payloadSummary?.subtitle);
  const canCopyPayload = !!payloadSummary?.copyableText?.trim();
  const canOpenPayloadUrl = payloadSummary?.openTarget?.kind === 'url'
    && isDirectPreviewableMediaUrl(payloadSummary.openTarget.value);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const safeAreaInsets = useSafeAreaInsets();
  const headerLayout = buildPayloadHeaderLayout({
    canCopy: canCopyPayload,
    canOpen: canOpenPayloadUrl,
    canPageGallery: false, // 图片已走 ImageLightbox,本查看器不再有图库翻页
    screenHeight,
    screenWidth,
  });
  const modalSafeArea = buildPayloadModalSafeArea({
    androidStatusBarHeight: StatusBar.currentHeight ?? 0,
    landscape: headerLayout.landscape,
    platform: Platform.OS,
    safeAreaBottom: safeAreaInsets.bottom,
    safeAreaTop: safeAreaInsets.top,
  });

  useEffect(() => {
    payloadCopySeqRef.current += 1;
    setPayloadCopyState('idle');
  }, [payloadSummary?.copyableText]);

  useEffect(() => {
    if (payloadCopyState === 'idle' || payloadCopyState === 'copying') return;
    const timer = setTimeout(() => setPayloadCopyState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [payloadCopyState]);

  const copyPayload = useCallback(() => {
    const text = payloadSummary?.copyableText ?? '';
    if (!text.trim() || payloadCopyState === 'copying') return;
    const seq = ++payloadCopySeqRef.current;
    setPayloadCopyState('copying');
    void writeClipboardText(text)
      .then(() => {
        if (payloadCopySeqRef.current === seq) setPayloadCopyState('copied');
      })
      .catch(() => {
        if (payloadCopySeqRef.current === seq) setPayloadCopyState('failed');
      });
  }, [payloadCopyState, payloadSummary?.copyableText]);

  const openPayloadUrl = useCallback(() => {
    const target = payloadSummary?.openTarget;
    if (target?.kind !== 'url' || !isDirectPreviewableMediaUrl(target.value)) return;
    void Linking.openURL(target.value).catch(() => undefined);
  }, [payloadSummary?.openTarget]);

  const exportMermaidPng = useCallback(async () => {
    const handle = mermaidViewRef.current;
    if (!handle || mermaidExporting) return;
    setMermaidExporting(true);
    try {
      const base64 = await handle.exportPng();
      const uri = await writeMermaidExportPngTemp(base64);
      if (!uri) throw new Error('write temp failed');
      // 动态 import:expo-sharing 在模块顶层 requireNativeModule('ExpoSharing'),
      // 旧 dev client 缺原生模块时顶层 import 会炸整个 bundle(同 lightbox 先例)。
      const sharing = await import('expo-sharing');
      await sharing.shareAsync(uri, { mimeType: 'image/png' });
    } catch {
      Alert.alert(t('message.renderer.mermaidExportFailedTitle'), t('message.renderer.mermaidRenderIncompleteBody'));
    } finally {
      setMermaidExporting(false);
    }
  }, [mermaidExporting, t]);

  // 标注 / 发送到对话:导出 PNG 后打开嵌套标注 lightbox(见 annotatePayload
  // 注释),标注圆钮、直发进 composer 托盘等能力全部复用图片消息的既有链路。
  const annotateMermaid = useCallback(async () => {
    const handle = mermaidViewRef.current;
    if (!handle || !imageAnnotation || mermaidExporting) return;
    setMermaidExporting(true);
    try {
      const base64 = await handle.exportPng();
      const uri = await writeMermaidExportPngTemp(base64);
      if (!uri) throw new Error('write temp failed');
      setAnnotatePayload(buildMediaPayload(
        { kind: 'image', url: uri, previewable: true, title: t('message.renderer.mermaidDiagramTitle') },
        t('message.renderer.mermaidDiagramTitle'),
      ));
    } catch {
      Alert.alert(t('message.renderer.mermaidAnnotateFailedTitle'), t('message.renderer.mermaidRenderIncompleteBody'));
    } finally {
      setMermaidExporting(false);
    }
  }, [mermaidExporting, imageAnnotation, t]);

  // mermaid 走沉浸式全屏查看器:图表铺满整个 Modal(标题与源码区都不渲染,
  // 图表最大化优先),仅右上角浮动「复制源码 / 关闭」;源码用复制按钮获取。
  const immersiveMermaid = payload?.kind === 'mermaid';

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      supportedOrientations={['portrait', 'landscape']}
      visible={!!payload}
    >
      {immersiveMermaid && payload ? (
        <View style={styles.payloadModal} testID="message.payloadModal">
          <MermaidDiagramWebView
            bare
            deferSource
            fill
            ref={mermaidViewRef}
            source={payload.body}
            testID="message.payloadMermaidDiagram"
            zoomable
          />
          <View style={[styles.payloadFloatingActions, { top: modalSafeArea.paddingTop }]}>
            {imageAnnotation ? (
              <PayloadHeaderActionButton
                accessibilityLabel={t('message.renderer.annotateSendToChat')}
                disabled={mermaidExporting}
                onPress={() => { void annotateMermaid(); }}
                style={[styles.payloadHeaderButton, styles.payloadFloatingButton]}
                testID="message.payloadAnnotateButton"
              >
                <PencilLine color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.regular} />
              </PayloadHeaderActionButton>
            ) : null}
            <PayloadHeaderActionButton
              accessibilityLabel={t('message.renderer.exportDiagramImage')}
              disabled={mermaidExporting}
              onPress={() => { void exportMermaidPng(); }}
              style={[styles.payloadHeaderButton, styles.payloadFloatingButton]}
              testID="message.payloadExportButton"
            >
              {mermaidExporting ? (
                <ActivityIndicator color={colors.textSecondary} size="small" />
              ) : (
                <ShareIcon color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.regular} />
              )}
            </PayloadHeaderActionButton>
            <PayloadHeaderActionButton
              accessibilityLabel={t('message.renderer.closeDetail')}
              onPress={onClose}
              style={[styles.payloadCloseButton, styles.payloadFloatingButton]}
              testID="message.payloadCloseButton"
            >
              <X color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
            </PayloadHeaderActionButton>
          </View>
          {annotatePayload && annotateImages ? (
            // 嵌套标注层:必须渲染在本 Modal 的 children 内(见 annotatePayload 注释)。
            <ImageLightbox
              annotation={annotateLightboxAnnotation}
              images={annotateImages}
              initialUrl={annotatePayload.media.url}
              onClose={closeAnnotatePayload}
              onResolveRemoteMedia={onResolveRemoteMedia}
              onShareImage={onShareImage}
            />
          ) : null}
        </View>
      ) : (
      <View
        style={[
          styles.payloadModal,
          {
            paddingBottom: modalSafeArea.paddingBottom,
            paddingTop: modalSafeArea.paddingTop,
          },
        ]}
        testID="message.payloadModal"
      >
        <View
          style={[
            styles.payloadHeader,
            {
              // 横屏压成紧凑单行(标题/按钮垂直居中),纵向空间全部让给 body。
              alignItems: headerLayout.landscape ? 'center' : 'flex-start',
              flexDirection: headerLayout.headerDirection,
              gap: headerLayout.headerGap,
              minHeight: headerLayout.headerMinHeight,
              paddingHorizontal: headerLayout.headerPaddingHorizontal,
            },
          ]}
          testID="message.payloadViewerHeader"
        >
          <View style={styles.payloadHeaderText}>
            <Text style={styles.payloadTitle} numberOfLines={headerLayout.titleNumberOfLines}>{payloadSummary?.title ?? ''}</Text>
            {payloadDetailText && headerLayout.showSubtitle ? (
              <Text style={styles.payloadGalleryCount} numberOfLines={1} testID="message.payloadSubtitle">
                {payloadDetailText}
              </Text>
            ) : null}
          </View>
          <View
            style={[
              styles.payloadHeaderActions,
              {
                alignItems: headerLayout.actionsAlignItems,
                flexDirection: headerLayout.actionsDirection,
                width: headerLayout.actionsWidth,
              },
            ]}
          >
            <View
              style={[
                styles.payloadHeaderPrimaryActions,
                {
                  gap: headerLayout.actionGap,
                  justifyContent: headerLayout.primaryActionsJustifyContent,
                },
              ]}
            >
              {canCopyPayload ? (
                <PayloadHeaderActionButton
                  accessibilityLabel={t('message.renderer.copyDetailContent')}
                  disabled={payloadCopyState === 'copying'}
                  onPress={copyPayload}
                  style={[
                    styles.payloadHeaderButton,
                    { minWidth: headerLayout.actionButtonMinWidth },
                  ]}
                  testID="message.payloadCopyButton"
                >
                  {payloadCopyState === 'copying' ? (
                    <ActivityIndicator color={colors.textSecondary} size="small" />
                  ) : payloadCopyState === 'copied' ? (
                    <Check color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                  ) : (
                    <Copy color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                  )}
                </PayloadHeaderActionButton>
              ) : null}
              {canOpenPayloadUrl ? (
                <PayloadHeaderActionButton
                  accessibilityLabel={t('message.renderer.openDetailLink')}
                  onPress={openPayloadUrl}
                  style={[
                    styles.payloadHeaderButton,
                    { minWidth: headerLayout.actionButtonMinWidth },
                  ]}
                  testID="message.payloadOpenButton"
                >
                  <ExternalLink color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                </PayloadHeaderActionButton>
              ) : null}
            </View>
            {payloadCopyState === 'copied' || payloadCopyState === 'failed' ? (
              <Text style={styles.payloadHeaderStatus} testID="message.payloadCopyStatus">
                {payloadCopyState === 'copied' ? t('message.renderer.copyStateCopied') : t('message.renderer.copyStateFailed')}
              </Text>
            ) : null}
            <PayloadHeaderActionButton
              accessibilityLabel={t('message.renderer.closeDetail')}
              onPress={onClose}
              style={[
                styles.payloadCloseButton,
                { minWidth: headerLayout.closeButtonMinWidth },
              ]}
              testID="message.payloadCloseButton"
            >
              <X color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
            </PayloadHeaderActionButton>
          </View>
        </View>
        {payload ? (
          <View style={styles.payloadViewerBody} testID="message.payloadViewerBody">
            <MessagePayloadBody
              onReadTextFilePreview={onReadTextFilePreview}
              onReleaseRemoteMedia={onReleaseRemoteMedia}
              onResolveRemoteMedia={onResolveRemoteMedia}
              payload={payload}
            />
          </View>
        ) : null}
      </View>
      )}
    </Modal>
  );
}

type RemoteMediaState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; media: MobileResolvedRemoteMedia }
  | { status: 'error'; message: string };

type PayloadHeaderCopyState = 'idle' | 'copying' | 'copied' | 'failed';

function PayloadHeaderActionButton({
  accessibilityLabel,
  children,
  disabled = false,
  onPress,
  style,
  testID,
}: {
  accessibilityLabel: string;
  children: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const interactionDisabled = disabled || !onPress;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: interactionDisabled }}
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

function payloadHeaderDetailText(
  preview: MessagePayloadPreview | null,
  fallback?: string,
): string | undefined {
  if (!preview) return fallback;
  if (preview.kind === 'diff') return fallback || preview.detail;
  return preview.detail || fallback;
}

function MessagePayloadBody({
  payload,
  onReadTextFilePreview,
  onReleaseRemoteMedia,
  onResolveRemoteMedia,
}: {
  payload: MessagePayload;
  onReadTextFilePreview?: (filePath: string) => Promise<RemoteTextFilePreviewResult>;
  onReleaseRemoteMedia?: (sourceUrl: string, media: MobileResolvedRemoteMedia) => void;
  onResolveRemoteMedia?: ResolveRemoteMediaFn;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { width: screenWidth } = useWindowDimensions();
  const [remoteState, setRemoteState] = useState<RemoteMediaState>({ status: 'idle' });
  const [playerStatus, setPlayerStatus] = useState<MobileMediaPlayerStatus | null>(null);
  const resolvedRemoteMediaRef = useRef<MobileResolvedRemoteMedia | null>(null);
  const bodyPresentation = useMemo(() => summarizeMessagePayloadBody(payload), [payload]);
  const payloadLayout = useMemo(() => buildPayloadBodyLayout({
    kind: payload.kind,
    screenWidth,
  }), [payload.kind, screenWidth]);
  const remoteMedia = payload.kind === 'media' && !payload.media.previewable && isDesktopLocalMediaUrl(payload.media.url)
    ? payload.media
    : null;
  const mediaPlayerSourceKey = payload.kind === 'media'
    ? `${payload.media.kind}:${remoteState.status === 'ready' ? remoteState.media.url : payload.media.url}`
    : '';
  // forceRefresh:重试按钮显式重试时穿透取件队列的 20s 负缓存(挂载取件不传)。
  const resolve = useCallback((forceRefresh = false) => {
    if (!remoteMedia || !onResolveRemoteMedia) return;
    let cancelled = false;
    setRemoteState({ status: 'loading' });
    // 用户主动打开的原图插队头,优先于列表缩略图的懒取件。
    void onResolveRemoteMedia(remoteMedia, { front: true, forceRefresh })
      .then((media) => {
        if (!cancelled) setRemoteState({ status: 'ready', media });
      })
      .catch((err) => {
        if (!cancelled) setRemoteState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [onResolveRemoteMedia, remoteMedia]);

  useEffect(() => {
    setRemoteState({ status: 'idle' });
    resolvedRemoteMediaRef.current = null;
    return resolve();
  }, [resolve]);

  useEffect(() => {
    setPlayerStatus(null);
  }, [mediaPlayerSourceKey]);

  useEffect(() => {
    if (remoteState.status === 'ready') {
      resolvedRemoteMediaRef.current = remoteState.media;
    }
  }, [remoteState]);

  useEffect(() => () => {
    const resolved = resolvedRemoteMediaRef.current;
    // image 不再关闭即删:缩略图常驻列表共用同一 OSS 对象,删了会把列表缩略图弄坏,
    // 改为退出会话屏时统一清理(见 [sessionId].tsx)。video/audio 保持关闭即删。
    if (remoteMedia?.url && resolved && remoteMedia.kind !== 'image') {
      onReleaseRemoteMedia?.(remoteMedia.url, resolved);
    }
  }, [onReleaseRemoteMedia, remoteMedia?.kind, remoteMedia?.url]);

  if (payload.kind === 'media') {
    const resolved = remoteState.status === 'ready' ? remoteState.media : null;
    const displayUrl = resolved?.url ?? payload.media.url;
    // 图片 payload 已分流到 ImageLightbox 全屏查看器,本查看器只承载 video/audio/其它媒体。
    const playerKind = payload.media.kind === 'video' || payload.media.kind === 'audio' ? payload.media.kind : null;
    const canInlinePlayer = playerKind !== null
      && isDirectPreviewableMediaUrl(displayUrl)
      && ((bodyPresentation.media?.canInlineDirectPlayer ?? false) || resolved?.previewable);
    const canOpenUrl = isDirectPreviewableMediaUrl(displayUrl);
    return (
      <View style={styles.payloadBody}>
        {canInlinePlayer && playerKind ? (
          <View style={[styles.payloadMediaPlayerFrame, { minHeight: payloadLayout.mediaFrameMinHeight }]}>
            <RemoteMediaPlayerWebView
              kind={playerKind}
              mimeType={resolved?.mimeType}
              onStatusChange={setPlayerStatus}
              style={[styles.payloadMediaPlayer, { minHeight: payloadLayout.mediaPlayerMinHeight }]}
              testID="message.remoteMediaPlayer"
              title={payload.title}
              url={displayUrl}
            />
            <Text style={styles.payloadMediaPlayerStatus} testID="message.remoteMediaPlayerStatus">
              {formatMediaPlayerStatus(playerStatus, playerKind)}
            </Text>
          </View>
        ) : (
          <View style={[
            styles.payloadMediaPlaceholder,
            {
              minHeight: payloadLayout.mediaPlaceholderMinHeight,
              padding: payloadLayout.bodyPadding,
            },
          ]}>
            <Text style={styles.payloadMediaKind}>{bodyPresentation.media?.kindLabel ?? payloadMediaKindLabel(payload.media.kind)}</Text>
            {remoteState.status === 'loading' ? <ActivityIndicator color={colors.textSecondary} /> : null}
            <Text style={styles.payloadMediaHint}>
              {remoteMedia
                ? remoteMediaStatusText(remoteState, bodyPresentation.media?.remoteIdleText)
                : bodyPresentation.media?.unsupportedText ?? t('message.renderer.mediaNotPreviewable')}
            </Text>
            {remoteState.status === 'error' && remoteMedia && onResolveRemoteMedia ? (
              <PayloadActionButton
                accessibilityLabel={t('message.renderer.retryRemoteMediaFetch')}
                label={t('message.renderer.retryFetch')}
                // 不能直接 onPress={resolve}:Pressable 会把事件对象塞进 forceRefresh 参数
                onPress={() => {
                  resolve(true);
                }}
                layout={payloadLayout}
                testID="message.remoteMediaRetryButton"
              />
            ) : null}
            {canOpenUrl ? (
              <PayloadActionButton
                accessibilityLabel={t('message.renderer.openMedia')}
                label={t('message.renderer.openMedia')}
                onPress={() => {
                  void Linking.openURL(displayUrl).catch(() => undefined);
                }}
                layout={payloadLayout}
                testID="message.remoteMediaOpenButton"
              />
            ) : null}
          </View>
        )}
        <ScrollView
          style={[styles.payloadScroll, { maxHeight: payloadLayout.textScrollMaxHeight }]}
          contentContainerStyle={[styles.payloadScrollContent, { padding: payloadLayout.bodyPadding }]}
        >
          <Text selectable style={styles.payloadText}>
            {formatMediaPayloadBody(payload, resolved, remoteState, bodyPresentation.bodyText)}
          </Text>
        </ScrollView>
      </View>
    );
  }

  if (payload.kind === 'file') {
    return (
      <FilePayloadBody
        layout={payloadLayout}
        onReadTextFilePreview={onReadTextFilePreview}
        payload={payload}
      />
    );
  }

  // mermaid 不经过本组件:MessagePayloadModal 里走沉浸式全屏查看器分支。

  if (payload.kind === 'diff') {
    return (
      <DiffPayloadBody
        diff={payload.diff}
        layout={payloadLayout}
        onReadTextFilePreview={onReadTextFilePreview}
      />
    );
  }

  return (
    <ScrollView
      style={styles.payloadBody}
      contentContainerStyle={[styles.payloadScrollContent, { padding: payloadLayout.bodyPadding }]}
    >
      <Text selectable style={styles.payloadText}>{bodyPresentation.bodyText || bodyPresentation.emptyText}</Text>
    </ScrollView>
  );
}

function DiffPayloadBody({
  diff,
  layout,
  onReadTextFilePreview,
}: {
  diff: NormalizedToolDiff;
  layout: PayloadBodyLayout;
  onReadTextFilePreview?: (filePath: string) => Promise<RemoteTextFilePreviewResult>;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const view = useMemo(() => formatDiffPayloadView(diff), [diff]);
  const [filePreviewVisible, setFilePreviewVisible] = useState(false);
  const { canPreview, loadPreview, previewKind, previewState } = useRemoteTextFilePreview(view.filePath, onReadTextFilePreview);
  const openFilePreview = useCallback(() => {
    setFilePreviewVisible(true);
    loadPreview();
  }, [loadPreview]);

  return (
    <View style={styles.payloadBody} testID="message.diffPayloadBody">
      <View style={[styles.payloadDiffHeaderBlock, { padding: layout.bodyPadding }]}>
        <Text selectable style={styles.payloadDiffPath} numberOfLines={2}>
          {view.filePath}
        </Text>
        <Text style={styles.payloadDiffStats}>{view.stats}</Text>
        <PayloadPathActions layout={layout} path={view.filePath}>
          {canPreview ? (
            <PayloadActionButton
              accessibilityLabel={t('message.renderer.readCurrentRemoteFile')}
              disabled={previewState.status === 'loading'}
              label={previewState.status === 'loading'
                ? t('message.renderer.reading')
                : previewState.status === 'unavailable'
                  ? t('message.renderer.retryFilePreview')
                  : t('message.renderer.readCurrentFile')}
              layout={layout}
              onPress={openFilePreview}
              testID="message.diffFilePreviewLoadButton"
            />
          ) : null}
        </PayloadPathActions>
      </View>
      {filePreviewVisible ? (
        <View
          style={[
            styles.payloadDiffFilePreviewBlock,
            {
              gap: layout.diffContentGap,
              padding: layout.bodyPadding,
            },
          ]}
          testID="message.diffFilePreviewBlock"
        >
          <Text style={styles.payloadDiffSectionTitle}>{t('message.renderer.currentFilePreview')}</Text>
          {previewState.status === 'loading' ? <ActivityIndicator color={colors.textSecondary} /> : null}
          <Text
            style={styles.payloadMediaHint}
            testID={previewState.status === 'ready' ? 'message.diffFilePreviewReady' : 'message.diffFilePreviewStatus'}
          >
            {textPreviewStatusText(previewState, canPreview, previewKind)}
          </Text>
          <ScrollView
            style={[styles.payloadDiffFilePreviewScroll, { maxHeight: layout.filePreviewMaxHeight }]}
            contentContainerStyle={[styles.payloadScrollContent, { padding: layout.bodyPadding }]}
          >
            <Text selectable style={[styles.payloadText, styles.payloadMonoText]} testID="message.diffFilePreviewText">
              {previewState.status === 'ready'
                ? previewState.data
                : textPreviewStatusText(previewState, canPreview, previewKind)}
            </Text>
          </ScrollView>
        </View>
      ) : null}
      <ScrollView
        style={styles.payloadDiffScroll}
        contentContainerStyle={[
          styles.payloadDiffContent,
          {
            gap: layout.diffContentGap,
            padding: layout.bodyPadding,
          },
        ]}
      >
        {view.sections.map((section) => (
          <View key={section.key} style={styles.payloadDiffSection} testID="message.diffCompareSection">
            <Text style={styles.payloadDiffSectionTitle}>{section.label}</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator
              style={styles.payloadDiffCompareScroll}
              testID="message.diffCompareScroll"
            >
              <View style={[
                styles.payloadDiffCompareRow,
                {
                  gap: layout.diffPaneGap,
                  paddingBottom: layout.diffContentGap,
                },
              ]}>
                <DiffPayloadPane
                  emptyText={t('message.renderer.diffNoOldContent')}
                  layout={layout}
                  lines={section.oldLines}
                  prefix="-"
                  testID="message.diffCompareOldPane"
                  title={t('message.renderer.diffOldTitle')}
                  variant="old"
                />
                <DiffPayloadPane
                  emptyText={t('message.renderer.diffNoNewContent')}
                  layout={layout}
                  lines={section.newLines}
                  prefix="+"
                  testID="message.diffCompareNewPane"
                  title={t('message.renderer.diffNewTitle')}
                  variant="new"
                />
              </View>
            </ScrollView>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function DiffPayloadPane({
  emptyText,
  layout,
  lines,
  prefix,
  testID,
  title,
  variant,
}: {
  emptyText: string;
  layout: PayloadBodyLayout;
  lines: FormattedDiffPayloadLine[];
  prefix: '-' | '+';
  testID: string;
  title: string;
  variant: 'old' | 'new';
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.payloadDiffPane, { width: layout.diffPaneWidth }]} testID={testID}>
      <View style={styles.payloadDiffPaneHeader}>
        <Text style={styles.payloadDiffPaneTitle}>{title}</Text>
      </View>
      <View style={styles.payloadDiffPaneBody}>
        {lines.length > 0 ? lines.map((line) => (
          <View
            key={line.key}
            style={[
              styles.payloadDiffCompareLine,
              { minHeight: layout.diffLineMinHeight },
              variant === 'old' ? styles.payloadDiffCompareLineOld : styles.payloadDiffCompareLineNew,
            ]}
            testID={variant === 'old' ? 'message.diffPayloadRow.delete' : 'message.diffPayloadRow.add'}
          >
            <Text style={[styles.payloadDiffLineNumber, { width: layout.diffLineNumberWidth }]}>{line.lineNumber}</Text>
            <Text style={[
              styles.payloadDiffLinePrefix,
              { width: layout.diffLinePrefixWidth },
              variant === 'old' ? styles.payloadDiffLinePrefixOld : styles.payloadDiffLinePrefixNew,
            ]}>
              {prefix}
            </Text>
            <Text selectable style={[
              styles.payloadDiffLineText,
              variant === 'old' ? styles.payloadDiffLineTextOld : styles.payloadDiffLineTextNew,
            ]} testID={variant === 'old' ? 'message.diffCompareOldLine' : 'message.diffCompareNewLine'}>
              {line.text || ' '}
            </Text>
          </View>
        )) : (
          <Text style={styles.payloadDiffEmptyLine}>{emptyText}</Text>
        )}
      </View>
    </View>
  );
}

function FilePayloadBody({
  layout,
  payload,
  onReadTextFilePreview,
}: {
  layout: PayloadBodyLayout;
  payload: Extract<MessagePayload, { kind: 'file' }>;
  onReadTextFilePreview?: (filePath: string) => Promise<RemoteTextFilePreviewResult>;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const sourcePath = payload.sourcePath ?? '';
  const bodyPresentation = useMemo(() => summarizeMessagePayloadBody(payload), [payload]);
  const { canPreview, loadPreview, previewKind, previewState } = useRemoteTextFilePreview(sourcePath, onReadTextFilePreview);

  return (
    <View style={styles.payloadBody} testID="message.filePayloadBody">
      <View style={[
        styles.payloadMediaPlaceholder,
        {
          minHeight: layout.mediaPlaceholderMinHeight,
          padding: layout.bodyPadding,
        },
      ]}>
        <Text style={styles.payloadMediaKind}>{t('message.renderer.fileKind')}</Text>
        <Text selectable style={styles.payloadText}>
          {bodyPresentation.file?.displayPath ?? bodyPresentation.emptyText}
        </Text>
        {previewState.status === 'loading' ? <ActivityIndicator color={colors.textSecondary} /> : null}
        <Text style={styles.payloadMediaHint} testID={filePreviewStatusTestId(previewKind)}>
          {textPreviewStatusText(previewState, canPreview, previewKind)}
        </Text>
        <PayloadPathActions layout={layout} path={sourcePath}>
          {canPreview && previewState.status !== 'ready' ? (
            <PayloadActionButton
              accessibilityLabel={t('message.renderer.loadRemoteTextPreview')}
              disabled={previewState.status === 'loading'}
              label={previewState.status === 'loading' ? t('message.renderer.loading') : previewState.status === 'unavailable' ? t('message.renderer.retryPreview') : t('message.renderer.loadPreview')}
              layout={layout}
              onPress={loadPreview}
              testID="message.filePreviewLoadButton"
            />
          ) : null}
        </PayloadPathActions>
      </View>
      <ScrollView
        style={[styles.payloadScroll, { maxHeight: layout.textScrollMaxHeight }]}
        contentContainerStyle={[styles.payloadScrollContent, { padding: layout.bodyPadding }]}
      >
        <Text selectable style={[styles.payloadText, styles.payloadMonoText]} testID="message.filePreviewText">
          {previewState.status === 'ready' ? previewState.data : bodyPresentation.bodyText || bodyPresentation.emptyText}
        </Text>
      </ScrollView>
    </View>
  );
}

function useRemoteTextFilePreview(
  sourcePath: string,
  onReadTextFilePreview?: (filePath: string) => Promise<RemoteTextFilePreviewResult>,
) {
  const [previewState, setPreviewState] = useState<TextFilePreviewState>({ status: 'idle' });
  const previewSeqRef = useRef(0);
  const previewKind = useMemo(() => remoteFilePreviewKind(sourcePath), [sourcePath]);
  const canPreview = previewKind === 'text' && !!sourcePath && !!onReadTextFilePreview;

  useEffect(() => {
    previewSeqRef.current += 1;
    setPreviewState({ status: 'idle' });
  }, [sourcePath]);

  const loadPreview = useCallback(() => {
    if (!canPreview || previewState.status === 'loading') return;
    const seq = ++previewSeqRef.current;
    setPreviewState({ status: 'loading' });
    void onReadTextFilePreview(sourcePath)
      .then((result) => {
        if (previewSeqRef.current !== seq) return;
        if (result.success && typeof result.data === 'string') {
          setPreviewState({
            status: 'ready',
            data: result.data,
            size: result.size,
            limitMb: result.limitMb,
          });
          return;
        }
        setPreviewState({
          status: 'unavailable',
          message: describeTextPreviewFailure(result),
          size: result.size,
          limitMb: result.limitMb,
        });
      })
      .catch((err) => {
        if (previewSeqRef.current !== seq) return;
        setPreviewState({
          status: 'unavailable',
          message: err instanceof Error ? err.message : String(err),
          size: 0,
        });
      });
  }, [canPreview, onReadTextFilePreview, previewState.status, sourcePath]);

  return { canPreview, loadPreview, previewKind, previewState };
}

type PayloadPathCopyState = 'idle' | 'copying' | 'copied' | 'failed';

function PayloadPathActions({
  children,
  layout,
  path,
}: {
  children?: ReactNode;
  layout: PayloadBodyLayout;
  path: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<PayloadPathCopyState>('idle');
  const copySeqRef = useRef(0);
  const canCopy = path.trim().length > 0;

  useEffect(() => {
    copySeqRef.current += 1;
    setCopyState('idle');
  }, [path]);

  useEffect(() => {
    if (copyState === 'idle' || copyState === 'copying') return;
    const timer = setTimeout(() => setCopyState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [copyState]);

  const copyPath = useCallback(() => {
    if (!canCopy || copyState === 'copying') return;
    const seq = ++copySeqRef.current;
    setCopyState('copying');
    void writeClipboardText(path)
      .then(() => {
        if (copySeqRef.current === seq) setCopyState('copied');
      })
      .catch(() => {
        if (copySeqRef.current === seq) setCopyState('failed');
      });
  }, [canCopy, copyState, path]);

  if (!canCopy && !children) return null;

  return (
    <View style={styles.payloadActionBlock}>
      <View style={[styles.payloadActionRow, { gap: layout.actionGap }]} testID="message.payloadPathActions">
        {canCopy ? (
          <PayloadActionButton
            accessibilityLabel={t('message.renderer.copyRemoteFilePath')}
            disabled={copyState === 'copying'}
            label={copyState === 'copying' ? t('message.renderer.copyStateCopying') : t('message.renderer.copyPath')}
            layout={layout}
            onPress={copyPath}
            testID="message.copyFilePathButton"
          />
        ) : null}
        {children}
      </View>
      {copyState === 'copied' || copyState === 'failed' ? (
        <Text style={styles.payloadPathCopyStatus} testID="message.copyFilePathStatus">
          {copyState === 'copied' ? t('message.renderer.copiedPath') : t('message.renderer.copyPathFailed')}
        </Text>
      ) : null}
    </View>
  );
}

function PayloadActionButton({
  accessibilityLabel,
  disabled = false,
  label,
  layout,
  onPress,
  testID,
}: {
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  layout: PayloadBodyLayout;
  onPress(): void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.payloadOpenButton,
        {
          minHeight: layout.actionButtonMinHeight,
          minWidth: layout.actionButtonMinWidth,
        },
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <Text style={styles.payloadOpenButtonText}>{label}</Text>
    </Pressable>
  );
}

function remoteMediaStatusText(state: RemoteMediaState, idleText = i18n.t('message.renderer.remoteMediaIdle')): string {
  if (state.status === 'loading') return i18n.t('message.renderer.remoteMediaLoading');
  if (state.status === 'ready') {
    const size = formatRemoteMediaSize(state.media.size);
    return [i18n.t('message.renderer.remoteMediaReady'), state.media.mimeType, size].filter(Boolean).join(' · ');
  }
  if (state.status === 'error') return i18n.t('message.renderer.remoteMediaFetchFailed', { message: state.message });
  return idleText;
}

function formatMediaPlayerStatus(
  status: MobileMediaPlayerStatus | null,
  kind: MobileMediaPlayerKind,
): string {
  const label = payloadMediaKindLabel(kind);
  if (!status) return i18n.t('message.renderer.mediaPending', { label });
  const progress = formatMediaPlayerProgress(status);
  switch (status.state) {
    case 'ready':
      return i18n.t('message.renderer.mediaLoaded', { label, progress });
    case 'playing':
      return i18n.t('message.renderer.mediaPlaying', { label, progress });
    case 'paused':
      return i18n.t('message.renderer.mediaPaused', { label, progress });
    case 'waiting':
      return i18n.t('message.renderer.mediaBuffering', { label, progress });
    case 'ended':
      return i18n.t('message.renderer.mediaEnded', { label, progress });
    case 'error':
      return i18n.t('message.renderer.mediaError', { label, error: status.error ? `: ${status.error}` : '' });
  }
}

function formatMediaPlayerProgress(status: MobileMediaPlayerStatus): string {
  if (typeof status.currentTime !== 'number' && typeof status.duration !== 'number') return '';
  const current = formatMediaPlayerTime(status.currentTime ?? 0);
  return typeof status.duration === 'number'
    ? ` · ${current} / ${formatMediaPlayerTime(status.duration)}`
    : ` · ${current}`;
}

function formatMediaPlayerTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(safeSeconds / 3600);
  const mm = Math.floor((safeSeconds % 3600) / 60);
  const ss = safeSeconds % 60;
  if (hh > 0) return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

function formatMediaPayloadBody(
  payload: Extract<MessagePayload, { kind: 'media' }>,
  resolved: MobileResolvedRemoteMedia | null,
  state: RemoteMediaState,
  bodyText: string,
): string {
  const lines = [
    bodyText.trim() || i18n.t('message.renderer.mediaSourceUrl', { url: payload.media.url }),
  ];
  if (resolved) {
    const size = formatRemoteMediaSize(resolved.size);
    lines.push(
      i18n.t('message.renderer.mediaDownloadUrl', { url: resolved.url }),
      `MIME: ${resolved.mimeType}`,
      size ? i18n.t('message.renderer.mediaSize', { size }) : '',
      i18n.t('message.renderer.mediaExpiresAt', { time: resolved.expiresAt }),
    );
  } else if (state.status === 'error') {
    lines.push(i18n.t('message.renderer.mediaErrorLine', { message: state.message }));
  } else if (!payload.media.previewable && !bodyText.trim()) {
    lines.push(i18n.t('message.renderer.mediaDeviceLinkHint'));
  }
  return lines.filter(Boolean).join('\n');
}

function MessageControlButton({
  buttonSize,
  copyState,
  disabled,
  id,
  iconSize,
  onPress,
}: {
  buttonSize: number;
  copyState: CopyMessageStatus | 'idle' | 'copying';
  disabled?: boolean;
  id: MobileMessageControlActionId;
  iconSize: number;
  onPress(): void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityLabel={messageControlActionLabel(id, copyState)}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      hitSlop={MESSAGE_CONTROL_HIT_SLOP}
      onPress={onPress}
      style={({ pressed }) => [
        styles.messageIconAction,
        { height: buttonSize, width: buttonSize },
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={messageControlActionTestID(id)}
    >
      {messageControlActionIcon(id, copyState, iconSize, colors)}
    </Pressable>
  );
}

function MessageMoreButton({
  buttonSize,
  disabled,
  iconSize: size,
  onPress,
}: {
  buttonSize: number;
  disabled?: boolean;
  iconSize: number;
  onPress(): void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityLabel="更多消息操作"
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      hitSlop={MESSAGE_CONTROL_HIT_SLOP}
      onPress={onPress}
      style={({ pressed }) => [
        styles.messageIconAction,
        { height: buttonSize, width: buttonSize },
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID="message.moreButton"
    >
      <Ellipsis color={colors.textSecondary} size={size} strokeWidth={iconStroke.regular} />
    </Pressable>
  );
}

function isMessageControlActionId(id: MessageActionBarItemId): id is 'copy' {
  return id === 'copy';
}

function messageControlActionLabel(
  id: MobileMessageControlActionId,
  copyState: CopyMessageStatus | 'idle' | 'copying',
): string {
  if (id === 'copy') return copyActionLabel(copyState);
  if (id === 'delete') return i18n.t('message.renderer.controlDelete');
  if (id === 'rewind') return i18n.t('message.renderer.controlRewind');
  return i18n.t('message.renderer.controlFork');
}

function messageControlActionTestID(id: MobileMessageControlActionId): string {
  if (id === 'copy') return 'message.copyButton';
  if (id === 'delete') return 'message.deleteButton';
  if (id === 'rewind') return 'message.rewindButton';
  return 'message.forkButton';
}

function messageControlActionIcon(
  id: MobileMessageControlActionId,
  copyState: CopyMessageStatus | 'idle' | 'copying',
  iconSize: number,
  colors: ThemeColors,
): ReactNode {
  if (id === 'copy') {
    return copyState === 'copying'
      ? <ActivityIndicator color={colors.textSecondary} size="small" />
      : copyState === 'copied'
        ? <Check color={colors.textSecondary} size={iconSize} strokeWidth={iconStroke.regular} />
        : <Copy color={colors.textSecondary} size={iconSize} strokeWidth={iconStroke.regular} />;
  }
  if (id === 'delete') return <Trash2 color={colors.textSecondary} size={iconSize} strokeWidth={iconStroke.regular} />;
  if (id === 'rewind') return <Undo2 color={colors.textSecondary} size={iconSize} strokeWidth={iconStroke.regular} />;
  return <Split color={colors.textSecondary} size={iconSize} strokeWidth={iconStroke.regular} />;
}

function mediaLabel(media: NormalizedToolMedia): string {
  const tail = media.url.split('/').pop() || media.url;
  return media.title || tail;
}

function findFirstUserMessageClientId(items: readonly MobileMessageRenderItem[]): string | undefined {
  for (const item of items) {
    const found = findFirstUserMessageClientIdInItem(item);
    if (found) return found;
  }
  return undefined;
}

function findFirstUserMessageClientIdInItem(
  item: MobileMessageRenderItem | MobileWorkChildItem,
): string | undefined {
  if (item.type === 'message' && item.message.kind === 'user') return messageClientId(item);
  if (item.type === 'work_group') {
    for (const child of item.children) {
      const found = findFirstUserMessageClientIdInItem(child);
      if (found) return found;
    }
  }
  return undefined;
}

function messageClientId(item: MobileMessageItem): string {
  return item.message.source.clientId || item.message.source.id || item.message.key;
}

/** 语法 kind → 样式。plain 不走这里(直接当字符串塞进父 Text,少一层节点)。 */
function syntaxStyleFor(
  styles: ReturnType<typeof makeStyles>,
  kind: Exclude<CodeTokenKind, 'plain'>,
): StyleProp<TextStyle> {
  switch (kind) {
    case 'keyword': return styles.syntaxKeyword;
    case 'string': return styles.syntaxString;
    case 'comment': return styles.syntaxComment;
    case 'number': return styles.syntaxNumber;
    case 'function': return styles.syntaxFunction;
    case 'property': return styles.syntaxProperty;
  }
}

/**
 * 代码块正文 —— 按 language 做词法着色(配色对齐桌面的 GitHub hljs 主题)。
 *
 * 抽成组件只为拿 useMemo:renderBlock 每次重渲都会走到,大代码块重复分词不划算。
 * 嵌套 span 只带 color,其余样式继承外层 markdownCodeText。
 *
 * ⚠️ `SpanComponent` 必须由调用方经 `spanFor()` 给出,不能图省事直接用 RN 的
 * `Text`:块可选中且在 iOS 时外层是 UITextView,而它只接受 UITextView 家族的子
 * 节点 —— 传普通 Text 的话那些 span 会被整个丢掉(表现为代码里的属性名、关键字
 * 直接从画面上消失,不报错)。
 */
function HighlightedCodeText({
  SpanComponent,
  allowIosUITextView,
  language,
  selectable,
  selectionColor,
  styles,
  text,
}: {
  SpanComponent: typeof Text;
  allowIosUITextView: boolean;
  language: string | undefined;
  selectable: boolean;
  selectionColor: string;
  styles: ReturnType<typeof makeStyles>;
  text: string;
}) {
  const tokens = useMemo(() => tokenizeCode(text, language), [language, text]);
  return (
    <MarkdownSelectableText
      allowIosUITextView={allowIosUITextView}
      selectable={selectable}
      selectionColor={selectionColor}
      style={styles.markdownCodeText}
    >
      {tokens.map((token, index) => (
        token.kind === 'plain'
          ? token.text
          : (
            <SpanComponent key={index} style={syntaxStyleFor(styles, token.kind)}>
              {token.text}
            </SpanComponent>
          )
      ))}
    </MarkdownSelectableText>
  );
}

/**
 * markdown 标题的字号档:h1 / h2 / h3+ 三档(见 markdownHeading* 的比例说明)。
 * 两处渲染路径(text_run 合并树与独立 heading 块)共用,避免再次分叉成
 * 「level <= 2 一刀切」那种只有两档、且第二档比正文还小的形态。
 */
function headingSizeStyle(
  styles: ReturnType<typeof makeStyles>,
  level: number,
): StyleProp<TextStyle> {
  if (level <= 1) return styles.markdownHeadingLarge;
  if (level === 2) return styles.markdownHeadingMedium;
  return styles.markdownHeadingSmall;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  messageFrame: { flex: 1, minHeight: 0 },
  messageList: { flex: 1 },
  // 冷开落底 settle 期的遮罩(不影响布局/测量,只视觉隐藏;防两段式落底跳动,
  // 见 MOBILE_INITIAL_ANCHOR_SETTLE_MS)。
  messageListSettling: { opacity: 0 },
  messages: {
    flexGrow: 1,
    // Anchor a short conversation to the bottom (just above the composer) like a normal chat,
    // instead of pinning it to the top with dead space below. With flexGrow:1 this only affects
    // the under-one-screen case; once messages overflow the viewport the list scrolls normally.
    justifyContent: 'flex-end',
    gap: spacing.lg,
    paddingBottom: MOBILE_MESSAGE_LIST_BOTTOM_PADDING,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  messagesWide: {
    alignSelf: 'center',
    width: '100%',
  },
  focusedItem: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.borderStrong,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    marginHorizontal: -spacing.xs,
    padding: spacing.xs,
  },
  emptyCard: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 168,
    paddingHorizontal: spacing.lg,
  },
  emptyTitle: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  syncingTitle: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    marginTop: spacing.sm,
  },
  messageItem: {
    gap: 2,
    width: '100%',
  },
  sentInlineAtomBody: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    maxWidth: '100%',
  },
  sentInlineTextChunk: {
    flexBasis: '100%',
    flexShrink: 1,
    maxWidth: '100%',
  },
  userMessageItem: {
    alignItems: 'flex-end',
  },
  agentMessageItem: {
    alignItems: 'stretch',
  },
  bubble: {
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    padding: spacing.md,
  },
  bubbleCompact: {
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bubbleRich: {
    gap: spacing.sm,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.borderStrong,
    maxWidth: '86%',
  },
  agentBubble: {
    alignSelf: 'stretch',
    backgroundColor: colors.surface,
    borderColor: colors.surface,
    borderWidth: 0,
    maxWidth: '100%',
    paddingHorizontal: 0,
    paddingVertical: spacing.xs,
  },
  hookSourceBubble: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  hookSourceHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  hookSourceTitle: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.semibold,
  },
  hookSourceChannel: {
    color: colors.textTertiary,
    flexShrink: 1,
    fontSize: typeScale.caption,
  },
  messageText: { color: colors.textPrimary, fontSize: typeScale.bodyLarge, lineHeight: lineHeight.bodyLarge },
  automationOriginRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    maxWidth: '86%',
  },
  automationOriginText: {
    color: colors.textTertiary,
    flexShrink: 1,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  modelMismatchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    maxWidth: '86%',
  },
  modelMismatchText: {
    color: colors.textTertiary,
    flexShrink: 1,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  collapseMeasureWrap: {
    // left/right 与 `bubble` 基础样式的水平 padding(spacing.md)绑定——
    // bubbleCompact 显式覆盖为同值,bubbleRich 未覆盖(继承基础值)。若未来
    // 任何气泡变体改水平 padding,这里必须同步,否则测量宽度偏离正文实际
    // 可用宽度,临界行数(尤其自动任务的 4 行阈值)会误判收起/不收起。
    left: spacing.md,
    opacity: 0,
    position: 'absolute',
    right: spacing.md,
    top: 0,
  },
  collapseToggleText: {
    alignSelf: 'flex-start',
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    // Text onPress 无 hitSlop,靠 padding 把点击区撑到 ~32pt 高。
    paddingVertical: spacing.xs,
  },
  systemCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  systemCardTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
  },
  systemCardBody: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  systemCardRows: {
    gap: spacing.sm,
  },
  systemCardRow: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    paddingTop: spacing.sm,
  },
  systemCardLabel: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  systemCardValue: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  // ── agent-switch 分隔线 + 药丸(对齐桌面 AgentSwitchCard)────────────────
  agentSwitchWrap: {
    paddingVertical: spacing.sm,
  },
  agentSwitchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
  },
  agentSwitchDivider: {
    backgroundColor: colors.border,
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  agentSwitchPill: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexShrink: 1,
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  agentSwitchPillText: {
    color: colors.textSecondary,
    fontSize: typeScale.micro,
    fontWeight: fontWeight.medium,
  },
  agentSwitchDot: {
    color: colors.textTertiary,
    fontSize: typeScale.micro,
    opacity: 0.5,
  },
  agentSwitchModel: {
    color: colors.textSecondary,
    flexShrink: 1,
    fontFamily: monoFont,
    fontSize: typeScale.micro,
  },
  agentSwitchHandoffPanel: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  agentSwitchHandoffTitle: {
    color: colors.textTertiary,
    fontSize: typeScale.micro,
    fontWeight: fontWeight.medium,
    marginBottom: spacing.xs,
  },
  agentSwitchHandoffText: {
    color: colors.textSecondary,
    fontFamily: monoFont,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  markdownBody: { gap: 10 },
  // 外链 / 会话深链等一切可点行内元素:**只有下划线**,不加粗、不换色、不换字体
  // (DESIGN.md §14.5;GitHub 的 `.markdown-body a` 同样只有 text-decoration)。
  //
  // 刻意**不写 color**:必须继承所在上下文的颜色。表头(markdownTableHeaderCell 用
  // textSecondary)、引用块等非正文色上下文里,写死 textPrimary 会让链接相对周围的
  // 不可点文本**除下划线之外还变色**,违反「可点态只多一条横线」(PR #1144 review 实捉)。
  markdownLink: {
    textDecorationLine: 'underline',
  },
  // 会话深链 chip(非 selectable 原生 Text 路径):嵌套 Text 只支持背景色不支持
  // 圆角,用 surfaceChip 底色近似 chip 观感;WebView 路径的 .xdt-session-chip
  // 才是完整圆角版本。
  //
  // 下划线**不再**关掉:会话 chip 是可点的,而「下划线常显 = 可点」是聊天正文的唯一
  // 交互信号(见 docs/design-rules/DESIGN.md「聊天正文的可点性信号」)。原先靠底色
  // 单独表达可点,但底色同时被行内 code 等排版语义占用,读者无法据此判断可点性。
  sessionLinkChipText: {
    backgroundColor: colors.surfaceChip,
  },
  // 对齐桌面聊天 markdown:<strong> 走浏览器默认 700,与 400 正文拉开明显对比。
  markdownStrong: { fontWeight: fontWeight.bold },
  markdownEmphasis: { fontStyle: 'italic' },
  // inline 公式:Unicode 近似文本以斜体呈现(数学正文的传统排版形态),
  // 与普通强调的区别只在语义,视觉上沿用 italic 已足够。
  markdownMathInline: { fontStyle: 'italic' },
  markdownStrike: { textDecorationLine: 'line-through' },
  // 行内 code:零底色 + 等宽字体 + 文字压暗(参照 Codex 客户端)。
  // 不给底色是平台约束:RN 嵌套在 Text 内的 inline 片段只认 backgroundColor,不认
  // borderRadius(同 sessionLinkChipText 的注释),底色在这里只能是直角方块,成段
  // 中文里一排方块比没有底色更糟。桌面走的是 GitHub 淡底 + 6px 圆角(CSS 能实现),
  // 两端形态刻意不同 —— 取值与理由见 chatInlineCodeText。
  markdownInlineCode: {
    color: colors.chatInlineCodeText,
    fontFamily: monoFont,
    fontSize: typeScale.code,
    lineHeight: lineHeight.code,
  },
  // 已验证存在的文件/目录路径 chip:**只加一条下划线,其它什么都不动**
  // (权威规则见 docs/design-rules/DESIGN.md §14.5,对齐 GitHub 的口径 ——
  // `.markdown-body code` 刻意不定义 color、纯靠继承,可点与不可点的行内 code
  // 差别只在那条横线)。
  //
  // 刻意**不**再写 color 与 fontWeight:本样式总是叠在 markdownInlineCode 之后,
  // 于是可点的行内 code 与不可点的行内 code 同色同字重,只差下划线 —— 差异越单一,
  // 「有横线 = 能点」这条规则越可信。早先这里钉 textPrimary + medium 是因为当时
  // 下划线还不是主信号,怕可点的比不可点的更淡;现在信号收敛到下划线,压暗是行内
  // code 的排版语义,继承它才是对的。
  markdownPathChip: {
    textDecorationLine: 'underline',
  },
  markdownInlineImage: {
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.control,
  },
  markdownHeading: {
    color: colors.textPrimary,
    fontWeight: fontWeight.medium,
  },
  // 三档标题,行高刻意选到能与 desktop 的相对比例对齐(desktop 正文 15:h1 20/1.4、
  // h2 18/1.556、h3 16/1.5≈正文;mobile 正文 17):
  //   h1  20/28 = 1.400  ← 与 desktop h1 的 1.4 相同
  //   h2  18/28 = 1.556  ← 与 desktop h2 的 1.556 相同
  //   h3+ 17/26          ← 与正文同字号,靠 medium 区分(同 desktop 让 h3 贴近正文)
  // 20/28 与 18/28 都是 lineHeight 阶梯里既有的 listTitle 配对,未扩档。
  // 改前 h1/h2 都是 bodyLarge(17)=正文字号、h3-h6 是 caption(12)——标题比正文还小。
  markdownHeadingLarge: {
    fontSize: typeScale.title,
    lineHeight: lineHeight.listTitle,
  },
  markdownHeadingMedium: {
    fontSize: typeScale.subtitle,
    lineHeight: lineHeight.listTitle,
  },
  markdownHeadingSmall: {
    fontSize: typeScale.bodyLarge,
    lineHeight: lineHeight.bodyLarge,
  },
  // 竖线对齐本文件 styles.rail(chatCodeBorder + 2px)——界面里「块引导竖线」是
  // 一套统一的视觉语言,淡是设计意图;引用块不另搞一套(desktop 侧同样跟随
  // --agent-actions-rail)。
  markdownQuote: {
    borderLeftColor: colors.chatCodeBorder,
    borderLeftWidth: 2,
    paddingLeft: spacing.sm,
  },
  // 引用正文与正文同色:textSecondary 对 surface 仅 3.1:1(light)/ 3.4:1(dark),
  // 低于 WCAG AA 4.5:1,而 `>` 常承载本轮最该看的内容 —— 这是引用块唯一要修的
  // 问题。「这是引用」由 rail + 内缩表达,不靠压低正文对比度。
  markdownQuoteText: {
    color: colors.textPrimary,
  },
  markdownListRow: { flexDirection: 'row', gap: spacing.sm },
  // text_run 合并树里的列表 marker 前缀(不占固定列宽,颜色与原 marker 一致)。
  markdownListMarkerInline: {
    color: colors.textPrimary,
  },
  // 编号/项目符号与列表项正文同色(对齐 desktop 的 list-decimal / list-disc:
  // 那边 marker 本就继承正文色)。编号在实际使用中承担段落引导,弱化到
  // 3.1:1 会让扫读整段丢失。
  markdownListMarker: {
    color: colors.textPrimary,
    fontSize: typeScale.bodyLarge,
    lineHeight: lineHeight.bodyLarge,
    textAlign: 'right',
    width: 24,
  },
  markdownTaskMarker: {
    borderColor: colors.borderStrong,
    borderRadius: radius.micro,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: typeScale.micro,
    lineHeight: lineHeight.micro,
    marginTop: 3,
    minHeight: 16,
    overflow: 'hidden',
    textAlign: 'center',
    width: 16,
  },
  markdownListText: { flex: 1 },
  markdownCodeFrame: {
    backgroundColor: colors.chatCodeSurface,
    borderColor: colors.chatCodeBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container,
    maxWidth: '100%',
    overflow: 'hidden',
  },
  markdownCodeScroll: {
    maxWidth: '100%',
  },
  markdownCodeContent: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  markdownCodeText: {
    color: colors.textPrimary,
    fontFamily: monoFont,
    fontSize: typeScale.code,
    lineHeight: lineHeight.code,
  },
  // 语法着色:只上 color,其余(字体/字号/行高)继承 markdownCodeText —— 嵌套 Text
  // 只支持有限样式,且改字号会让同一行的 token 高低不齐。
  syntaxKeyword: { color: colors.syntaxKeyword },
  syntaxString: { color: colors.syntaxString },
  syntaxComment: { color: colors.syntaxComment },
  syntaxNumber: { color: colors.syntaxNumber },
  syntaxFunction: { color: colors.syntaxFunction },
  syntaxProperty: { color: colors.syntaxProperty },
  markdownTableScroll: {
    maxWidth: '100%',
  },
  markdownTable: {
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  markdownTableRow: {
    flexDirection: 'row',
  },
  markdownTableHeaderRow: {
    backgroundColor: colors.surfaceElevated,
  },
  markdownTableCell: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
    borderRightWidth: StyleSheet.hairlineWidth,
    color: colors.textPrimary,
    flexShrink: 0,
    fontSize: typeScale.code,
    lineHeight: lineHeight.code,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  markdownTableHeaderCell: {
    color: colors.textSecondary,
    fontWeight: fontWeight.medium,
  },
  detailText: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  italicText: { fontStyle: 'italic' },
  thinkingStrong: { fontWeight: fontWeight.medium },
  thinkingCode: { fontFamily: monoFont, fontStyle: 'normal' },
  attachmentStrip: { gap: spacing.sm, marginBottom: spacing.xs, maxWidth: '100%' },
  attachmentStripLeft: { alignItems: 'flex-start' },
  attachmentStripRight: { alignItems: 'flex-end' },
  attachmentFileColumn: { gap: spacing.xs, maxWidth: '100%' },
  attachmentFileColumnRight: { alignItems: 'flex-end' },
  attachmentImageWrap: { borderRadius: radius.container, overflow: 'hidden' },
  attachmentImage: { borderRadius: radius.container },
  attachmentImagePending: { backgroundColor: colors.surfaceChip, borderRadius: radius.container },
  attachmentImageFallback: {
    alignItems: 'center',
    gap: 2,
    justifyContent: 'center',
    padding: spacing.sm,
  },
  // tool 产出媒体独立块:agent 侧左对齐,逐个竖排(图片 attachment 帧自带圆角)。
  toolMediaBlock: { alignItems: 'flex-start', maxWidth: '100%' },
  imagePreviewWrap: {
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.container,
    overflow: 'hidden',
    width: 148,
  },
  imagePreview: { height: 96, width: 148 },
  imagePreviewFallback: {
    gap: 2,
    justifyContent: 'center',
    padding: spacing.sm,
  },
  mediaPlaceholder: {
    backgroundColor: colors.chatCodeSurface,
    borderColor: colors.chatCodeBorder,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
    minHeight: 86,
    padding: spacing.sm,
    width: 160,
  },
  mediaKind: { color: colors.textTertiary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  mediaTitle: { color: colors.textPrimary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  mediaHint: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.micro },
  fileChip: {
    alignItems: 'center',
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: spacing.xs,
    maxWidth: '100%',
    minHeight: 32,
    paddingHorizontal: spacing.sm,
  },
  fileIconFrame: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileText: { flex: 1, minWidth: 0 },
  fileName: { color: colors.textPrimary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  diffCard: {
    backgroundColor: colors.chatCodeSurface,
    borderColor: colors.chatCodeBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container,
    gap: spacing.xs,
    padding: spacing.sm,
  },
  diffPath: { color: colors.textPrimary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  diffStats: { color: colors.textSecondary, fontSize: typeScale.caption },
  diffRows: { gap: 2 },
  diffLine: { fontSize: typeScale.caption, lineHeight: lineHeight.micro },
  diffDelete: { color: colors.textSecondary },
  diffAdd: { color: colors.textPrimary, fontWeight: fontWeight.medium },
  diffMore: { color: colors.textTertiary, fontSize: typeScale.caption },
  messageActionBar: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
    marginTop: 0,
  },
  userMessageActionBar: { justifyContent: 'flex-end' },
  agentMessageActionBar: { justifyContent: 'flex-start' },
  messageIconAction: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  messageActionMeta: {
    alignSelf: 'center',
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.bodyRelaxed,
  },
  streamingStatus: {
    alignSelf: 'center',
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.listTitle,
  },
  foldPlain: { alignSelf: 'stretch' },
  foldCard: {
    alignSelf: 'stretch',
    backgroundColor: colors.chatCodeSurface,
    borderColor: colors.chatCodeBorder,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  // 空 body 协同卡的静态表头(无 chevron、无折叠)。
  orcaStaticHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  foldHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  foldHeaderPlain: {
    gap: 6,
    minHeight: 22,
    paddingHorizontal: 0,
    paddingVertical: 2,
  },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.42 },
  scrollToBottomFab: {
    alignItems: 'center',
    backgroundColor: colors.surfaceTranslucent,
    borderColor: colors.borderTranslucent,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: SCROLL_TO_BOTTOM_FAB_SIZE,
    justifyContent: 'center',
    position: 'absolute',
    width: SCROLL_TO_BOTTOM_FAB_SIZE,
    zIndex: 20,
  },
  scrollToBottomDot: {
    backgroundColor: colors.cta,
    borderRadius: radius.pill,
    height: 8,
    position: 'absolute',
    right: 3,
    top: 3,
    width: 8,
  },
  previousUserButton: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 34,
    justifyContent: 'center',
    position: 'absolute',
    right: spacing.lg,
    width: 34,
    zIndex: 20,
  },
  forkOriginRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  forkOriginLine: {
    backgroundColor: colors.border,
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  forkOriginButton: {
    alignItems: 'center',
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: spacing.xs,
    minHeight: 30,
    paddingHorizontal: spacing.sm,
  },
  forkOriginText: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  loadEarlierButton: {
    alignItems: 'center',
    alignSelf: 'center',
    borderRadius: radius.pill,
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  loadEarlierText: { color: colors.textTertiary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  foldText: { flex: 1, minWidth: 0 },
  foldTitle: { color: colors.textSecondary, fontSize: typeScale.footnote, fontWeight: fontWeight.medium },
  foldTitlePlain: {
    color: colors.textSecondary,
    fontSize: typeScale.listBody,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.listBody,
  },
  foldSubtitle: { color: colors.textTertiary, fontSize: typeScale.caption, marginTop: 2 },
  foldBody: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  foldBodyPlain: {
    paddingBottom: 0,
    paddingHorizontal: 0,
    paddingTop: spacing.xs,
  },
  rail: {
    borderLeftColor: colors.chatCodeBorder,
    borderLeftWidth: 2,
    paddingLeft: spacing.md,
  },
  stack: { gap: spacing.md },
  stackSmall: { gap: spacing.sm },
  workActivityStack: { gap: 0 },
  // thinking 与 tool group 都由内部 28pt 行高控制；外层不再追加组间距，
  // 否则每段 thinking 前后会比连续工具行多出 8pt，视觉节奏不一致。
  workGroupStack: { gap: 0 },
  workGroupElapsed: {
    color: colors.textTertiary,
    fontFamily: monoFont,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  workThinkingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    minHeight: 28,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  workThinkingRowExpanded: { alignItems: 'flex-start' },
  workThinkingText: { flex: 1, minWidth: 0 },
  workActivityText: {
    color: colors.textSecondary,
    fontSize: typeScale.listBody,
    lineHeight: lineHeight.listBody,
  },
  workThinkingMeasureWrap: {
    left: 0,
    opacity: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  toolRow: {
    gap: spacing.xs,
  },
  toolRowHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    minHeight: 28,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  toolRowDetails: {
    gap: spacing.xs,
    marginBottom: spacing.xs,
    marginHorizontal: spacing.sm,
  },
  toolRowDetailText: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
  },
  toolName: {
    color: colors.textSecondary,
    fontSize: typeScale.listBody,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.listBody,
  },
  toolNameFlex: { flex: 1, minWidth: 0 },
  toolResult: {
    backgroundColor: colors.chatCodeSurface,
    borderColor: colors.chatCodeBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container,
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
    padding: spacing.sm,
  },
  toolResultPreview: {
    backgroundColor: colors.chatCodeSurface,
    borderColor: colors.chatCodeBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container,
    gap: spacing.xs,
  },
  toolResultHint: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  payloadModal: {
    backgroundColor: colors.surface,
    flex: 1,
  },
  // alignItems / minHeight 由 headerLayout 按横竖屏注入(横屏紧凑单行)。
  payloadHeader: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
  },
  payloadHeaderText: { flex: 1, minWidth: 0 },
  payloadTitle: { color: colors.textPrimary, fontSize: typeScale.title, fontWeight: fontWeight.medium, lineHeight: lineHeight.title },
  payloadGalleryCount: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    marginTop: 2,
  },
  payloadHeaderActions: {
    flexShrink: 0,
    gap: spacing.xs,
  },
  payloadHeaderPrimaryActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  payloadHeaderButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 36,
    justifyContent: 'center',
    minHeight: 36,
    width: 36,
  },
  payloadHeaderStatus: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  payloadCloseButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 40,
    minHeight: 40,
    justifyContent: 'center',
    width: 40,
  },
  payloadCloseText: { color: colors.textPrimary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  payloadViewerBody: {
    flex: 1,
    minHeight: 0,
  },
  payloadBody: { flex: 1 },
  payloadScroll: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    // 空间不足(典型:横屏)时源码区让位给上方主体(图表/播放器),自身滚动兜底。
    flexShrink: 1,
    maxHeight: 220,
  },
  // 沉浸式 mermaid 查看器的浮动操作区(复制/关闭),悬于图表右上角。
  payloadFloatingActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    position: 'absolute',
    right: spacing.lg,
  },
  // 浮动按钮需要实底色,否则悬在图表线条上看不清。
  payloadFloatingButton: {
    backgroundColor: colors.surface,
  },
  payloadScrollContent: {
    padding: spacing.lg,
  },
  payloadText: { color: colors.textPrimary, fontSize: typeScale.bodyLarge, lineHeight: lineHeight.bodyLarge },
  payloadMonoText: { fontFamily: monoFont, fontSize: typeScale.footnote, lineHeight: lineHeight.code },
  payloadDiffHeaderBlock: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    padding: spacing.lg,
  },
  payloadDiffPath: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.body,
  },
  payloadDiffStats: {
    color: colors.textSecondary,
    fontFamily: monoFont,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.code,
  },
  payloadDiffFilePreviewBlock: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  payloadDiffFilePreviewScroll: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    maxHeight: 220,
  },
  payloadDiffScroll: {
    flex: 1,
  },
  payloadDiffContent: {
    gap: spacing.lg,
    padding: spacing.lg,
  },
  payloadDiffSection: {
    gap: spacing.sm,
  },
  payloadDiffCompareScroll: {
    width: '100%',
  },
  payloadDiffSectionTitle: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    textTransform: 'uppercase',
  },
  payloadDiffCompareRow: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingBottom: spacing.xs,
  },
  payloadDiffPane: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    width: 320,
  },
  payloadDiffPaneHeader: {
    backgroundColor: colors.surfaceChip,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  payloadDiffPaneTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  payloadDiffPaneBody: {
    paddingVertical: spacing.xs,
  },
  payloadDiffCompareLine: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    minHeight: 24,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  payloadDiffCompareLineOld: {
    backgroundColor: colors.surfaceElevated,
  },
  payloadDiffCompareLineNew: {
    backgroundColor: colors.surface,
  },
  payloadDiffLineNumber: {
    color: colors.textTertiary,
    fontFamily: monoFont,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.code,
    marginRight: spacing.sm,
    textAlign: 'right',
    width: 34,
  },
  payloadDiffLinePrefix: {
    fontFamily: monoFont,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.code,
    marginRight: spacing.sm,
    textAlign: 'center',
    width: 14,
  },
  payloadDiffLinePrefixOld: {
    color: colors.textSecondary,
  },
  payloadDiffLinePrefixNew: {
    color: colors.textPrimary,
    fontWeight: fontWeight.medium,
  },
  payloadDiffLineText: {
    flex: 1,
    fontFamily: monoFont,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.code,
  },
  payloadDiffLineTextOld: {
    color: colors.textSecondary,
    textDecorationLine: 'line-through',
  },
  payloadDiffLineTextNew: {
    color: colors.textPrimary,
    fontWeight: fontWeight.medium,
  },
  payloadDiffEmptyLine: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.code,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  payloadMediaPlayerFrame: {
    backgroundColor: colors.surfaceChip,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 300,
    width: '100%',
  },
  payloadMediaPlayer: {
    flex: 1,
    minHeight: 260,
    width: '100%',
  },
  payloadMediaPlayerStatus: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    textAlign: 'center',
  },
  payloadMediaPlaceholder: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    justifyContent: 'center',
    minHeight: 260,
    padding: spacing.xl,
  },
  payloadMediaKind: { color: colors.textPrimary, fontSize: typeScale.title, fontWeight: fontWeight.medium },
  payloadMediaHint: { color: colors.textSecondary, fontSize: typeScale.body, lineHeight: lineHeight.body, textAlign: 'center' },
  payloadActionBlock: {
    alignItems: 'center',
    gap: spacing.xs,
    width: '100%',
  },
  payloadActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'center',
  },
  payloadOpenButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 38,
    paddingHorizontal: spacing.lg,
  },
  payloadOpenButtonText: { color: colors.textPrimary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  payloadPathCopyStatus: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    textAlign: 'center',
  },
  todoRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 32 },
  todoRowPending: { opacity: 0.72 },
  todoMark: { alignItems: 'center', justifyContent: 'center', width: 22 },
  todoCopy: { flex: 1, minWidth: 0 },
  todoText: { color: colors.textPrimary, fontSize: typeScale.code, lineHeight: lineHeight.code },
  todoPending: { color: colors.textTertiary },
  todoDone: { fontWeight: fontWeight.medium },
});
