import { Fragment, useEffect } from 'react';
import { Button, HStack, Image, ProgressView, Spacer, Text, TextField, VStack, useNativeState } from '@expo/ui/swift-ui';
import { accessibilityLabel, autocorrectionDisabled, buttonStyle, contentShape, disabled, font, foregroundStyle, frame, lineLimit, listRowInsets, shapes, textInputAutocapitalization, textSelection } from '@expo/ui/swift-ui/modifiers';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import { iconSize, spacing, useTheme } from '@/theme';
import { ComposerNativeSection as Section } from './ComposerNativeSection';
import type { CompanionMemoryPageProps } from './CompanionMemoryPage';
import { COMPANION_MEMORY_TITLE_MAX, companionMemoryDate, companionMemoryFieldLabel } from './useCompanionMemory';

/** Native owns the text while typing; a replaced draft remounts it through `draftGeneration`. */
function Field({ label, value, onChange, busy, multiline = false }: { label: string; value: string; onChange(value: string): void; busy: boolean; multiline?: boolean }) {
  const text = useNativeState(value);
  return <TextField text={text} onTextChange={onChange} axis={multiline ? 'vertical' : 'horizontal'} maxLength={multiline ? undefined : COMPANION_MEMORY_TITLE_MAX}
    testID={`companionMemory.field.${multiline ? 'body' : 'title'}`}
    modifiers={[accessibilityLabel(label), disabled(busy), ...(multiline ? [lineLimit({ min: 6, max: 16 })] : [])]} />;
}

function SearchField({ query, placeholder, label, clearLabel, onChange }: { query: string; placeholder: string; label: string; clearLabel: string; onChange(value: string): void }) {
  const text = useNativeState(query);
  useEffect(() => { if (text.get() !== query) text.set(query); }, [query, text]);
  return <HStack>
    <Image size={iconSize.lg} systemName="magnifyingglass" />
    <TextField text={text} onTextChange={onChange} placeholder={placeholder} testID="companionMemory.search"
      modifiers={[accessibilityLabel(label), autocorrectionDisabled(), textInputAutocapitalization('never'), frame({ maxWidth: Infinity })]} />
    {query ? <Button onPress={() => { text.set(''); onChange(''); }} modifiers={[buttonStyle('plain'), accessibilityLabel(clearLabel)]}>
      <Image size={iconSize.lg} systemName="xmark.circle.fill" modifiers={[frame({ width: 44, height: 44 }), contentShape(shapes.rectangle())]} />
    </Button> : null}
  </HStack>;
}

/** SwiftUI rendering of the saved-memories page inside the teammate settings Form. */
export function CompanionMemoryPage({ memory: m, online, botName, memoryEnabled }: CompanionMemoryPageProps) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const tr = (key: string, values?: Record<string, string>) => t(`devices.companionProfile.${key}`, values);
  const date = (timestamp: number | undefined, withTime = false) => companionMemoryDate(timestamp, i18n.language, tr('memoryToday'), withTime);
  const note = (text: string, error = false) => <Section><Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(error ? colors.errorText : colors.textSecondary), textSelection(error)]}>{text}</Text></Section>;
  const action = (label: string, onPress: () => void, blocked = false, destructive = false, testID?: string) => <Button onPress={onPress} testID={testID}
    modifiers={[buttonStyle('plain'), listRowInsets({ top: 4, bottom: 4, leading: 16, trailing: 16 }), disabled(blocked), frame({ minHeight: 44 }), ...(destructive ? [foregroundStyle(colors.destructive)] : [])]}>
    <HStack modifiers={[frame({ maxWidth: Infinity, minHeight: 44 }), contentShape(shapes.rectangle())]}><Text>{label}</Text><Spacer /></HStack>
  </Button>;
  const receipt = m.receipt ? note(m.receipt) : null;

  if (m.view === 'list') {
    const showSearch = !!m.searchPanel && (m.groups.length > 0 || !!m.query);
    return <>
      {!memoryEnabled ? note(tr('memoryDisabled')) : null}
      {receipt}
      {showSearch ? <Section><SearchField query={m.query} onChange={m.setQuery} label={tr('memorySearch')} clearLabel={t('devices.detail.search.clearA11y')}
        placeholder={m.searchPanel?.placeholder ? resolveRemoteText(m.searchPanel.placeholder, i18n.language) : tr('memorySearch')} /></Section> : null}
      {m.listFailed ? <>{note(tr('memoryLoadFailed'), true)}<Section>{action(t('devices.resources.retry'), m.retry, !online)}</Section></>
        : !m.listLoaded ? (online ? <Section><ProgressView /></Section> : null)
        : m.groups.length ? m.groups.map(group => <Section key={group.id} title={`${group.title} ${group.count}`}>
          {group.entries.map(entry => <Button key={entry.resourceId} onPress={() => m.open(entry.resourceId)} testID={`companionMemory.${entry.id}`}
            modifiers={[buttonStyle('plain'), accessibilityLabel(entry.title)]}>
            <HStack alignment="top" spacing={spacing.md} modifiers={[frame({ maxWidth: Infinity, minHeight: 44 }), contentShape(shapes.rectangle())]}>
              <VStack alignment="leading" spacing={spacing.xs}>
                <Text modifiers={[lineLimit(2), foregroundStyle(memoryEnabled ? colors.textPrimary : colors.textSecondary)]}>{entry.title}</Text>
                {entry.preview ? <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(colors.textSecondary), lineLimit(2)]}>{entry.preview}</Text> : null}
              </VStack>
              <Spacer />
              <Text modifiers={[font({ textStyle: 'caption2' }), foregroundStyle(colors.textTertiary)]}>{date(entry.timestamp)}</Text>
            </HStack>
          </Button>)}
        </Section>)
        : note(tr(m.query.trim() ? 'memoryNoResults' : 'memoryEmpty'))}
    </>;
  }

  if (m.view === 'detail') {
    const detail = m.detail;
    return <>
      {receipt}
      {m.changed ? note(tr('memoryChanged', { name: botName }), true) : null}
      {m.missing ? note(tr('memoryMissing'), true)
        : m.detailFailed ? <>{note(tr('memoryLoadFailed'), true)}<Section>{action(t('devices.resources.retry'), m.retry, !online)}</Section></>
        : !detail ? <Section><ProgressView /></Section>
        : <>
          <Section><VStack alignment="leading" spacing={spacing.sm} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>
            <Text modifiers={[font({ textStyle: 'headline' }), textSelection(true)]}>{detail.title}</Text>
            <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.textSecondary)]}>
              {[detail.kind, detail.timestamp !== undefined ? tr('memoryUpdated', { time: date(detail.timestamp, true) }) : ''].filter(Boolean).join(' · ')}
            </Text>
          </VStack></Section>
          <Section><Text modifiers={[textSelection(true)]}>{detail.body}</Text></Section>
          {m.deleteFailed ? note(tr('memoryDeleteFailed'), true) : null}
          <Section>
            {detail.form?.action ? action(tr('memoryEdit'), m.edit, m.busy || !online || !!detail.form.action.disabled, false, 'companionMemory.edit') : null}
            {detail.remove?.action ? action(resolveRemoteText(detail.remove.action.label, i18n.language), m.remove, m.busy || !online || !!detail.remove.action.disabled, true, 'companionMemory.delete') : null}
          </Section>
        </>}
    </>;
  }

  const blocked = m.busy || !online || m.saveState === 'conflict';
  const titleLabel = companionMemoryFieldLabel(m.detail, 'title', i18n.language);
  const bodyLabel = companionMemoryFieldLabel(m.detail, 'body', i18n.language);
  return <>
    {m.missing ? note(tr('memoryMissing'), true) : null}
    {m.saveState === 'conflict' ? <Section title={tr('memoryChanged', { name: botName })}>
      {m.latest ? <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.textSecondary), lineLimit(8), textSelection(true)]}>{m.latest.body}</Text> : null}
      {action(tr('memoryUseLatest'), m.useLatest, m.busy, false, 'companionMemory.useLatest')}
      {action(tr('memoryKeepMine'), m.keepMine, m.busy || !online, false, 'companionMemory.keepMine')}
    </Section> : null}
    <Fragment key={m.draftGeneration}>
      <Section title={titleLabel}><Field label={titleLabel} value={m.draft.title} onChange={title => m.change({ title })} busy={blocked} /></Section>
      <Section title={bodyLabel}><Field label={bodyLabel} value={m.draft.body} onChange={body => m.change({ body })} busy={blocked} multiline /></Section>
    </Fragment>
    {m.tooLong ? note(tr('memoryTooLong'), true) : m.titleMissing || m.bodyMissing ? note(tr('memoryRequired')) : null}
    {m.saveState === 'saving' ? <Section><ProgressView /></Section>
      : m.saveState === 'saved' ? note(m.receipt ?? tr('memorySaved'))
      : m.saveState === 'error' ? note(tr('memorySaveFailed'), true) : null}
    <Section>{action(tr('memoryDone'), () => { void m.done(); }, !online || m.busy || m.saveState === 'conflict' || m.dirty && (m.titleMissing || m.bodyMissing || m.tooLong), false, 'companionMemory.done')}</Section>
  </>;
}
