/**
 * QuoteCapsule — 「N 处引用」胶囊(chat-text-quote,对照桌面 Codex 风格)。
 *
 * 两个宿主:
 * - `variant="composer"`:会话页输入区上方,常驻 X 清空全部引用(手机无
 *   hover,X 直接可见)。
 * - `variant="bubble"`:发出的 user 气泡上方(右对齐),无 X(消息已定型)。
 *
 * 预览是**锚定浮窗**(透明 Modal + measureInWindow 定位在胶囊上方,对齐桌面
 * hover 浮层的 bottom-full 语义):点胶囊弹出、点任意处关闭,不占布局流——
 * 不能把输入框 / 消息内容顶开(产品真机反馈)。逐条:引用文本中文引号包裹、
 * 截 3 行;文件来源条目附 FileText 图标 + basename/行号。
 */
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, MessageSquareQuote, X } from 'lucide-react-native';
import { Modal, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { Text } from '@/components/AppText';
import { quoteSourceDisplayLabel, type ChatQuote } from '@cindy/maker-shared/chat-quotes';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

/** 预览卡最大宽度(对照桌面 w-80);屏窄时被左右边距 clamp。 */
const PREVIEW_MAX_WIDTH = 320;
/** 预览卡最大高度(对照桌面 max-h-64),超出内部滚动。 */
const PREVIEW_MAX_HEIGHT = 256;

interface PreviewAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QuoteCapsuleProps {
  quotes: readonly ChatQuote[];
  variant: 'composer' | 'bubble';
  /** 清空全部引用(仅 composer 侧)。 */
  onClear?: () => void;
  testIDPrefix?: string;
}

export function QuoteCapsule({ quotes, variant, onClear, testIDPrefix = 'quoteCapsule' }: QuoteCapsuleProps) {
  const styles = useThemedStyles(makeQuoteCapsuleStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const capsuleRef = useRef<View>(null);
  // 非空 = 预览浮窗开启(记录胶囊的 window 坐标供浮窗锚定)。
  const [previewAnchor, setPreviewAnchor] = useState<PreviewAnchor | null>(null);

  const openPreview = useCallback(() => {
    capsuleRef.current?.measureInWindow((x, y, width, height) => {
      setPreviewAnchor({ x, y, width, height });
    });
  }, []);
  const closePreview = useCallback(() => setPreviewAnchor(null), []);

  if (quotes.length === 0) return null;

  // 浮窗锚定:默认卡片底边贴胶囊顶边(向上生长);胶囊靠近屏幕顶部、上方
  // 放不下整卡时翻到胶囊下方(review P2:只设 bottom 时首屏顶部的气泡胶囊
  // 会把长预览顶出屏外)。composer 左对齐胶囊、bubble 右对齐胶囊(消息列
  // 靠右,左锚会溢出屏幕),两侧均 clamp 进屏。
  const cardWidth = Math.min(PREVIEW_MAX_WIDTH, screenWidth - spacing.lg * 2);
  const placeBelow = previewAnchor !== null
    && previewAnchor.y - spacing.lg < PREVIEW_MAX_HEIGHT + spacing.sm;
  const anchorStyle = previewAnchor
    ? {
      ...(placeBelow
        ? { top: Math.max(spacing.lg, previewAnchor.y + previewAnchor.height + spacing.sm) }
        : { bottom: Math.max(spacing.lg, screenHeight - previewAnchor.y + spacing.sm) }),
      ...(variant === 'bubble'
        ? {
          right: Math.min(
            Math.max(spacing.lg, screenWidth - (previewAnchor.x + previewAnchor.width)),
            screenWidth - cardWidth - spacing.lg,
          ),
        }
        : {
          left: Math.min(Math.max(spacing.lg, previewAnchor.x), screenWidth - cardWidth - spacing.lg),
        }),
    }
    : null;

  return (
    <View style={variant === 'bubble' ? styles.containerBubble : styles.containerComposer} testID={testIDPrefix}>
      <Pressable
        accessibilityLabel={t('message.quote.countPreviewHint', { n: quotes.length })}
        accessibilityRole="button"
        onPress={openPreview}
        ref={capsuleRef}
        style={({ pressed }) => [styles.capsule, pressed && styles.pressed]}
        testID={`${testIDPrefix}.pill`}
      >
        <MessageSquareQuote color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
        <Text style={styles.capsuleText}>{t('message.quote.count', { n: quotes.length })}</Text>
        {variant === 'composer' && onClear ? (
          <Pressable
            accessibilityLabel={t('message.quote.remove')}
            accessibilityRole="button"
            hitSlop={8}
            onPress={onClear}
            style={({ pressed }) => [styles.clearButton, pressed && styles.pressed]}
            testID={`${testIDPrefix}.clear`}
          >
            <X color={colors.textSecondary} size={iconSize.xs} strokeWidth={iconStroke.regular} />
          </Pressable>
        ) : null}
      </Pressable>
      {previewAnchor && anchorStyle ? (
        <Modal
          animationType="fade"
          onRequestClose={closePreview}
          supportedOrientations={['portrait', 'landscape']}
          transparent
          visible
        >
          {/* 全屏透明背板:点任意处关闭;浮窗卡片自身拦截点击不透传。 */}
          <Pressable
            accessibilityLabel={t('message.quote.closePreview')}
            onPress={closePreview}
            style={styles.previewBackdrop}
            testID={`${testIDPrefix}.previewBackdrop`}
          >
            <View
              style={[styles.previewCard, { maxWidth: cardWidth }, anchorStyle]}
              testID={`${testIDPrefix}.preview`}
            >
              <ScrollView bounces={false} style={styles.previewScroll}>
                {quotes.map((quote, index) => (
                  <View key={index} style={[styles.previewItem, index > 0 && styles.previewItemGap]}>
                    <Text numberOfLines={3} style={styles.previewText}>
                      {`“${quote.text}”`}
                    </Text>
                    {quote.sourcePath ? (
                      <View style={styles.previewSourceRow}>
                        <FileText color={colors.textTertiary} size={iconSize.xs} strokeWidth={iconStroke.regular} />
                        <Text numberOfLines={1} style={styles.previewSourceText}>
                          {quoteSourceDisplayLabel(quote)}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                ))}
              </ScrollView>
            </View>
          </Pressable>
        </Modal>
      ) : null}
    </View>
  );
}

function makeQuoteCapsuleStyles(colors: ThemeColors) {
  return {
    containerComposer: {
      alignItems: 'flex-start' as const,
      paddingBottom: spacing.sm,
    },
    containerBubble: {
      alignItems: 'flex-end' as const,
      marginBottom: spacing.xs,
    },
    capsule: {
      alignItems: 'center' as const,
      backgroundColor: colors.surfaceChip,
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: 1,
      flexDirection: 'row' as const,
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
    },
    capsuleText: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.medium,
    },
    clearButton: {
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      marginLeft: spacing.xs,
    },
    previewBackdrop: {
      flex: 1,
    },
    // 无阴影:仓库 UI 统一后组件层零 shadowColor 先例(designTokenDiscipline
    // 守卫禁字面色值),浮窗与背景的分离靠 surfaceElevated + border。
    previewCard: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: 1,
      maxHeight: PREVIEW_MAX_HEIGHT,
      position: 'absolute' as const,
    },
    previewScroll: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    previewItem: {
      gap: 2,
      paddingBottom: spacing.xs,
    },
    previewItemGap: {
      borderTopColor: colors.border,
      borderTopWidth: 1,
      marginTop: spacing.sm,
      paddingTop: spacing.sm,
    },
    previewText: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
    previewSourceRow: {
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      gap: 4,
    },
    previewSourceText: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
    },
    pressed: {
      opacity: 0.7,
    },
  };
}
