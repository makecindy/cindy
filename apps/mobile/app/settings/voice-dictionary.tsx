import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import {
  DEVICE_LINK_VOICE_DICTIONARY_GET_CHANNEL,
  DEVICE_LINK_VOICE_DICTIONARY_MUTATE_CHANNEL,
  type MobileVoiceDictionaryMutateRequest,
  type MobileVoiceDictionaryMutateResult,
  type MobileVoiceDictionarySnapshotResult,
} from '@cindy/maker-shared/device-link-contract';
import { Text, TextInput } from '@/components/AppText';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { SimpleStackHeader, simpleScrollInsetProps, simpleScrollScreenSafeAreaEdges } from '@/platform/chrome';
import {
  applyMobileVoiceDictionarySnapshot,
  hydrateAllCachedMobileVoiceDictionaries,
  hydrateMobileVoiceDictionary,
  readCachedMobileVoiceDictionarySnapshot,
  refreshMobileVoiceDictionary,
  subscribeMobileVoiceDictionaryCache,
} from '@/session/mobileVoiceDictionaryCache';
import {
  buildMobileVoiceDictionaryEntryViews,
  type MobileVoiceDictionaryEntryView,
} from '@/session/mobileVoiceDictionaryView';
import { useSettingsDeviceDirectory } from '@/session/settingsDeviceDirectory';
import { useSettingsRowStyles } from '@/session/SettingsGroupRows';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, radius, spacing, textStyles, typeScale } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';

type EditorMode =
  | { kind: 'add' }
  | { kind: 'edit'; entry: MobileVoiceDictionaryEntryView };

function parseAliasLines(raw: string): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const part of raw.split(/\r?\n/)) {
    const cleaned = part.trim();
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    aliases.push(cleaned);
  }
  return aliases;
}

function isChannelNotAllowedError(error: unknown): boolean {
  if (!error) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'CHANNEL_NOT_ALLOWED') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('CHANNEL_NOT_ALLOWED');
}

/**
 * 语音词典管理页（设置的二级页）。
 *
 * 词典 CRDT 真相在桌面端：
 * - 完全离线时，从当前账号分区的本地缓存水合上次同步的快照，支持离线浏览与搜索。
 * - 有同账号在线电脑时，可直接新增、编辑词条与别名或删除，变更经桌面 CRDT 落盘并
 *   自动同步到所有桌面与手机；旧版桌面回 `CHANNEL_NOT_ALLOWED` 时平滑降级为只读视图。
 */
export default function VoiceDictionaryScreen() {
  const router = useRouter();
  const rowStyles = useSettingsRowStyles();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { invoke } = useDeviceLink();
  const { desktopDevices } = useSettingsDeviceDirectory();
  const [refreshing, setRefreshing] = useState(false);
  /** 缓存在模块里,组件用这个计数强制重渲染(每次刷新/水合完成 +1)。 */
  const [dictionaryRevision, setDictionaryRevision] = useState(0);
  /** 盘上已有缓存的 host ID，保证离线且 desktopDevices 为空时也能浏览缓存词典。 */
  const [cachedHostIds, setCachedHostIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [editorMode, setEditorMode] = useState<EditorMode | null>(null);
  const [termDraft, setTermDraft] = useState('');
  const [aliasesDraft, setAliasesDraft] = useState('');
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [desktopUpgradeRequired, setDesktopUpgradeRequired] = useState(false);

  const onlineDesktops = useMemo(
    () => desktopDevices.filter((host) => host.online),
    [desktopDevices],
  );

  // 当在线电脑列表变化（如新设备上线/升级后重连），重置旧端降级标记。
  useEffect(() => {
    setDesktopUpgradeRequired(false);
  }, [onlineDesktops]);

  // 首屏立即从盘上水合当前账号的全部缓存 host，即便完全离线（desktopDevices=[]）也立即可看。
  useEffect(() => {
    let cancelled = false;
    void hydrateAllCachedMobileVoiceDictionaries()
      .then((hosts) => {
        if (cancelled) return;
        setCachedHostIds(hosts);
        setDictionaryRevision((value) => value + 1);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 向所有在线电脑各拉一次词典快照。
   * 失败一律静默:电脑离线、没开「允许被控」、老版本不认识这个 channel 都是常态,
   * 页面继续显示上次缓存,不弹错。
   */
  const refreshVoiceDictionary = useCallback(() => {
    if (onlineDesktops.length === 0) return;
    setRefreshing(true);
    void Promise.all(
      onlineDesktops.map((host) => refreshMobileVoiceDictionary(
        host.deviceId,
        () => invoke<MobileVoiceDictionarySnapshotResult>(
          host.deviceId,
          DEVICE_LINK_VOICE_DICTIONARY_GET_CHANNEL,
          [],
        ),
        { force: true },
      )),
    ).finally(() => {
      setRefreshing(false);
      setDictionaryRevision((value) => value + 1);
    });
  }, [invoke, onlineDesktops]);

  // 设备清单到达时把列表里的电脑也水合一遍，并拉取最新快照。
  useEffect(() => {
    if (desktopDevices.length === 0) return;
    let cancelled = false;
    void Promise.all(desktopDevices.map((host) => hydrateMobileVoiceDictionary(host.deviceId)))
      .then(() => {
        if (!cancelled) setDictionaryRevision((value) => value + 1);
      })
      .catch(() => undefined);
    refreshVoiceDictionary();
    return () => {
      cancelled = true;
    };
  }, [desktopDevices, refreshVoiceDictionary]);

  useEffect(() => subscribeMobileVoiceDictionaryCache(() => {
    setDictionaryRevision((value) => value + 1);
  }), []);

  const allHostIds = useMemo(() => {
    const ids = new Set<string>();
    for (const host of desktopDevices) ids.add(host.deviceId);
    for (const hostId of cachedHostIds) ids.add(hostId);
    return [...ids];
  }, [cachedHostIds, desktopDevices]);

  // dictionaryRevision 只作为依赖存在:缓存是模块级的,刷新完成后靠它触发重算。
  const entries = useMemo(
    () =>
      buildMobileVoiceDictionaryEntryViews(
        allHostIds.map((hostId) => readCachedMobileVoiceDictionarySnapshot(hostId)),
        { maxAliases: Number.POSITIVE_INFINITY },
      ),
    [allHostIds, dictionaryRevision],
  );

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter(
      (entry) =>
        entry.text.toLowerCase().includes(query)
        || entry.aliases.some((alias) => alias.toLowerCase().includes(query)),
    );
  }, [entries, searchQuery]);

  const canMutate = onlineDesktops.length > 0 && !desktopUpgradeRequired;

  const openAddEditor = useCallback(() => {
    if (!canMutate) return;
    setEditorMode({ kind: 'add' });
    setTermDraft('');
    setAliasesDraft('');
    setEditorError(null);
  }, [canMutate]);

  const openEditEditor = useCallback((entry: MobileVoiceDictionaryEntryView) => {
    if (!canMutate) return;
    setEditorMode({ kind: 'edit', entry });
    setTermDraft(entry.text);
    setAliasesDraft(entry.aliases.join('\n'));
    setEditorError(null);
  }, [canMutate]);

  const closeEditor = useCallback(() => {
    if (saving) return;
    setEditorMode(null);
    setEditorError(null);
  }, [saving]);

  const submitMutation = useCallback(async (request: MobileVoiceDictionaryMutateRequest): Promise<boolean> => {
    if (onlineDesktops.length === 0) {
      setEditorError(t('settings.voiceDictionary.offlineHint'));
      return false;
    }
    setSaving(true);
    setEditorError(null);
    let sawNotAllowed = false;
    let lastErrorMessage: string | null = null;
    try {
      for (const host of onlineDesktops) {
        try {
          const result = await invoke<MobileVoiceDictionaryMutateResult>(
            host.deviceId,
            DEVICE_LINK_VOICE_DICTIONARY_MUTATE_CHANNEL,
            [request],
          );
          if (result?.ok) {
            await applyMobileVoiceDictionarySnapshot(host.deviceId, result.snapshot);
            setCachedHostIds((prev) => (prev.includes(host.deviceId) ? prev : [...prev, host.deviceId]));
            setDictionaryRevision((value) => value + 1);
            return true;
          }
          lastErrorMessage = result?.error || t('settings.voiceDictionary.saveFailed');
        } catch (error) {
          if (isChannelNotAllowedError(error)) {
            sawNotAllowed = true;
            continue;
          }
          lastErrorMessage = error instanceof Error ? error.message : String(error);
        }
      }
      if (sawNotAllowed && !lastErrorMessage) {
        setDesktopUpgradeRequired(true);
        setEditorMode(null);
        return false;
      }
      setEditorError(lastErrorMessage || t('settings.voiceDictionary.saveFailed'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [invoke, onlineDesktops, t]);

  const handleSave = useCallback(() => {
    if (!editorMode || saving) return;
    const trimmedTerm = termDraft.trim();
    if (!trimmedTerm) {
      setEditorError(t('settings.voiceDictionary.termRequired'));
      return;
    }
    const aliases = parseAliasLines(aliasesDraft);
    const request: MobileVoiceDictionaryMutateRequest =
      editorMode.kind === 'add'
        ? { action: 'add', text: trimmedTerm, aliases }
        : { action: 'edit', originalText: editorMode.entry.text, text: trimmedTerm, aliases };
    void submitMutation(request).then((ok) => {
      if (ok) setEditorMode(null);
    });
  }, [aliasesDraft, editorMode, saving, submitMutation, t, termDraft]);

  const handleDelete = useCallback(() => {
    if (!editorMode || editorMode.kind !== 'edit' || saving) return;
    const targetText = editorMode.entry.text;
    Alert.alert(
      t('settings.voiceDictionary.deleteConfirmTitle'),
      t('settings.voiceDictionary.deleteConfirmMessage', { term: targetText }),
      [
        { text: t('settings.voiceDictionary.cancel'), style: 'cancel' },
        {
          text: t('settings.voiceDictionary.delete'),
          style: 'destructive',
          onPress: () => {
            void submitMutation({ action: 'delete', text: targetText }).then((ok) => {
              if (ok) setEditorMode(null);
            });
          },
        },
      ],
    );
  }, [editorMode, saving, submitMutation, t]);

  const footer = desktopUpgradeRequired
    ? t('settings.voiceDictionary.upgradeDesktopHint')
    : desktopDevices.length === 0
      ? (entries.length > 0
        ? t('settings.voiceDictionary.offlineHint')
        : t('settings.voiceDictionary.noDesktops'))
      : onlineDesktops.length === 0
        ? t('settings.voiceDictionary.offlineHint')
        : t('settings.voiceDictionary.editableHint');

  return (
    <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={styles.safeArea} testID="settings.voiceDictionary.screen">
      <SimpleStackHeader
        scrollEdge
        backTestID="settings.voiceDictionary.backButton"
        onBack={() => goBackGuarded(router, '/settings')}
        title={t('settings.voiceDictionary.screenTitle')}
      />
      <FlatList
        {...simpleScrollInsetProps}
        ListEmptyComponent={
          entries.length > 0 && searchQuery.trim() ? (
            <View style={styles.listCardMiddle}>
              <View style={rowStyles.divider} />
              <View style={rowStyles.row}>
                <Text style={styles.emptySearchText}>{t('settings.voiceDictionary.noSearchResults')}</Text>
              </View>
            </View>
          ) : undefined
        }
        ListFooterComponent={
          <>
            <View style={styles.listCardBottom} />
            <Text style={rowStyles.groupFooter}>{footer}</Text>
          </>
        }
        ListHeaderComponent={
          <>
            <View style={styles.searchBox}>
              <TextInput
                accessibilityLabel={t('settings.voiceDictionary.searchPlaceholder')}
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
                onChangeText={setSearchQuery}
                placeholder={t('settings.voiceDictionary.searchPlaceholder')}
                placeholderTextColor={colors.textPlaceholder}
                returnKeyType="search"
                style={styles.searchInput}
                testID="settings.voiceDictionary.search"
                value={searchQuery}
              />
            </View>
            <View style={rowStyles.groupTitleRow}>
              <Text accessibilityRole="header" style={rowStyles.groupTitle}>{t('settings.voiceDictionary.sectionTitle')}</Text>
            </View>
            <View style={styles.listCardTop}>
              <Pressable
                accessibilityLabel={t('settings.voiceDictionary.refreshAccessibility')}
                accessibilityRole="button"
                accessibilityState={{ busy: refreshing || undefined }}
                disabled={onlineDesktops.length === 0}
                onPress={refreshVoiceDictionary}
                style={({ pressed }) => [rowStyles.row, pressed && onlineDesktops.length > 0 && rowStyles.pressed]}
                testID="settings.voiceDictionary.refresh"
              >
                <View style={rowStyles.rowLine}>
                  <Text style={rowStyles.rowLabel}>
                    {t('settings.voiceDictionary.entryCount', { count: entries.length })}
                  </Text>
                  {onlineDesktops.length > 0 ? (
                    <Text style={rowStyles.rowValue} numberOfLines={1}>
                      {refreshing
                        ? t('settings.voiceDictionary.refreshing')
                        : t('settings.voiceDictionary.refresh')}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
              {canMutate ? (
                <>
                  <View style={rowStyles.divider} />
                  <Pressable
                    accessibilityLabel={t('settings.voiceDictionary.addEntry')}
                    accessibilityRole="button"
                    onPress={openAddEditor}
                    style={({ pressed }) => [rowStyles.row, pressed && rowStyles.pressed]}
                    testID="settings.voiceDictionary.add"
                  >
                    <View style={rowStyles.rowLine}>
                      <Text style={rowStyles.rowLabel}>{t('settings.voiceDictionary.addEntry')}</Text>
                      <Text style={rowStyles.rowValue}>+</Text>
                    </View>
                  </Pressable>
                </>
              ) : null}
            </View>
          </>
        }
        contentContainerStyle={styles.listContent}
        data={filteredEntries}
        keyExtractor={(entry) => entry.key}
        renderItem={({ item }) => (
          <View style={styles.listCardMiddle}>
            <View style={rowStyles.divider} />
            <Pressable
              accessibilityHint={canMutate ? t('settings.voiceDictionary.tapToEditHint') : undefined}
              accessibilityRole={canMutate ? 'button' : 'text'}
              disabled={!canMutate}
              onPress={() => openEditEditor(item)}
              style={({ pressed }) => [rowStyles.row, canMutate && pressed && rowStyles.pressed]}
              testID={`settings.voiceDictionary.entry.${item.key}`}
            >
              <View style={rowStyles.rowLine}>
                <Text style={rowStyles.rowLabel} numberOfLines={2}>{item.text}</Text>
                {canMutate ? (
                  <Text style={rowStyles.rowValue} numberOfLines={1}>{t('settings.voiceDictionary.edit')}</Text>
                ) : null}
              </View>
              {item.aliases.length > 0 ? (
                <Text style={rowStyles.rowDetail} numberOfLines={2}>
                  {t('settings.voiceDictionary.aliases', {
                    aliases: item.aliases.slice(0, 3).join(t('settings.voiceDictionary.aliasSeparator')),
                  })}
                </Text>
              ) : null}
            </Pressable>
          </View>
        )}
        testID="settings.voiceDictionary.scroll"
      />

      <Modal
        animationType="fade"
        onRequestClose={closeEditor}
        transparent
        visible={editorMode !== null}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalBackdrop}
        >
          <View style={styles.modalCard}>
            <Text accessibilityRole="header" style={styles.modalTitle}>
              {editorMode?.kind === 'add'
                ? t('settings.voiceDictionary.addModalTitle')
                : t('settings.voiceDictionary.editModalTitle')}
            </Text>

            <Text style={styles.fieldLabel}>{t('settings.voiceDictionary.termLabel')}</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              editable={!saving}
              onChangeText={setTermDraft}
              placeholder={t('settings.voiceDictionary.termPlaceholder')}
              placeholderTextColor={colors.textPlaceholder}
              style={styles.singleLineInput}
              testID="settings.voiceDictionary.editor.term"
              value={termDraft}
            />

            <Text style={styles.fieldLabel}>{t('settings.voiceDictionary.aliasesLabel')}</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              editable={!saving}
              multiline
              onChangeText={setAliasesDraft}
              placeholder={t('settings.voiceDictionary.aliasesPlaceholder')}
              placeholderTextColor={colors.textPlaceholder}
              style={styles.multilineInput}
              testID="settings.voiceDictionary.editor.aliases"
              textAlignVertical="top"
              value={aliasesDraft}
            />
            <Text style={styles.fieldHint}>{t('settings.voiceDictionary.aliasesHint')}</Text>

            {editorError ? (
              <Text style={styles.errorText}>{editorError}</Text>
            ) : null}

            <View style={styles.modalActions}>
              {editorMode?.kind === 'edit' ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={saving}
                  onPress={handleDelete}
                  style={({ pressed }) => [styles.secondaryButton, pressed && rowStyles.pressed]}
                  testID="settings.voiceDictionary.editor.delete"
                >
                  <Text style={styles.destructiveText}>{t('settings.voiceDictionary.delete')}</Text>
                </Pressable>
              ) : null}
              <View style={styles.modalRightActions}>
                <Pressable
                  accessibilityRole="button"
                  disabled={saving}
                  onPress={closeEditor}
                  style={({ pressed }) => [styles.secondaryButton, pressed && rowStyles.pressed]}
                  testID="settings.voiceDictionary.editor.cancel"
                >
                  <Text style={styles.secondaryButtonText}>{t('settings.voiceDictionary.cancel')}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ busy: saving || undefined }}
                  disabled={saving}
                  onPress={handleSave}
                  style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
                  testID="settings.voiceDictionary.editor.save"
                >
                  <Text style={styles.primaryButtonText}>
                    {saving ? t('settings.voiceDictionary.saving') : t('settings.voiceDictionary.save')}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  listContent: { paddingBottom: spacing.xxl, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  searchBox: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.lg,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  searchInput: {
    color: colors.textPrimary,
    fontSize: typeScale.bodySmall,
    paddingVertical: spacing.sm,
  },
  emptySearchText: {
    ...textStyles.footnote,
    color: colors.textSecondary,
    fontWeight: fontWeight.regular,
  },
  // —— 虚拟化列表拼出的卡片三段 ——
  listCardTop: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderTopLeftRadius: radius.container,
    borderTopRightRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm,
    overflow: 'hidden',
  },
  listCardMiddle: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  listCardBottom: {
    backgroundColor: colors.surfaceElevated,
    borderBottomLeftRadius: radius.container,
    borderBottomRightRadius: radius.container,
    borderColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    height: radius.container,
    marginBottom: spacing.sm,
  },
  modalBackdrop: {
    alignItems: 'center',
    backgroundColor: colors.overlay,
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  modalCard: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 420,
    padding: spacing.lg,
    width: '100%',
  },
  modalTitle: {
    ...textStyles.title,
    color: colors.textPrimary,
    fontWeight: fontWeight.semibold,
    marginBottom: spacing.md,
  },
  fieldLabel: {
    ...textStyles.footnote,
    color: colors.textSecondary,
    fontWeight: fontWeight.medium,
    marginBottom: spacing.xs,
    marginTop: spacing.sm,
  },
  singleLineInput: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.textPrimary,
    fontSize: typeScale.bodySmall,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  multilineInput: {
    ...textStyles.bodySmall,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.textPrimary,
    minHeight: 88,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  fieldHint: {
    ...textStyles.footnote,
    color: colors.textSecondary,
    fontWeight: fontWeight.regular,
    marginTop: spacing.xs,
  },
  errorText: {
    ...textStyles.footnote,
    color: colors.errorText,
    fontWeight: fontWeight.regular,
    marginTop: spacing.sm,
  },
  modalActions: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
  },
  modalRightActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginLeft: 'auto',
  },
  secondaryButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.lg,
  },
  secondaryButtonText: {
    ...textStyles.body,
    color: colors.textPrimary,
    fontWeight: fontWeight.medium,
  },
  destructiveText: {
    ...textStyles.body,
    color: colors.destructive,
    fontWeight: fontWeight.medium,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.cta,
    borderRadius: radius.pill,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.lg,
  },
  primaryButtonPressed: {
    opacity: 0.85,
  },
  primaryButtonText: {
    ...textStyles.body,
    color: colors.ctaText,
    fontWeight: fontWeight.medium,
  },
});
