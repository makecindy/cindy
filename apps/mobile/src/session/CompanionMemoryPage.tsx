import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { fontWeight, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
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

  if (m.view === 'list') {
    const showSearch = !!m.searchPanel && (m.groups.length > 0 || !!m.query);
    return <View style={styles.content}>
      {!memoryEnabled ? note(tr('memoryDisabled')) : null}
      {receipt}
      {showSearch ? <TextInput accessibilityLabel={tr('memorySearch')} value={m.query} onChangeText={m.setQuery} autoCorrect={false}
        placeholder={m.searchPanel?.placeholder ? resolveRemoteText(m.searchPanel.placeholder, i18n.language) : tr('memorySearch')}
        placeholderTextColor={colors.textTertiary} maxLength={200} returnKeyType="search" style={styles.input} /> : null}
      {m.listFailed ? <View accessibilityRole="alert" style={styles.stack}>{note(tr('memoryLoadFailed'), false, true)}
        <MainWindowActionButton action={{ label: t('devices.resources.retry'), disabled: !online, onPress: m.retry }} /></View>
        : !m.listLoaded ? (online ? note(t('devices.resources.loading')) : null)
        : m.groups.length ? m.groups.map(group => <View key={group.id} style={styles.stack} accessibilityLabel={group.title}>
          <Text accessibilityRole="header" style={styles.groupTitle}>{group.title}<Text style={styles.count}>{`  ${group.count}`}</Text></Text>
          <View style={[styles.group, !memoryEnabled && styles.dimmed]}>{group.entries.map((entry, index) =>
            <Pressable key={entry.resourceId} accessibilityRole="button" accessibilityLabel={entry.title} onPress={() => m.open(entry.resourceId)}
              style={({ pressed }) => [styles.row, index > 0 && styles.separator, pressed && styles.pressed]} testID={`companionMemory.${entry.id}`}>
              <View style={styles.rowHeader}>
                <Text numberOfLines={2} style={styles.rowTitle}>{entry.title}</Text>
                <Text style={styles.date}>{date(entry.timestamp)}</Text>
              </View>
              {entry.preview ? <Text numberOfLines={2} style={styles.preview}>{entry.preview}</Text> : null}
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
        : !detail ? note(t('devices.resources.loading'))
        : <>
          <View style={styles.stack}>
            <Text selectable accessibilityRole="header" style={styles.title}>{detail.title}</Text>
            <Text style={styles.note}>{[detail.kind, detail.timestamp !== undefined ? tr('memoryUpdated', { time: date(detail.timestamp, true) }) : ''].filter(Boolean).join(' · ')}</Text>
          </View>
          <Text selectable style={styles.body}>{detail.body}</Text>
          {m.deleteFailed ? note(tr('memoryDeleteFailed'), true) : null}
          <View style={styles.stack}>
            {detail.form?.action ? <MainWindowActionButton action={{ label: tr('memoryEdit'), disabled: m.busy || !online || detail.form.action.disabled, onPress: m.edit }} /> : null}
            {detail.remove?.action ? <MainWindowActionButton action={{ label: resolveRemoteText(detail.remove.action.label, i18n.language), tone: 'danger', busy: m.busy, disabled: !online || detail.remove.action.disabled, onPress: m.remove }} /> : null}
          </View>
        </>}
    </View>;
  }

  const editable = !m.busy && online && m.saveState !== 'conflict';
  return <View style={styles.content}>
    {m.missing ? note(tr('memoryMissing'), true) : null}
    {m.saveState === 'conflict' ? <View accessibilityRole="alert" style={[styles.group, styles.notice]}>
      <Text style={styles.heading}>{tr('memoryChanged', { name: botName })}</Text>
      {m.latest ? <Text selectable numberOfLines={8} style={styles.preview}>{m.latest.body}</Text> : null}
      <MainWindowActionButton action={{ label: tr('memoryUseLatest'), disabled: m.busy, onPress: m.useLatest }} />
      <MainWindowActionButton action={{ label: tr('memoryKeepMine'), disabled: m.busy || !online, onPress: m.keepMine }} />
    </View> : null}
    <View style={styles.field}>
      <Text style={styles.heading}>{companionMemoryFieldLabel(m.detail, 'title', i18n.language)}</Text>
      <TextInput accessibilityLabel={companionMemoryFieldLabel(m.detail, 'title', i18n.language)} value={m.draft.title} editable={editable}
        maxLength={COMPANION_MEMORY_TITLE_MAX} onChangeText={title => m.change({ title })} placeholderTextColor={colors.textTertiary} style={styles.input} />
    </View>
    <View style={styles.field}>
      <Text style={styles.heading}>{companionMemoryFieldLabel(m.detail, 'body', i18n.language)}</Text>
      <TextInput accessibilityLabel={companionMemoryFieldLabel(m.detail, 'body', i18n.language)} value={m.draft.body} editable={editable} multiline
        onChangeText={body => m.change({ body })} placeholderTextColor={colors.textTertiary} style={[styles.input, styles.multiline]} />
    </View>
    {m.tooLong ? note(tr('memoryTooLong'), true) : m.titleMissing || m.bodyMissing ? note(tr('memoryRequired')) : null}
    {m.saveState === 'saving' ? note(t('devices.resources.loading'))
      : m.saveState === 'saved' ? <Text accessibilityLiveRegion="polite" style={styles.note}>{m.receipt ?? tr('memorySaved')}</Text>
      : m.saveState === 'error' ? note(tr('memorySaveFailed'), true) : null}
    <MainWindowActionButton action={{ label: tr('memoryDone'), tone: 'primary', busy: m.busy,
      disabled: !online || m.saveState === 'conflict' || m.dirty && (m.titleMissing || m.bodyMissing || m.tooLong), onPress: () => { void m.done(); } }} />
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  // Rendered inside the settings sheet's padded content column.
  content: { gap: spacing.lg },
  stack: { gap: spacing.sm },
  field: { gap: spacing.sm },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: colors.textSecondary },
  error: { color: colors.errorText },
  heading: { fontSize: typeScale.body, color: colors.textPrimary, fontWeight: fontWeight.medium },
  title: { fontSize: typeScale.subtitle, lineHeight: lineHeight.subtitle, color: colors.textPrimary, fontWeight: fontWeight.medium },
  body: { fontSize: typeScale.body, lineHeight: lineHeight.bodyRelaxed, color: colors.textPrimary },
  groupTitle: { fontSize: typeScale.footnote, color: colors.textSecondary, fontWeight: fontWeight.medium, paddingHorizontal: spacing.xs },
  count: { color: colors.textTertiary, fontWeight: fontWeight.regular },
  group: { backgroundColor: colors.surfaceElevated, borderRadius: radius.container, overflow: 'hidden' },
  dimmed: { opacity: 0.6 },
  notice: { padding: spacing.lg, gap: spacing.sm },
  row: { minHeight: 44, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.xs },
  separator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  pressed: { opacity: 0.72 },
  rowHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  rowTitle: { flex: 1, fontSize: typeScale.listBody, lineHeight: lineHeight.listBody, color: colors.textPrimary, fontWeight: fontWeight.medium },
  date: { fontSize: typeScale.micro, lineHeight: lineHeight.listBody, color: colors.textTertiary },
  preview: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, color: colors.textSecondary },
  input: { minHeight: 44, borderRadius: radius.pill, borderColor: colors.border, borderWidth: 1, padding: spacing.md, color: colors.textPrimary, backgroundColor: colors.surfaceElevated, fontSize: typeScale.body },
  multiline: { minHeight: 180, borderRadius: radius.control, textAlignVertical: 'top' },
});
