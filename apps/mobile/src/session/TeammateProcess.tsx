import { useTranslation } from 'react-i18next';
import { formatLocalizedDuration } from './sessionDurationFormat';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, View } from 'react-native';
import { ChevronRight, Layers, Sparkles, Terminal, CircleAlert } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { spacing, typeScale, lineHeight, listDisclosureMotion, iconSize } from '@/theme/tokens';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { useFoldableExpandedState } from './expandedBlockMemory';

const InspectProcess = createContext<(() => void) | null>(null);
const ProcessRailEnd = createContext<((inset: number) => void) | null>(null);

// A footer's visible line box ends before its 44pt touch target. Keep that extra
// space tappable, but exclude it from the decorative guide (also at larger text sizes).
function useProcessFooterInset(active: boolean, enabled = true) {
  const setInset = useContext(ProcessRailEnd);
  const [rowHeight, setRowHeight] = useState(44);
  const [textHeight, setTextHeight] = useState<number>(lineHeight.caption);
  useLayoutEffect(() => {
    if (!enabled) return;
    setInset?.(active ? Math.max(0, (rowHeight - textHeight) / 2) : 0);
    return () => setInset?.(0);
  }, [setInset, active, enabled, rowHeight, textHeight]);
  return { setRowHeight, setTextHeight };
}

/** A quiet entry into the original task, with the same touch target as disclosures. */
export function TeammateProcessLink({ title, onPress }: { title: string; onPress(): void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const footer = useProcessFooterInset(true);
  return <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress} style={styles.header}
    onLayout={event => footer.setRowHeight(event.nativeEvent.layout.height)}>
    <Text style={[styles.title, styles.secondary]} onLayout={event => footer.setTextHeight(event.nativeEvent.layout.height)}>{title}</Text>
    <ChevronRight size={iconSize.sm} color={colors.textTertiary} />
  </Pressable>;
}

/** One turn, one guide. Public notes remain selectable; only the header owns a gesture. */
export function TeammateProcess({ id, title, running = false, children, secondary = false, statusIcon, railFooter = false }: {
  id: string;
  title: string;
  running?: boolean;
  secondary?: boolean;
  statusIcon?: ReactNode;
  railFooter?: boolean;
  children: ReactNode | ((expanded: boolean) => ReactNode);
}) {
  const { colors } = useTheme();
  const inspectParent = useContext(InspectProcess);
  const reduceMotion = useReduceMotionEnabled();
  const styles = useThemedStyles(makeStyles);
  const [stored, toggleStored] = useFoldableExpandedState(id, false);
  const [manual, toggleManual] = useFoldableExpandedState(`${id}:manual`, false);
  const [automatic, setAutomatic] = useState(running && !secondary);
  const previousRunning = useRef(running);
  useEffect(() => {
    if (previousRunning.current === running) return;
    previousRunning.current = running;
    if (!manual) setAutomatic(running && !secondary);
  }, [running, manual, secondary]);
  const expanded = manual ? stored : automatic;
  const footer = useProcessFooterInset(secondary && !expanded, secondary && railFooter);
  const [railEndInset, setRailEndInset] = useState(0);
  const rotation = useRef(new Animated.Value(expanded ? 1 : 0)).current;
  useEffect(() => {
    const animation = Animated.timing(rotation, { toValue: expanded ? 1 : 0,
      duration: reduceMotion === false ? listDisclosureMotion.duration : 0, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [expanded, rotation, reduceMotion]);
  const inspect = () => {
    if (!manual) { if (!stored) toggleStored(); toggleManual(); }
    inspectParent?.();
  };
  const toggle = () => {
    inspectParent?.();
    if (stored !== !expanded) toggleStored();
    if (!manual) toggleManual();
  };
  const [mounted, setMounted] = useState(expanded);
  const [contentHeight, setContentHeight] = useState(0);
  const height = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (expanded) setMounted(true);
    const animation = Animated.timing(height, { toValue: expanded ? contentHeight : 0,
      duration: reduceMotion === false ? listDisclosureMotion.duration : 0, useNativeDriver: false });
    animation.start(({ finished }) => { if (finished && !expanded) setMounted(false); });
    return () => animation.stop();
  }, [expanded, contentHeight, height, reduceMotion]);
  return <View style={styles.container}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={title}
        onPress={toggle} testID={secondary ? 'message.processRecords' : 'message.teammateProcess'}
        style={styles.header} onLayout={event => footer.setRowHeight(event.nativeEvent.layout.height)}>
        {(statusIcon || !secondary) && <View style={styles.statusIcon}>{statusIcon ?? <>{running ? <ActivityIndicator color={colors.textSecondary} size="small" style={styles.spinner} />
          : <Layers size={iconSize.sm} color={colors.textSecondary} />}</>}</View>}
        <Text style={[styles.title, secondary && styles.secondary]} onLayout={event => footer.setTextHeight(event.nativeEvent.layout.height)}>{title}</Text>
        <Animated.View style={{ transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] }) }] }}>
          <ChevronRight size={iconSize.sm} color={colors.textTertiary} />
        </Animated.View>
      </Pressable>
      {(expanded || mounted) && <Animated.View style={{ height, overflow: 'hidden' }}
        accessibilityElementsHidden={!expanded} importantForAccessibility={expanded ? 'auto' : 'no-hide-descendants'}>
        <View style={styles.measuredBody} onLayout={event => setContentHeight(event.nativeEvent.layout.height)}>
          <View style={secondary ? styles.records : styles.guide}>
            {!secondary && <View pointerEvents="none" testID="message.processGuide" style={[styles.rail, { bottom: spacing.xs + railEndInset }]} />}
            <ProcessRailEnd.Provider value={secondary ? null : setRailEndInset}>
              <InspectProcess.Provider value={inspect}>{typeof children === 'function' ? children(expanded) : children}</InspectProcess.Provider>
            </ProcessRailEnd.Provider>
          </View>
        </View>
      </Animated.View>}
  </View>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: { minWidth: 0 },
  measuredBody: { position: 'absolute', left: 0, right: 0, top: 0 },
  header: { alignSelf: 'flex-start', maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
  statusIcon: { width: 14, height: 20, alignItems: 'center', justifyContent: 'center' },
  spinner: { transform: [{ scale: 0.7 }] },
  title: { flexShrink: 1, color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  secondary: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  // Icon center = 7; title origin = 14 + 8. Body and title share that origin.
  guide: { marginLeft: 7, paddingLeft: 7 + spacing.sm, gap: spacing.md, paddingBottom: spacing.xs },
  rail: { position: 'absolute', left: -0.5, top: 0, width: 1, backgroundColor: colors.border },
  records: { gap: spacing.xs, paddingLeft: 22 },
  segmentStatus: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 28 },
});

/** Shared visual for private/group work segments; no raw reasoning is rendered. */
export function TeammateWorkSegment({ id, title, running, hasTools, failed, children, last = false }: {
  id: string; title: string; running: boolean; hasTools: boolean; failed: boolean; children?: ReactNode; last?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  if (!hasTools) return <View style={styles.segmentStatus}>
    <View style={styles.statusIcon}>{running ? <ActivityIndicator color={colors.textSecondary} size="small" style={styles.spinner} /> : <Sparkles size={iconSize.sm} color={colors.textSecondary} />}</View>
    <Text style={styles.title}>{title}</Text>
  </View>;
  return <TeammateProcess id={id} secondary railFooter={last} running={running} title={title}
    statusIcon={failed ? <CircleAlert size={iconSize.sm} color={colors.errorText} /> : running ? <ActivityIndicator color={colors.textSecondary} size="small" style={styles.spinner} /> : <Terminal size={iconSize.sm} color={colors.textSecondary} />}>
    {children}
  </TeammateProcess>;
}

export function useTeammateElapsedTitle(running: boolean, startedAtMs?: number, durationMs?: number): string {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || startedAtMs === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAtMs]);
  const elapsed = running && startedAtMs !== undefined ? Math.max(0, now - startedAtMs) : durationMs;
  return elapsed !== undefined && Number.isFinite(elapsed)
    ? t(running ? 'chat.teammateProcess.elapsed' : 'chat.teammateProcess.took', { duration: formatLocalizedDuration(elapsed) })
    : t(running ? 'chat.teammateProcess.processing' : 'chat.teammateProcess.worked');
}
