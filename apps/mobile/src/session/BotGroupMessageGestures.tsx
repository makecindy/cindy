import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, useWindowDimensions, View, type StyleProp, type ViewInstance, type ViewStyle } from 'react-native';
import Animated, { Easing, Extrapolation, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { GlassView } from 'expo-glass-effect';
import { Check, Copy, CornerDownRight, FileText, MessageSquare, Plus, Reply, Share } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BotGroupMessageView } from '@cindy/maker-shared/botGroupChat';
import { Text } from '@/components/AppText';
import { ChatReplyIcon } from '@/components/ChatReplyIcon';
import { getCachedReduceMotionEnabled, useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { Gesture, GestureDetector } from '@/platform/gestureHandler';
import { playHaptic } from '@/platform/haptics';
import { fontWeight, iconSize, iconStroke, lineHeight, motionDuration, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { BlurBackdrop } from './BlurBackdrop';
import { BotGroupChildLongPressContext, BotGroupMessageLongPressTriggerContext, BotGroupSwipeSuppressionContext } from './botGroupMessageGestureContext';
import { CHAT_REACTION_EMOJIS, type ChatReaction } from '@cindy/maker-shared/optimistic-reactions';
import { CompanionSheet } from './CompanionSheet';
import { MarkdownSelectableText } from './MarkdownSelectableText';
import { copyMessageText, type CopyMessageStatus } from './messageActions';
import { useLiquidGlassAvailable } from './useLiquidGlassAvailable';

const QUICK_REACTION_EMOJIS = CHAT_REACTION_EMOJIS.slice(0, 6);

const SWIPE_REPLY_THRESHOLD = 52;
const SWIPE_MAX_DRAG = 80;
const PRESS_IN_MS = 90;
const PRESS_OUT_MS = 140;
const OVERLAY_OPEN_MS = 200;
const OVERLAY_CLOSE_MS = 140;
const SWIPE_RETURN_MS = 140;
const SWIPE_ARM_MS = 110;
const SWIPE_BADGE_SIZE = 36;

export type BotGroupMessageAnchorRect = { x: number; y: number; width: number; height: number };

export function BotGroupPressableMessage({ variant = 'row', disabled = false, onLongPress, style, testID, children }: {
  variant?: 'row' | 'bubble';
  disabled?: boolean;
  onLongPress?: (anchorRect?: BotGroupMessageAnchorRect) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const scale = useSharedValue(1);
  const highlight = useSharedValue(0);
  const wrapRef = useRef<ViewInstance>(null);
  const pressingRef = useRef(false);
  const childSuppressedRef = useRef(false);
  const swipeSuppressors = useContext(BotGroupSwipeSuppressionContext);

  const resetPressVisual = useCallback(() => {
    if (getCachedReduceMotionEnabled() === false) {
      scale.value = withTiming(1, { duration: PRESS_OUT_MS });
      highlight.value = withTiming(0, { duration: PRESS_OUT_MS });
    } else {
      scale.value = 1;
      highlight.value = 0;
    }
  }, [scale, highlight]);

  const suppressMessageLongPress = useCallback(() => {
    if (pressingRef.current) childSuppressedRef.current = true;
    resetPressVisual();
  }, [resetPressVisual]);

  useEffect(() => {
    if (!swipeSuppressors) return;
    swipeSuppressors.add(suppressMessageLongPress);
    return () => { swipeSuppressors.delete(suppressMessageLongPress); };
  }, [swipeSuppressors, suppressMessageLongPress]);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const rowHighlightStyle = useAnimatedStyle(() => ({ opacity: highlight.value * 0.55 }));

  const handlePressIn = () => {
    pressingRef.current = true;
    childSuppressedRef.current = false;
    if (disabled || !onLongPress) return;
    if (getCachedReduceMotionEnabled() === false) {
      scale.value = withTiming(variant === 'bubble' ? 0.975 : 0.99, { duration: PRESS_IN_MS });
      highlight.value = withTiming(1, { duration: PRESS_IN_MS });
    } else {
      highlight.value = 1;
    }
  };

  const handlePressOut = () => {
    pressingRef.current = false;
    childSuppressedRef.current = false;
    resetPressVisual();
  };

  const handleLongPress = () => {
    if (childSuppressedRef.current) { childSuppressedRef.current = false; return; }
    if (disabled || !onLongPress) return;
    playHaptic('commit');
    resetPressVisual();
    const target = wrapRef.current;
    if (target && typeof target.measureInWindow === 'function') {
      target.measureInWindow((x, y, width, height) => {
        onLongPress(Number.isFinite(y) && width > 0 && height > 0 ? { x, y, width, height } : undefined);
      });
    } else {
      onLongPress();
    }
  };

  const handleLongPressRef = useRef(handleLongPress);
  handleLongPressRef.current = handleLongPress;
  const triggerMessageLongPress = useCallback(() => handleLongPressRef.current(), []);

  return (
    <BotGroupChildLongPressContext.Provider value={suppressMessageLongPress}>
      <BotGroupMessageLongPressTriggerContext.Provider value={!disabled && onLongPress ? triggerMessageLongPress : null}>
        <View ref={wrapRef} collapsable={false} style={variant === 'bubble' ? styles.pressableWrapBubble : styles.pressableWrap}>
          <Animated.View style={[styles.pressableWrap, variant === 'bubble' && styles.pressableWrapBubble, animatedStyle]}>
            {variant === 'row' ? <Animated.View pointerEvents="none" style={[styles.rowPressHighlight, rowHighlightStyle]} /> : null}
            <Pressable
              delayLongPress={260}
              disabled={disabled || !onLongPress}
              onPressIn={handlePressIn}
              onPressOut={handlePressOut}
              onLongPress={handleLongPress}
              style={style}
              testID={testID}
              unstable_pressDelay={80}
            >
              {children}
            </Pressable>
          </Animated.View>
        </View>
      </BotGroupMessageLongPressTriggerContext.Provider>
    </BotGroupChildLongPressContext.Provider>
  );
}

export function BotGroupSwipeToReply({ enabled, onReply, children }: {
  enabled: boolean;
  onReply?: () => void;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const reduceMotion = useReduceMotionEnabled();
  const translateX = useSharedValue(0);
  const crossed = useSharedValue(false);
  const armed = useSharedValue(0);
  const animateMotionSv = useSharedValue(reduceMotion === false);
  const replyRef = useRef(onReply);
  replyRef.current = onReply;
  const suppressorsRef = useRef<Set<() => void>>(new Set());
  const hasReply = !!onReply;

  useEffect(() => { animateMotionSv.value = reduceMotion === false; }, [reduceMotion, animateMotionSv]);

  const fireHaptic = () => playHaptic('commit');
  const fireReply = () => replyRef.current?.();
  const cancelChildPresses = () => { for (const suppress of suppressorsRef.current) suppress(); };

  // Keep gesture identity stable across renders; callbacks read through refs.
  const pan = useMemo(() => {
    if (!enabled || !hasReply) return null;
    return Gesture.Pan()
      .activeOffsetX(-10)
      .failOffsetX(10)
      .failOffsetY([-14, 14])
      .shouldCancelWhenOutside(false)
      .onStart(() => { 'worklet'; runOnJS(cancelChildPresses)(); })
      .onUpdate((event) => {
        'worklet';
        if (event.translationX >= 0) {
          translateX.value = 0;
          if (crossed.value) {
            crossed.value = false;
            armed.value = animateMotionSv.value ? withTiming(0, { duration: SWIPE_ARM_MS }) : 0;
          }
          return;
        }
        const raw = -event.translationX;
        const damped = raw <= SWIPE_REPLY_THRESHOLD ? raw : SWIPE_REPLY_THRESHOLD + (raw - SWIPE_REPLY_THRESHOLD) * 0.3;
        translateX.value = -Math.min(SWIPE_MAX_DRAG, damped);
        const nowCrossed = damped >= SWIPE_REPLY_THRESHOLD;
        if (nowCrossed !== crossed.value) {
          crossed.value = nowCrossed;
          armed.value = animateMotionSv.value ? withTiming(nowCrossed ? 1 : 0, { duration: SWIPE_ARM_MS, easing: Easing.out(Easing.cubic) }) : (nowCrossed ? 1 : 0);
          if (nowCrossed) runOnJS(fireHaptic)();
        }
      })
      .onFinalize((_event, success) => {
        'worklet';
        const triggered = success && crossed.value;
        crossed.value = false;
        const shouldAnimate = animateMotionSv.value;
        armed.value = shouldAnimate ? withTiming(0, { duration: SWIPE_RETURN_MS }) : 0;
        if (shouldAnimate && translateX.value !== 0) {
          translateX.value = withTiming(0, { duration: SWIPE_RETURN_MS, easing: Easing.out(Easing.cubic) }, () => {
            if (triggered) runOnJS(fireReply)();
          });
        } else {
          translateX.value = 0;
          if (triggered) runOnJS(fireReply)();
        }
      });
  }, [enabled, hasReply, translateX, crossed, armed, animateMotionSv]);

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));
  const badgeStyle = useAnimatedStyle(() => {
    const progress = interpolate(-translateX.value, [10, SWIPE_REPLY_THRESHOLD], [0, 1], Extrapolation.CLAMP);
    const scale = interpolate(progress, [0, 1], [0.68, 0.94], Extrapolation.CLAMP) + armed.value * 0.08;
    return { opacity: progress, transform: [{ scale }] };
  });
  const armedBadgeStyle = useAnimatedStyle(() => ({ opacity: armed.value }));

  if (!pan) return <>{children}</>;
  return (
    <BotGroupSwipeSuppressionContext.Provider value={suppressorsRef.current}>
      <View style={styles.swipeContainer}>
        <Animated.View pointerEvents="none" style={[styles.swipeBadge, badgeStyle]}>
          <Reply size={iconSize.md} strokeWidth={iconStroke.medium} color={colors.textSecondary} />
          <Animated.View style={[styles.swipeBadgeArmed, armedBadgeStyle]}>
            <Reply size={iconSize.md} strokeWidth={iconStroke.medium} color={colors.swipeActionText} />
          </Animated.View>
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View style={rowStyle}>{children}</Animated.View>
        </GestureDetector>
      </View>
    </BotGroupSwipeSuppressionContext.Provider>
  );
}

export type BotGroupMessageOverlayTarget = {
  message: BotGroupMessageView;
  align: 'left' | 'right';
  anchorRect?: BotGroupMessageAnchorRect;
  canReact: boolean;
  readOnly: boolean;
  online: boolean;
  shared?: { messageId: string | null; bySelf: boolean };
  onQuote?: () => void;
  onThread?: () => void;
  onShare?: () => void;
  onReveal?: () => void;
  onShareImage?: () => void;
};

function GlassCard({ style, pill = false, testID, children }: {
  style?: StyleProp<ViewStyle>;
  pill?: boolean;
  testID?: string;
  children: ReactNode;
}) {
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const liquidGlass = useLiquidGlassAvailable();
  const radiusStyle = pill ? styles.pillRadius : styles.cardRadius;
  if (liquidGlass) {
    return (
      <View style={[radiusStyle, styles.clipped, style]} testID={testID}>
        <GlassView colorScheme={mode} glassEffectStyle="regular" isInteractive style={[radiusStyle, styles.clipped]}>
          {children}
        </GlassView>
      </View>
    );
  }
  return (
    <View style={[radiusStyle, styles.solidShell, style]} testID={testID}>
      <BlurBackdrop intensity={44} overlayColor={colors.sheetActionSurface} />
      {children}
    </View>
  );
}

export function BotGroupMessageContextOverlay({ target, reactions, onReact, onOpenEmojiPicker, onSelectText, onClose }: {
  target: BotGroupMessageOverlayTarget | null;
  reactions: readonly ChatReaction[] | undefined;
  onReact(messageId: string, emoji: string, nextPresent: boolean): void;
  onOpenEmojiPicker(messageId: string): void;
  onSelectText(text: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  const [renderedTarget, setRenderedTarget] = useState<BotGroupMessageOverlayTarget | null>(target);
  const [copyState, setCopyState] = useState<CopyMessageStatus | 'idle' | 'copying'>('idle');
  const copyOperation = useRef(0);
  const closeEpoch = useRef(0);
  const scrimOpacity = useSharedValue(0);
  const panelProgress = useSharedValue(0);

  const finishClose = (epoch: number) => {
    if (closeEpoch.current === epoch) setRenderedTarget(null);
  };

  useEffect(() => {
    setCopyState('idle');
    copyOperation.current += 1;
    const animate = getCachedReduceMotionEnabled() === false;
    if (target) {
      closeEpoch.current += 1;
      setRenderedTarget(target);
      if (animate) {
        scrimOpacity.value = 0;
        panelProgress.value = 0;
        scrimOpacity.value = withTiming(1, { duration: motionDuration.fast, easing: Easing.out(Easing.cubic) });
        panelProgress.value = withTiming(1, { duration: OVERLAY_OPEN_MS, easing: Easing.out(Easing.cubic) });
      } else {
        scrimOpacity.value = 1;
        panelProgress.value = 1;
      }
      return;
    }
    if (!renderedTarget) return;
    if (!animate) { setRenderedTarget(null); return; }
    const epoch = ++closeEpoch.current;
    scrimOpacity.value = withTiming(0, { duration: OVERLAY_CLOSE_MS, easing: Easing.in(Easing.cubic) });
    panelProgress.value = withTiming(0, { duration: OVERLAY_CLOSE_MS, easing: Easing.in(Easing.cubic) }, (finished) => {
      'worklet';
      if (finished) runOnJS(finishClose)(epoch);
    });
  }, [target, renderedTarget, scrimOpacity, panelProgress]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimOpacity.value }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(panelProgress.value, [0, 1], [6, 0], Extrapolation.CLAMP) },
      { scale: interpolate(panelProgress.value, [0, 1], [0.94, 1], Extrapolation.CLAMP) },
    ],
  }));

  if (!renderedTarget) return null;

  const { message, align, anchorRect, canReact, readOnly, online, shared, onQuote, onThread, onShare, onReveal, onShareImage } = renderedTarget;
  const copyDisabled = message.threadShare ? message.threadShare.status !== 'available' : !message.content.trim();
  const copyText = message.threadShare?.status === 'available' ? message.threadShare.content : message.content;
  const activeEmojis = new Set((reactions ?? []).filter(item => item.me).map(item => item.emoji));
  const alignRight = align === 'right';
  const shareDisabled = shared?.bySelf ? !shared.messageId : !online;
  const copyLabel = copyState === 'copied' ? 'message.renderer.copyStateCopied'
    : copyState === 'failed' ? 'message.renderer.copyStateFailed'
      : copyState === 'copying' ? 'message.renderer.copyStateCopying' : 'groupChat.thread.copy';

  const runAction = (fn: () => void) => () => { playHaptic('selection'); onClose(); fn(); };
  const handoffAction = (fn: () => void) => () => {
    playHaptic('selection');
    closeEpoch.current += 1;
    setRenderedTarget(null);
    onClose();
    fn();
  };
  const handleCopy = () => {
    if (copyDisabled || copyState === 'copying') return;
    const operation = ++copyOperation.current;
    setCopyState('copying');
    playHaptic('selection');
    void copyMessageText(copyText).then(status => {
      if (copyOperation.current !== operation) return;
      setCopyState(status);
      if (status === 'copied') onClose();
    });
  };

  const actions: Array<{ id: string; label: string; disabled?: boolean; icon: ReactNode; onPress(): void }> = [
    ...(onQuote ? [{ id: 'quote', label: t('message.renderer.reply'), disabled: readOnly, icon: <ChatReplyIcon size={iconSize.md} color={readOnly ? colors.textTertiary : colors.textPrimary} />, onPress: runAction(onQuote) }] : []),
    ...(onThread ? [{ id: 'thread', label: t(message.replyCount === 0 ? 'groupChat.thread.create' : 'groupChat.thread.open'), icon: <MessageSquare size={iconSize.md} strokeWidth={iconStroke.regular} color={colors.textPrimary} />, onPress: runAction(onThread) }] : []),
    {
      id: 'copy',
      label: t(copyLabel),
      disabled: copyDisabled || copyState === 'copying',
      icon: copyState === 'copied'
        ? <Check size={iconSize.md} strokeWidth={iconStroke.regular} color={colors.textPrimary} />
        : <Copy size={iconSize.md} strokeWidth={iconStroke.regular} color={copyDisabled ? colors.textTertiary : colors.textPrimary} />,
      onPress: handleCopy,
    },
    ...(!copyDisabled ? [{ id: 'selectText', label: t('groupChat.thread.selectText'), icon: <FileText size={iconSize.md} strokeWidth={iconStroke.regular} color={colors.textPrimary} />, onPress: handoffAction(() => onSelectText(copyText)) }] : []),
    ...(onShare && !readOnly ? [{ id: 'share', label: t(shared?.bySelf ? 'groupChat.thread.showInGroup' : 'groupChat.thread.shareToGroup'), disabled: shareDisabled, icon: <CornerDownRight size={iconSize.md} strokeWidth={iconStroke.regular} color={shareDisabled ? colors.textTertiary : colors.textPrimary} />, onPress: runAction(() => (shared?.bySelf ? onReveal?.() : onShare())) }] : []),
    ...(onShareImage ? [{ id: 'image', label: t('session.shareImage.title'), icon: <Share size={iconSize.md} strokeWidth={iconStroke.regular} color={colors.textPrimary} />, onPress: runAction(onShareImage) }] : []),
  ];

  const showQuickBar = canReact && !readOnly;
  const estimatedHeight = (showQuickBar ? 56 : 0) + actions.length * 44;
  const minTop = Math.max(insets.top, spacing.xl) + spacing.sm;
  const maxTop = Math.max(minTop, windowHeight - Math.max(insets.bottom, spacing.xl) - estimatedHeight - spacing.sm);
  let anchoredTop: number | null = null;
  if (anchorRect) {
    const below = anchorRect.y + anchorRect.height + spacing.sm;
    const above = anchorRect.y - estimatedHeight - spacing.sm;
    anchoredTop = below <= maxTop ? Math.max(minTop, below) : above >= minTop ? above : Math.min(maxTop, Math.max(minTop, anchorRect.y + spacing.md));
  }

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}
      onRequestClose={onClose}>
      <View style={styles.overlayRoot} testID="botGroup.messageMenu">
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, scrimStyle]}>
          <View style={[StyleSheet.absoluteFill, styles.airyScrim, { opacity: mode === 'dark' ? 0.56 : 0.34 }]} />
        </Animated.View>
        <Pressable accessibilityLabel={t('session.common.cancel')} accessibilityRole="button" onPress={onClose} style={StyleSheet.absoluteFill} testID="botGroup.messageMenu.backdrop" />
        <View pointerEvents="box-none" style={[styles.overlayBackdrop, {
          justifyContent: anchoredTop !== null ? 'flex-start' : 'center',
          paddingTop: anchoredTop ?? Math.max(insets.top, spacing.xl),
          paddingBottom: Math.max(insets.bottom, spacing.xl),
          alignItems: alignRight ? 'flex-end' : 'flex-start',
        }]}>
          <Animated.View style={[styles.overlayStack, alignRight && styles.overlayStackRight, panelStyle]}>
            {showQuickBar ? (
              <GlassCard pill style={styles.quickBarWrap} testID="botGroup.messageMenu.quickReactions">
                <View style={styles.quickBar}>
                  {QUICK_REACTION_EMOJIS.map(emoji => {
                    const selected = activeEmojis.has(emoji);
                    return (
                      <Pressable
                        key={emoji}
                        accessibilityRole="button"
                        accessibilityLabel={emoji}
                        accessibilityState={{ selected }}
                        onPressIn={() => playHaptic('selection')}
                        onPress={() => { playHaptic('commit'); onReact(message.id, emoji, !selected); onClose(); }}
                        style={({ pressed }) => [styles.quickEmojiButton, selected && styles.quickEmojiSelected, pressed && styles.quickButtonPressed, pressed && !selected && styles.quickEmojiPressed]}
                        testID={`botGroup.messageMenu.react.${emoji}`}
                      >
                        <Text style={styles.quickEmoji}>{emoji}</Text>
                      </Pressable>
                    );
                  })}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('groupChat.reactions.morePicker')}
                    onPressIn={() => playHaptic('selection')}
                    onPress={() => {
                      playHaptic('commit');
                      closeEpoch.current += 1;
                      setRenderedTarget(null);
                      onClose();
                      onOpenEmojiPicker(message.id);
                    }}
                    style={({ pressed }) => [styles.quickMoreButton, pressed && styles.quickButtonPressed, pressed && styles.pressed]}
                    testID="botGroup.messageMenu.react.more"
                  >
                    <Plus size={iconSize.md} strokeWidth={iconStroke.regular} color={colors.textSecondary} />
                  </Pressable>
                </View>
              </GlassCard>
            ) : null}

            <GlassCard style={styles.actionCard} testID={`botGroup.thread.context.${message.id}`}>
              {actions.map((action, index) => (
                <View key={action.id}>
                  {index > 0 ? <View style={styles.separator} /> : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={action.label}
                    accessibilityState={{ disabled: !!action.disabled }}
                    disabled={action.disabled}
                    onPress={action.onPress}
                    style={({ pressed }) => [styles.actionRow, action.disabled && styles.actionDisabled, pressed && !action.disabled && styles.pressed]}
                    testID={`botGroup.thread.context.${message.id}.action.${action.id}`}
                  >
                    <View style={styles.actionIconSlot}>{action.icon}</View>
                    <Text numberOfLines={1} style={[styles.actionLabel, action.disabled && styles.actionLabelDisabled]}>{action.label}</Text>
                  </Pressable>
                </View>
              ))}
            </GlassCard>
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
}

export function BotGroupSelectTextSheet({ text, onClose }: { text: string | null; onClose(): void }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const copyAll = () => {
    if (!text) return;
    playHaptic('commit');
    void copyMessageText(text).then(status => { if (status === 'copied') onClose(); });
  };
  return (
    <CompanionSheet
      visible={text !== null}
      title={t('groupChat.thread.selectText')}
      onClose={onClose}
      initialSnap="full"
      contentScrolls
      footer={
        <Pressable accessibilityRole="button" onPress={copyAll} style={({ pressed }) => [styles.selectTextCopyButton, pressed && styles.pressed]} testID="botGroup.selectText.copyAll">
          <Text style={styles.selectTextCopyLabel}>{t('groupChat.thread.copy')}</Text>
        </Pressable>
      }
      testID="botGroup.selectText.sheet"
    >
      <View style={styles.selectTextBody}>
        <MarkdownSelectableText selectable style={styles.selectTextContent}>{text ?? ''}</MarkdownSelectableText>
      </View>
    </CompanionSheet>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  pressableWrap: { position: 'relative' },
  pressableWrapBubble: { width: '100%', alignItems: 'flex-end' },
  rowPressHighlight: { position: 'absolute', top: -spacing.sm, bottom: -spacing.sm, left: -spacing.lg, right: -spacing.lg, backgroundColor: colors.surfaceChip },
  swipeContainer: { position: 'relative', justifyContent: 'center' },
  swipeBadge: { position: 'absolute', right: 2, width: SWIPE_BADGE_SIZE, height: SWIPE_BADGE_SIZE, borderRadius: radius.pill, backgroundColor: colors.surfaceChip, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  swipeBadgeArmed: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.botUnread, alignItems: 'center', justifyContent: 'center' },
  overlayRoot: { flex: 1 },
  airyScrim: { backgroundColor: colors.overlay },
  overlayBackdrop: { flex: 1, paddingHorizontal: spacing.lg },
  overlayStack: { alignItems: 'flex-start', gap: spacing.sm, maxWidth: '100%' },
  overlayStackRight: { alignItems: 'flex-end' },
  pillRadius: { borderRadius: radius.pill },
  cardRadius: { borderRadius: radius.container },
  clipped: { overflow: 'hidden' },
  solidShell: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  quickBarWrap: { maxWidth: '100%' },
  quickBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  quickEmojiButton: { width: 40, height: 40, borderRadius: radius.pill, borderWidth: 1, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  quickEmojiSelected: { backgroundColor: `${colors.botUnread}24`, borderColor: `${colors.botUnread}80` },
  quickEmojiPressed: { backgroundColor: colors.surfaceChip },
  quickButtonPressed: { transform: [{ scale: 0.9 }] },
  quickEmoji: { fontSize: typeScale.title, lineHeight: lineHeight.subtitle },
  quickMoreButton: { width: 36, height: 36, borderRadius: radius.pill, backgroundColor: colors.surfaceChip, alignItems: 'center', justifyContent: 'center' },
  actionCard: { width: 236, maxWidth: '100%' },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.borderTranslucent },
  actionRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  actionIconSlot: { width: iconSize.lg, alignItems: 'center', justifyContent: 'center' },
  actionDisabled: { opacity: 0.45 },
  actionLabel: { flex: 1, minWidth: 0, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.regular, color: colors.textPrimary },
  actionLabelDisabled: { color: colors.textTertiary },
  pressed: { opacity: 0.72 },
  selectTextBody: { paddingTop: 52, paddingBottom: spacing.xxl, paddingHorizontal: spacing.xs },
  selectTextContent: { fontSize: typeScale.bodyLarge, lineHeight: lineHeight.subtitle, color: colors.textPrimary },
  selectTextCopyButton: { minHeight: 44, borderRadius: radius.container, backgroundColor: colors.surfaceChip, alignItems: 'center', justifyContent: 'center' },
  selectTextCopyLabel: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: colors.textPrimary },
});
