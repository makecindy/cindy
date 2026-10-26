import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, CircleCheck, ShieldCheck } from 'lucide-react-native';
import { Animated, Easing, Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { APP_BINARY_VERSION } from '@/config/env';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { NativeSheetContext } from '@/session/NativeSheetContext';
import { SheetModal } from '@/session/SheetModal';
import { FloatingSheetContext, usePaneViewport } from '@/platform/AdaptiveWindowContext';
import {
  fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors,
} from '@/theme';
import { androidInstaller } from './androidInstaller';
import type { AndroidInstallState } from './androidInstallController';
import { indeterminateSweepRange, presentAndroidUpdate, type AndroidUpdatePresentation } from './androidUpdatePresentation';

const APP_ICON = require('../../assets/update/app-icon.jpg');
const APP_ICON_SIZE = 48;
const NOTES_MAX_HEIGHT = 160;
const INDETERMINATE_FRACTION = 0.36;
/** Same side inset as SheetSurface, so this card lines up with the other bottom sheets. */
const SHEET_HORIZONTAL_PADDING = 20;

type Note = NonNullable<AndroidUpdatePresentation['note']>;
type PrimaryLabel = NonNullable<AndroidUpdatePresentation['primary']>['label'];
const NOTE_COPY: Record<Note, { title: string; body: string }> = {
  permission: { title: 'update.android.permissionTitle', body: 'update.android.permissionBody' },
  denied: { title: 'update.android.deniedTitle', body: 'update.android.deniedBody' },
  error: { title: 'update.android.failedTitle', body: 'update.android.failedBody' },
};
const PRIMARY_COPY: Record<PrimaryLabel, string> = {
  updateNow: 'update.android.updateNow',
  grantAndUpdate: 'update.android.grantAndUpdate',
  grantAgain: 'update.android.grantAgain',
  install: 'update.android.install',
  retry: 'update.android.retry',
};

/**
 * Android 应用内更新卡:发现更新、授权说明、下载进度与安装都在同一张内容高度的
 * Material 底部卡里切换。Mounted outside the business tree so forced updates have the same working installer.
 */
export function AndroidUpdateSheet() {
  const state = useSyncExternalStore(androidInstaller.subscribe, androidInstaller.getSnapshot);
  // close() resets to idle at once; keep the last card on screen while the sheet animates away.
  const lastShown = useRef<AndroidInstallState | null>(null);
  const visible = state.phase !== 'idle' && !state.silent;
  if (visible) lastShown.current = state;
  const shown = lastShown.current;
  return (
    <SheetModal
      nativePresentation
      backdropTestID="update.android.backdrop"
      onBackdropPress={androidInstaller.close}
      onRequestClose={androidInstaller.close}
      visible={visible}
    >
      {shown ? <AndroidUpdateCard state={shown} /> : null}
    </SheetModal>
  );
}

function AndroidUpdateCard({ state }: { state: AndroidInstallState }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const nativeSheet = useContext(NativeSheetContext);
  const viewport = usePaneViewport();
  const floating = useContext(FloatingSheetContext);
  const view = presentAndroidUpdate(state.phase, state.progress);
  const version = state.target?.version ?? '';
  const notes = state.target?.releaseNotes?.trim();
  const versionLine = APP_BINARY_VERSION && APP_BINARY_VERSION !== version
    ? t('update.android.versionChange', { current: APP_BINARY_VERSION, version })
    : t('update.android.version', { version });
  const NoteIcon = view.note === 'error' ? CircleAlert : ShieldCheck;
  return (
    <View
      style={[
        styles.card,
        !nativeSheet && styles.cardCompatible,
        // Centered floating windows are a free-standing card, not a bottom-attached sheet.
        !nativeSheet && floating && styles.cardFloating,
        // The Material container already pads for the navigation bar (same rule as SheetSurface).
        { paddingBottom: nativeSheet ? spacing.lg : Math.max(insets.bottom, spacing.md) + spacing.sm },
        // Short windows (landscape, split screen): the details scroll and the actions stay reachable.
        { maxHeight: nativeSheet ? nativeSheet.height : viewport.height - insets.top },
      ]}
      testID="update.android"
    >
      <ScrollView nestedScrollEnabled style={styles.body}>
        <View style={styles.header}>
          <Image accessibilityIgnoresInvertColors source={APP_ICON} style={styles.appIcon} />
          <View style={styles.headerText}>
            <Text accessibilityRole="header" numberOfLines={2} style={styles.title}>{t('update.newVersionTitle')}</Text>
            <Text numberOfLines={1} style={styles.version}>{versionLine}</Text>
          </View>
        </View>

        {notes ? (
          <View style={styles.notes}>
            <Text style={styles.notesSectionLabel}>{t('update.android.notesLabel')}</Text>
            <ScrollView nestedScrollEnabled style={styles.notesScroll}>
              <Text style={styles.notesBody}>{notes}</Text>
            </ScrollView>
          </View>
        ) : null}

        <View accessibilityLiveRegion="polite">
          {view.note ? (
            <View style={styles.note} testID={`update.android.note.${view.note}`}>
              <NoteIcon color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} style={styles.noteIcon} />
              <View style={styles.noteText}>
                <Text style={styles.noteTitle}>{t(NOTE_COPY[view.note].title)}</Text>
                <Text style={styles.noteBody}>{t(NOTE_COPY[view.note].body)}</Text>
              </View>
            </View>
          ) : null}

          {view.progress ? (
            <View style={styles.progress} testID="update.android.progress">
              <ProgressTrack value={view.progress.value} />
              <View style={styles.progressLine}>
                <Text style={styles.progressText}>
                  {t(view.progress.label === 'installing' ? 'update.android.installing' : 'update.android.downloading')}
                </Text>
                {view.progress.value !== null && view.progress.label === 'downloading' ? (
                  <Text style={styles.progressText}>
                    {t('update.android.percent', { percent: Math.floor(view.progress.value * 100) })}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : null}

          {view.ready ? (
            <View style={styles.ready}>
              <CircleCheck color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
              <Text style={styles.readyText}>{t('update.android.ready')}</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>

      <View style={styles.actions}>
        <MainWindowActionButton
          grow
          numberOfLines={0}
          action={{
            label: view.dismiss === 'cancel' ? t('update.android.cancel') : t('update.later'),
            onPress: androidInstaller.close,
            testID: 'update.android.cancel',
          }}
          style={[styles.actionButton, styles.secondaryButton]}
          textStyle={styles.actionLabel}
        />
        {view.primary ? (
          <MainWindowActionButton
            grow
            // Large system fonts and narrow panes wrap the label instead of truncating the main action.
            numberOfLines={0}
            action={{
              busy: view.primary.busy,
              label: t(PRIMARY_COPY[view.primary.label]),
              onPress: androidInstaller.retry,
              tone: 'primary',
              testID: 'update.android.retry',
            }}
            style={styles.actionButton}
            textStyle={styles.actionLabel}
          />
        ) : null}
      </View>

      {view.browser ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => { void androidInstaller.browser(); }}
          style={({ pressed }) => [styles.browser, pressed && styles.pressed]}
          testID="update.android.browser"
        >
          <Text style={styles.browserText}>{t('update.android.browser')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Thin determinate bar; unknown sizes sweep a short segment (held still when motion is reduced). */
function ProgressTrack({ value }: { value: number | null }) {
  const styles = useThemedStyles(makeStyles);
  const reduceMotion = useReduceMotionEnabled();
  const [width, setWidth] = useState(0);
  const sweep = useRef(new Animated.Value(0)).current;
  // Reduced motion (or not yet known) holds the segment still inside the track.
  const animating = value === null && reduceMotion === false && width > 0;
  useEffect(() => {
    if (!animating) return;
    sweep.setValue(0);
    const loop = Animated.loop(Animated.timing(sweep, {
      duration: 1200,
      easing: Easing.bezier(0.4, 0, 0.2, 1),
      toValue: 1,
      useNativeDriver: true,
    }));
    loop.start();
    return () => loop.stop();
  }, [animating, sweep]);
  const segment = width * INDETERMINATE_FRACTION;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={value === null ? undefined : { min: 0, max: 100, now: Math.floor(value * 100) }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={styles.track}
    >
      {value === null ? (
        <Animated.View
          style={[styles.fill, {
            width: segment,
            transform: [{ translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: indeterminateSweepRange(animating, segment, width) }) }],
          }]}
        />
      ) : (
        <View style={[styles.fill, { width: `${Math.max(0, Math.min(1, value)) * 100}%` }]} />
      )}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  card: { paddingHorizontal: SHEET_HORIZONTAL_PADDING, paddingTop: spacing.sm },
  // Foldable panes and floating windows use the compatibility shell, which has no Material container.
  cardCompatible: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderTopLeftRadius: radius.container,
    borderTopRightRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.xl,
  },
  body: { flexGrow: 0, flexShrink: 1 },
  cardFloating: { borderRadius: radius.container },
  header: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  appIcon: {
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    height: APP_ICON_SIZE,
    width: APP_ICON_SIZE,
  },
  headerText: { flex: 1 },
  title: { color: colors.textPrimary, fontSize: typeScale.title, fontWeight: fontWeight.semibold, lineHeight: lineHeight.title },
  version: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontVariant: ['tabular-nums'],
    lineHeight: lineHeight.caption,
  },
  notes: { marginTop: spacing.lg },
  notesSectionLabel: {
    color: colors.textTertiary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.caption,
    marginBottom: spacing.xs,
  },
  notesScroll: { maxHeight: NOTES_MAX_HEIGHT },
  notesBody: { color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  note: {
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
    padding: spacing.md,
  },
  // Centers the 16pt glyph on the 20pt title line.
  noteIcon: { marginTop: 2 },
  noteText: { flex: 1, gap: 2 },
  noteTitle: { color: colors.textPrimary, fontSize: typeScale.bodySmall, fontWeight: fontWeight.medium, lineHeight: lineHeight.bodySmall },
  noteBody: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  progress: { marginTop: spacing.lg },
  track: { backgroundColor: colors.surfaceChip, borderRadius: radius.pill, height: 4, overflow: 'hidden' },
  fill: { backgroundColor: colors.cta, borderRadius: radius.pill, height: '100%' },
  progressLine: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  progressText: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontVariant: ['tabular-nums'],
    lineHeight: lineHeight.caption,
  },
  ready: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  readyText: { color: colors.textSecondary, flex: 1, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl },
  // Secondary actions in a paired row are filled chips without a stroke (same as CompanionCardButton).
  // Wrapped labels keep breathing room inside the pill and stay centered.
  actionButton: { paddingVertical: spacing.sm },
  actionLabel: { textAlign: 'center' },
  secondaryButton: { backgroundColor: colors.surfaceChip, borderColor: colors.surfaceChip },
  browser: { alignItems: 'center', justifyContent: 'center', marginTop: spacing.xs, minHeight: 44 },
  browserText: { color: colors.textSecondary, fontSize: typeScale.footnote, fontWeight: fontWeight.medium, lineHeight: lineHeight.caption },
  pressed: { opacity: 0.72 },
});
