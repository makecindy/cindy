import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/AppText';
import { ErrorNotice } from '@/components/ErrorNotice';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { SessionDetailsNative, SessionDetailsNativeActions, type SessionDetailsAction } from './SessionDetailsNative';
import { SheetModal } from './SheetModal';
import { SheetSurface } from './SheetSurface';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from './contextSheetModel';
import type { RemoteSession } from './types';
import { fontWeight, lineHeight, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

/** This picker only owns selection; the existing task page owns every editor. */
export function SideChatsSheet({ visible, session, maker, onClose, onCreate, onSelect }: {
  visible: boolean;
  session: RemoteSession;
  maker: Pick<MobileMakerTransport, 'listSideChats' | 'getSession'>;
  onClose(): void;
  onCreate(): Promise<RemoteSession | null>;
  onSelect(session: RemoteSession): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [snap, setSnap] = useState<ContextSheetSnap>('half');
  const heights = useMemo(() => computeContextSheetSnapHeights({ safeAreaTopInset: insets.top, screenHeight: height }), [height, insets.top]);
  const parentId = session.source === 'side-chat' ? session.parentSessionId : session.id;
  const [rows, setRows] = useState<RemoteSession[]>([]);
  const [parent, setParent] = useState<RemoteSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const selected = useRef<RemoteSession | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const epoch = ++generation.current;
    if (!visible || !parentId) return;
    selected.current = null;
    setLoading(true);
    setCreating(false);
    setError(null);
    setRows([]);
    setParent(null);
    setSnap('half');
    void Promise.all([
      maker.getSession(parentId),
      maker.listSideChats(parentId).then(ids => Promise.all(ids.map(({ id }) => maker.getSession(id)))),
    ]).then(([main, children]) => {
      if (generation.current !== epoch) return;
      setParent(main?.status === 'active' ? main : null);
      setRows(children.filter(row => (row?.status === 'active' || row?.status === 'archived')
        && row.source === 'side-chat' && row.parentSessionId === parentId));
    }).catch(() => {
      if (generation.current === epoch) setError(t('session.sideChat.loadFailed'));
    }).finally(() => { if (generation.current === epoch) setLoading(false); });
    return () => { ++generation.current; };
  }, [visible, parentId, maker, attempt, t]);

  const choose = useCallback((row: RemoteSession) => {
    selected.current = row;
    onClose();
  }, [onClose]);
  const closed = () => {
    const row = selected.current;
    selected.current = null;
    if (row) onSelect(row);
  };
  const create = async () => {
    if (creating || !parent) return;
    const epoch = generation.current;
    setCreating(true);
    const row = await onCreate();
    if (generation.current !== epoch) return;
    setCreating(false);
    if (row) choose(row);
    else setError(t('session.sideChat.createFailed'));
  };
  const actions: SessionDetailsAction[] = [
    ...(session.source === 'side-chat' && parent ? [{
      label: t('session.sideChat.returnMain'), testID: 'session.sideChat.parent',
      onPress: () => choose(parent),
    }] : []),
    { label: t('session.sideChat.create'), testID: 'session.sideChat.create',
      disabled: loading || creating || !parent, onPress: () => void create() },
    ...rows.map((row, index) => ({
      label: `${t('session.sideChat.item', { index: index + 1 })}${row.status === 'archived' ? ` · ${t('session.menu.chipArchived')}` : ''}${row.id === session.id ? ` · ${t('session.sideChat.current')}` : ''}`,
      testID: `session.sideChat.open.${row.id}`, disabled: row.id === session.id || creating,
      onPress: () => choose(row),
    })),
  ];
  const content = <View style={styles.content}>
    <Text style={styles.notice}>{t('session.sideChat.description')}</Text>
    {error ? <ErrorNotice message={error} actions={<MainWindowActionButton action={{ label: t('session.screen.retry'), onPress: () => setAttempt(value => value + 1) }} />} /> : null}
    {loading || creating ? <ActivityIndicator color={colors.textSecondary} /> : null}
    {Platform.OS === 'ios' ? <SessionDetailsNativeActions actions={actions} />
      : <View style={styles.content}>{actions.map(action => <MainWindowActionButton key={action.testID} action={action} numberOfLines={0} />)}</View>}
    {!loading && !error && rows.length === 0 ? <Text style={styles.notice}>{t('session.sideChat.empty')}</Text> : null}
  </View>;
  return Platform.OS === 'ios'
    ? <SessionDetailsNative visible={visible} title={t('session.sideChat.title')} backLabel={t('shared.back')}
        onClose={onClose} onClosed={closed}>{content}</SessionDetailsNative>
    : <SheetModal nativePresentation visible={visible} onBackdropPress={onClose} onRequestClose={onClose} onClosed={closed}>
        <SheetSurface title={t('session.sideChat.title')} onClose={onClose} heights={heights} snap={snap}
          onSnapChange={setSnap} bottomInset={insets.bottom} testID="session.sideChat.sheet">{content}</SheetSurface>
      </SheetModal>;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    content: { gap: spacing.md, paddingHorizontal: spacing.md },
    notice: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  });
}
