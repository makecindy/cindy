import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Check, GitBranch, MessageSquare } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/AppText';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { SheetModal } from '@/session/SheetModal';
import { SheetSurface } from '@/session/SheetSurface';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from '@/session/contextSheetModel';
import { iconSize, iconStroke, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import {
  parseMobilePiSessionTree,
  type MobilePiSessionTreeNode,
  type MobilePiSessionTreeSnapshot,
} from '@/session/piSessionTreeModel';

export { parseMobilePiSessionTree } from '@/session/piSessionTreeModel';

export function PiSessionTreeSheet({
  disabledReason,
  maker,
  onClose,
  onNavigated,
  sessionId,
  visible,
}: {
  disabledReason?: string | null;
  maker: Pick<MobileMakerTransport, 'getSessionTree' | 'navigateSessionTree'>;
  onClose(): void;
  onNavigated(draftText?: string): void | Promise<void>;
  sessionId: string;
  visible: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [snap, setSnap] = useState<ContextSheetSnap>('half');
  const [tree, setTree] = useState<MobilePiSessionTreeSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heights = useMemo(
    () => computeContextSheetSnapHeights({ safeAreaTopInset: insets.top, screenHeight: height }),
    [height, insets.top],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = parseMobilePiSessionTree(await maker.getSessionTree(sessionId));
      setTree(next);
      if (!next) setError(t('session.menu.branchLoadFailed'));
    } catch {
      setTree(null);
      setError(t('session.menu.branchLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [maker, sessionId, t]);

  useEffect(() => {
    if (!visible) return;
    setSnap('half');
    setSwitchingId(null);
    void load();
  }, [load, visible]);

  const navigate = useCallback(async (node: MobilePiSessionTreeNode) => {
    if (disabledReason || switchingId || node.id === tree?.leafId) return;
    setSwitchingId(node.id);
    setError(null);
    try {
      const result = await maker.navigateSessionTree(sessionId, node.id);
      if (!result || result.cancelled) return;
      const next = parseMobilePiSessionTree(result.tree);
      if (next) setTree(next);
      await onNavigated(result.draftText);
    } catch {
      setError(t('session.menu.branchSwitchFailed'));
    } finally {
      setSwitchingId(null);
    }
  }, [disabledReason, maker, onNavigated, sessionId, switchingId, t, tree?.leafId]);

  const renderNode = (node: MobilePiSessionTreeNode, depth: number): ReactNode => {
    const active = tree?.activePathIds.includes(node.id) === true;
    const current = tree?.leafId === node.id;
    const busy = switchingId !== null;
    return (
      <View key={node.id}>
        <Pressable
          accessibilityHint={disabledReason ?? undefined}
          accessibilityLabel={node.label || node.preview || t('session.menu.branchEmptyEntry')}
          accessibilityRole="button"
          disabled={!!disabledReason || busy || current}
          onPress={() => void navigate(node)}
          style={({ pressed }) => [
            styles.node,
            { paddingLeft: spacing.md + depth * spacing.lg },
            active && styles.nodeActive,
            pressed && styles.nodePressed,
          ]}
          testID={`session.branch.${node.id}`}
        >
          <View style={[styles.nodeIcon, active && styles.nodeIconActive]}>
            {switchingId === node.id ? (
              <ActivityIndicator color={colors.textPrimary} size="small" />
            ) : current ? (
              <Check color={colors.textPrimary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
            ) : node.children.length > 1 ? (
              <GitBranch color={active ? colors.textPrimary : colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
            ) : (
              <MessageSquare color={active ? colors.textPrimary : colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
            )}
          </View>
          <View style={styles.nodeText}>
            <Text numberOfLines={1} style={styles.nodeLabel}>
              {node.label || t(`session.menu.branchRole.${node.role ?? 'system'}`)}
              {current ? ` · ${t('session.menu.branchCurrent')}` : ''}
            </Text>
            <Text numberOfLines={2} style={styles.nodePreview}>
              {node.preview || t('session.menu.branchEmptyEntry')}
            </Text>
          </View>
        </Pressable>
        {node.children.map((child) => renderNode(child, depth + 1))}
      </View>
    );
  };

  return (
    <SheetModal visible={visible} onBackdropPress={onClose} onRequestClose={onClose}>
      <SheetSurface
        bottomInset={insets.bottom}
        heights={heights}
        onClose={onClose}
        onSnapChange={setSnap}
        snap={snap}
        testID="session.branchSheet"
        title={t('session.menu.branches')}
        variant="tasksheet"
      >
        {disabledReason ? <Text style={styles.notice}>{disabledReason}</Text> : null}
        {error ? (
          <Pressable onPress={() => void load()} style={styles.noticeButton}>
            <Text style={styles.error}>{error}</Text>
            <Text style={styles.retry}>{t('session.screen.retry')}</Text>
          </Pressable>
        ) : null}
        {loading ? (
          <View style={styles.loading}><ActivityIndicator color={colors.textSecondary} /></View>
        ) : tree && tree.roots.length > 0 ? (
          tree.roots.map((node) => renderNode(node, 0))
        ) : !error ? (
          <Text style={styles.empty}>{t('session.menu.branchEmpty')}</Text>
        ) : null}
      </SheetSurface>
    </SheetModal>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    empty: { color: colors.textTertiary, fontSize: typeScale.listBody, padding: spacing.xl, textAlign: 'center' },
    error: { color: colors.errorText, flex: 1, fontSize: typeScale.listBody },
    loading: { alignItems: 'center', minHeight: 120, justifyContent: 'center' },
    node: { alignItems: 'flex-start', borderRadius: radius.container, flexDirection: 'row', gap: spacing.sm, minHeight: 54, paddingRight: spacing.md, paddingVertical: spacing.sm },
    nodeActive: { backgroundColor: colors.surfaceElevated },
    nodeIcon: { alignItems: 'center', borderColor: colors.border, borderRadius: radius.container, borderWidth: StyleSheet.hairlineWidth, height: 24, justifyContent: 'center', marginTop: 2, width: 24 },
    nodeIconActive: { borderColor: colors.borderStrong },
    nodeLabel: { color: colors.textTertiary, fontSize: typeScale.caption },
    nodePressed: { opacity: 0.7 },
    nodePreview: { color: colors.textPrimary, fontSize: typeScale.listBody, lineHeight: lineHeight.listBody },
    nodeText: { flex: 1, gap: 2 },
    notice: { color: colors.textSecondary, fontSize: typeScale.listBody, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
    noticeButton: { alignItems: 'center', backgroundColor: colors.surfaceElevated, borderRadius: radius.container, flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm, marginHorizontal: spacing.md, padding: spacing.md },
    retry: { color: colors.textPrimary, fontSize: typeScale.listBody, fontWeight: fontWeight.semibold },
  });
}
