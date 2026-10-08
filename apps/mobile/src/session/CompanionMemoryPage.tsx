import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Search, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { CompanionSettingsRow } from './CompanionSettingsRow';
import { COMPANION_MEMORY_TITLE_MAX, companionMemoryDate, companionMemoryFieldLabel, type CompanionMemoryState } from './useCompanionMemory';

export interface CompanionMemoryPageProps {
  memory: CompanionMemoryState;
  online: boolean;
  botName: string;
  memoryEnabled: boolean;
}

/** Android / default rendering of the saved-memories page; state lives in `useCompanionMemory`. */
export function CompanionMemoryPage({ memory: m, online, botName, memoryEnabled }: CompanionMemoryPageProps) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const tr = (key: string, values?: Record<string, string>) => t(`devices.companionProfile.${key}`, values);
  // Same as iOS: failures and conflicts read in the error colour; neutral states stay secondary.
  const note = (text: string, alert = false, error = alert) => <Text selectable accessibilityRole={alert ? 'alert' : undefined} style={[styles.note, error && styles.error]}>{text}</Text>;
  const date = (timestamp: number | undefined, withTime = false) => companionMemoryDate(timestamp, i18n.language, tr('memoryToday'), withTime);
  const receipt = m.receipt ? <Text accessibilityLiveRegion="polite" style={styles.note}>{m.receipt}</Text> : null;
  const spinner = <ActivityIndicator accessibilityLabel={t('devices.resources.loading')} color={colors.textSecondary} style={styles.spinner} />;
  // Text rows like the iOS form buttons; `busy` keeps the in-flight spinner on the acting row.
  const action = (label: string, onPress: () => void, blocked: boolean, testID: string, { destructive = false, busy = false } = {}) =>
    <CompanionSettingsRow icon={null} label={label} onPress={onPress} disabled={blocked} busy={busy} destructive={destructive} testID={testID} />;

  if (m.view === 'list') {
    const showSearch = !!m.searchPanel && (m.groups.length > 0 || !!m.query);
    return <View style={styles.content}>
      {!memoryEnabled ? note(tr('memoryDisabled')) : null}
      {receipt}
      {showSearch ? <View style={styles.search}>
        <Search color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
        <TextInput accessibilityLabel={tr('memorySearch')} value={m.query} onChangeText={m.setQuery} autoCorrect={false} autoCapitalize="none" testID="companionMemory.search"
          placeholder={m.searchPanel?.placeholder ? resolveRemoteText(m.searchPanel.placeholder, i18n.language) : tr('memorySearch')}
          placeholderTextColor={colors.textPlaceholder} returnKeyType="search" style={styles.searchInput} />
        {m.query ? <Pressable accessibilityRole="button" accessibilityLabel={t('devices.detail.search.clearA11y')} hitSlop={spacing.xs} onPress={() => m.setQuery('')}
          style={({ pressed }) => [styles.clear, pressed && styles.pressed]} testID="companionMemory.searchClear">
          <X color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
        </Pressable> : null}
      </View> : null}
      {m.listFailed ? <View accessibilityRole="alert" style={styles.stack}>{note(tr('memoryLoadFailed'), false, true)}
        <MainWindowActionButton action={{ label: t('devices.resources.retry'), disabled: !online, onPress: m.retry }} /></View>
        : !m.listLoaded ? (online ? spinner : null)
        : m.groups.length ? m.groups.map(group => <View key={group.id} style={styles.stack} accessibilityLabel={group.title}>
          <Text accessibilityRole="header" style={styles.groupTitle}>{group.title}<Text style={styles.count}>{`  ${group.count}`}</Text></Text>
          <View style={styles.group}>{group.entries.map((entry, index) =>
            <Pressable key={entry.resourceId} accessibilityRole="button" accessibilityLabel={entry.title} onPress={() => m.open(entry.resourceId)}
              style={({ pressed }) => [styles.row, index > 0 && styles.separator, pressed && styles.pressed]} testID={`companionMemory.${entry.id}`}>
              <View style={styles.rowText}>
                {/* Memory off: saved memories stay readable; only the title steps back, as on iOS. */}
                <Text numberOfLines={2} style={[styles.rowTitle, !memoryEnabled && styles.rowTitleOff]} testID={`companionMemory.${entry.id}.title`}>{entry.title}</Text>
                {entry.preview ? <Text numberOfLines={2} style={styles.preview}>{entry.preview}</Text> : null}
              </View>
              <Text style={styles.date}>{date(entry.timestamp)}</Text>
            </Pressable>)}
          </View>
        </View>)
        : note(tr(m.query.trim() ? 'memoryNoResults' : 'memoryEmpty'))}
    </View>;
  }

  if (m.view === 'detail') {
    const detail = m.detail;
    return <View style={styles.content}>
      {receipt}
      {m.changed ? note(tr('memoryChanged', { name: botName }), true) : null}
      {m.missing ? note(tr('memoryMissing'), true)
        : m.detailFailed ? <View accessibilityRole="alert" style={styles.stack}>{note(tr('memoryLoadFailed'), false, true)}
          <MainWindowActionButton action={{ label: t('devices.resources.retry'), disabled: !online, onPress: m.retry }} /></View>
        : !detail ? spinner
        : <>
          <View style={styles.stack}>
            <Text selectable accessibilityRole="header" style={styles.title}>{detail.title}</Text>
            <Text style={styles.note}>{[detail.kind, detail.timestamp !== undefined ? tr('memoryUpdated', { time: date(detail.timestamp, true) }) : ''].filter(Boolean).join(' · ')}</Text>
          </View>
          <Text selectable style={styles.body}>{detail.body}</Text>
          {m.deleteFailed ? note(tr('memoryDeleteFailed'), true) : null}
          {detail.form?.action || detail.remove?.action ? <View style={styles.actions}>
            {detail.form?.action ? action(tr('memoryEdit'), m.edit, m.busy || !online || !!detail.form.action.disabled, 'companionMemory.edit') : null}
            {detail.remove?.action ? action(resolveRemoteText(detail.remove.action.label, i18n.language), m.remove, m.busy || !online || !!detail.remove.action.disabled, 'companionMemory.delete', { destructive: true, busy: m.busy }) : null}
          </View> : null}
        </>}
    </View>;
  }

  const editable = !m.busy && online && m.saveState !== 'conflict';
  return <View style={styles.content}>
    {m.missing ? note(tr('memoryMissing'), true) : null}
    {m.saveState === 'conflict' ? <View accessibilityRole="alert" style={[styles.group, styles.notice]}>
      <Text style={styles.heading}>{tr('memoryChanged', { name: botName })}</Text>
      {m.latest ? <Text selectable numberOfLines={8} style={styles.preview}>{m.latest.body}</Text> : null}
      {action(tr('memoryUseLatest'), m.useLatest, m.busy, 'companionMemory.useLatest')}
      {action(tr('memoryKeepMine'), m.keepMine, m.busy || !online, 'companionMemory.keepMine')}
    </View> : null}
    <View style={styles.field}>
      <Text style={styles.heading}>{companionMemoryFieldLabel(m.detail, 'title', i18n.language)}</Text>
      <TextInput accessibilityLabel={companionMemoryFieldLabel(m.detail, 'title', i18n.language)} value={m.draft.title} editable={editable}
        maxLength={COMPANION_MEMORY_TITLE_MAX} onChangeText={title => m.change({ title })} placeholderTextColor={colors.textPlaceholder} style={styles.input} />
    </View>
    <View style={styles.field}>
      <Text style={styles.heading}>{companionMemoryFieldLabel(m.detail, 'body', i18n.language)}</Text>
      <TextInput accessibilityLabel={companionMemoryFieldLabel(m.detail, 'body', i18n.language)} value={m.draft.body} editable={editable} multiline
        onChangeText={body => m.change({ body })} placeholderTextColor={colors.textPlaceholder} style={[styles.input, styles.multiline]} />
    </View>
    {m.tooLong ? note(tr('memoryTooLong'), true) : m.titleMissing || m.bodyMissing ? note(tr('memoryRequired')) : null}
    {m.saveState === 'saving' ? spinner
      : m.saveState === 'saved' ? <Text accessibilityLiveRegion="polite" style={styles.note}>{m.receipt ?? tr('memorySaved')}</Text>
      : m.saveState === 'error' ? note(tr('memorySaveFailed'), true) : null}
    <View style={styles.actions}>{action(tr('memoryDone'), () => { void m.done(); }, !online || m.busy || m.saveState === 'conflict' || m.dirty && (m.titleMissing || m.bodyMissing || m.tooLong),
      'companionMemory.done')}</View>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  // Rendered inside the settings sheet's padded content column.
  content: { gap: spacing.lg },
  stack: { gap: spacing.sm },
  field: { gap: spacing.sm },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: colors.textSecondary },
  error: { color: colors.errorText },
  heading: { fontSize: typeScale.body, lineHeight: lineHeight.body, color: colors.textPrimary, fontWeight: fontWeight.medium },
  title: { fontSize: typeScale.subtitle, lineHeight: lineHeight.subtitle, color: colors.textPrimary, fontWeight: fontWeight.medium },
  body: { fontSize: typeScale.body, lineHeight: lineHeight.bodyRelaxed, color: colors.textPrimary },
  groupTitle: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: colors.textTertiary, fontWeight: fontWeight.semibold, paddingHorizontal: spacing.xs },
  count: { color: colors.textTertiary, fontWeight: fontWeight.regular },
  group: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.container, overflow: 'hidden' },
  actions: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.container, overflow: 'hidden', paddingHorizontal: spacing.lg },
  notice: { padding: spacing.lg, gap: spacing.sm },
  row: { minHeight: 44, flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md },
  rowText: { flex: 1, gap: spacing.xs },
  separator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  pressed: { opacity: 0.72 },
  spinner: { paddingVertical: spacing.md },
  search: { alignItems: 'center', backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderRadius: radius.pill, borderWidth: 1, flexDirection: 'row', gap: spacing.sm, minHeight: 44, paddingLeft: spacing.lg, paddingRight: spacing.xs },
  searchInput: { flex: 1, minWidth: 0, paddingVertical: spacing.sm, color: colors.textPrimary, fontSize: typeScale.body },
  clear: { alignItems: 'center', justifyContent: 'center', width: 36, height: 36 },
  rowTitle: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, color: colors.textPrimary, fontWeight: fontWeight.medium },
  rowTitleOff: { color: colors.textSecondary },
  date: { fontSize: typeScale.micro, lineHeight: lineHeight.bodySmall, color: colors.textTertiary },
  preview: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: colors.textSecondary },
  input: { minHeight: 44, borderRadius: radius.pill, borderColor: colors.border, borderWidth: 1, padding: spacing.md, color: colors.textPrimary, backgroundColor: colors.surfaceElevated, fontSize: typeScale.body },
  multiline: { minHeight: 180, borderRadius: radius.control, textAlignVertical: 'top' },
});
