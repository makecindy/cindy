import { iconSize, spacing } from '@/theme';
import { Fragment, useEffect } from 'react';
import { Button, HStack, Image, Picker, ProgressView, RNHostView, Spacer, Text, TextField, Toggle, useNativeState } from '@expo/ui/swift-ui';
import { accessibilityLabel, alignmentGuide, buttonStyle, contentShape, shapes, disabled, font, foregroundStyle, frame, lineLimit, listRowInsets, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText, type RemoteActionField } from '@cindy/device-link';
import { View } from 'react-native';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { useTheme } from '@/theme';
import { ComposerSheet } from './ComposerSheet';
import { ComposerNativeSection as Section } from './ComposerNativeSection';
import type { CompanionProfileNativeViewProps } from './CompanionProfileNativeView';
import type { ProfilePanel, ProfileValues } from './companionProfileData';
import { CompanionPortraitPicker } from './CompanionPortraitPicker';
import { CompanionNativeContent } from './CompanionNativeContent.ios';

export function CompanionNativeField({ field, values, onChange, busy }: { field: RemoteActionField; values: ProfileValues; onChange(values: ProfileValues): void; busy: boolean }) {
  const { i18n } = useTranslation();
  const label = resolveRemoteText(field.label, i18n.language);
  const value = typeof values[field.id] === 'string' ? values[field.id] as string : '';
  const text = useNativeState(value);
  useEffect(() => { if (text.get() !== value) text.set(value); }, [value, text]);
  const update = (value: string | boolean) => onChange({ ...values, [field.id]: value });
  if (field.id === 'avatarImageBase64') return <Section title={label}><CompanionNativeContent><CompanionPortraitPicker value={value} onChange={update} disabled={busy} /></CompanionNativeContent></Section>;
  if (field.kind === 'toggle') return <Toggle label={label} isOn={values[field.id] === true} onIsOnChange={update} modifiers={[disabled(busy)]} />;
  if (field.kind === 'select') return <Picker label={label} selection={value} onSelectionChange={next => update(String(next))} modifiers={[pickerStyle('menu'), disabled(busy)]}>
    {(field.options ?? []).map(option => <Text key={option.value} modifiers={[tag(option.value)]}>{resolveRemoteText(option.label, i18n.language)}</Text>)}
  </Picker>;
  return <Section title={label}><TextField text={text} onTextChange={update} axis={field.kind === 'multiline' ? 'vertical' : 'horizontal'}
    maxLength={field.id === 'name' || field.id === 'confirmName' ? 200 : field.id === 'body' ? 55000 : 12000} testID={`companionProfile.field.${field.id}`}
    modifiers={[disabled(busy), accessibilityLabel(label), ...(field.kind === 'multiline' ? [lineLimit({ min: 3, max: 8 })] : [])]} /></Section>;
}
const AVATAR_SIZE = 48;
// SF Symbols have different intrinsic widths; the title column must not depend on the glyph.
const ROW_ICON_WIDTH = iconSize.xxl;
const ROW_GAP = spacing.md;
const Field = CompanionNativeField;

export function CompanionProfileNativeView(p: CompanionProfileNativeViewProps) {
  const { t, i18n } = useTranslation(); const { colors } = useTheme();
  const tr = (key: string) => t(`devices.companionProfile.${key}`, { deviceName: p.deviceName });
  const label = (value: Parameters<typeof resolveRemoteText>[0]) => resolveRemoteText(value, i18n.language);
  const note = (text: string, error = false) => <Section><Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(error ? colors.errorText : colors.textSecondary)]}>{text}</Text></Section>;
  const action = (text: string, press: () => void, blocked = false, destructive = false) => <Button onPress={press} modifiers={[buttonStyle('plain'), listRowInsets({ top: 4, bottom: 4, leading: 16, trailing: 16 }), disabled(blocked || p.busy), frame({ minHeight: 44 }), ...(destructive ? [foregroundStyle(colors.destructive)] : [])]}><HStack modifiers={[frame({ maxWidth: Infinity, minHeight: 44 }), contentShape(shapes.rectangle())]}><Text>{text}</Text><Spacer /></HStack></Button>;
  const row = (id: string, symbol: string, onPress = () => p.onOpen(id)) => <Button onPress={onPress} modifiers={[buttonStyle('plain'), listRowInsets({ top: 4, bottom: 4, leading: 16, trailing: 16 }), alignmentGuide('listRowSeparatorLeading', ROW_ICON_WIDTH + ROW_GAP)]} testID={`companionProfile.${id}`}>
    <HStack spacing={ROW_GAP} modifiers={[frame({ maxWidth: Infinity, minHeight: 44 }), contentShape(shapes.rectangle())]}><Image systemName={symbol as never} size={iconSize.action} modifiers={[foregroundStyle(colors.textSecondary), frame({ width: ROW_ICON_WIDTH })]} /><Text>{tr(id)}</Text><Spacer /><Image systemName="chevron.right" size={iconSize.xs} /></HStack>
  </Button>;
  const panel = (target?: ProfilePanel) => target?.action ? <>
    {target.id === 'capability' && target.text ? note(target.text) : null}
    {target.action.fields?.map(field => <Field key={field.id} field={field} values={p.values} onChange={p.onChange} busy={p.busy || !p.online || !!target.action?.disabled} />)}
    <Section>{action(tr('save'), () => p.onSubmit(target), !p.online || !p.dirty || p.conflict || !!target.action.disabled)}</Section>
  </> : note(target?.text || tr('hostUpgrade'));
  const home = <>
    <Section><HStack spacing={12} modifiers={[frame({ maxWidth: Infinity })]}>
      <RNHostView matchContents><View style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}><RemoteCompanionAvatar avatar={p.data?.resource.display.avatar ?? p.resource?.display.avatar} name={p.name} deviceId={p.deviceId} online={p.online} size={AVATAR_SIZE} /></View></RNHostView>
      <Text modifiers={[font({ textStyle: 'headline' }), lineLimit(2)]}>{p.name}</Text><Spacer />
    </HStack></Section>
    <Section>{row('profile', 'person.crop.circle')}{row('memory', 'brain')}{row('models', 'slider.horizontal.3')}{row('skills', 'sparkles')}</Section>
    <Section>{row('automation', 'clock', p.onAutomation)}{row('artifacts', 'doc.text')}{row('search', 'magnifyingglass', p.onSearch)}{row('permissions', 'hand.raised')}</Section>
    <Section>{p.data?.panels.filter(item => ['restart', 'resume', 'delete'].includes(item.id) && item.action).map(item => <Button key={item.id} onPress={() => p.onConfirm(item)} modifiers={[buttonStyle('plain'), listRowInsets({ top: 4, bottom: 4, leading: 16, trailing: 16 }), disabled(p.busy || !p.online), frame({ minHeight: 44 }), ...(item.id === 'delete' ? [foregroundStyle(colors.destructive)] : [])]}><HStack modifiers={[frame({ maxWidth: Infinity, minHeight: 44 }), contentShape(shapes.rectangle())]}><Text>{label(item.action!.label)}</Text><Spacer /></HStack></Button>)}</Section>
    {/* Same as Android: a host without the settings forms asks for a Cindy update on that computer. */}
    {p.online && p.data && !p.data.panels.some(item => item.id === 'profile') ? note(tr('hostUpgrade')) : null}
  </>;
  return <ComposerSheet visible={p.visible} title={p.title} onClose={p.onClose} onClosed={p.onClosed} onBack={p.onBack}
    nativeContent preventDismiss={p.dirty || p.busy || !!p.confirmation} testID="companionProfile">
    {!p.online ? note(tr('offline')) : null}
    {p.error ? <>{note(p.errorLabel || tr('readFailed'), true)}<Section>{action(t('devices.resources.retry'), p.onRetry, !p.online)}{p.dirty ? action(t('devices.companions.automation.discard'), () => p.onDiscard(false), false, true) : null}</Section></> : null}
    {p.conflict ? <>{note(tr('changed'), true)}<Section>{action(tr('discardAndReload'), () => p.onDiscard(true), false, true)}</Section></> : null}
    {p.receipt ? note(p.receipt) : null}
    {p.deleted ? <Section>{action(t('shared.closePanel'), p.onClose)}</Section> : p.confirmation?.action?.confirmation ? <>
      {note(label(p.confirmation.action.confirmation.body ?? p.confirmation.action.label))}
      {p.confirmation.action.fields?.map(field => <Field key={field.id} field={field} values={p.values} onChange={p.onChange} busy={p.busy || !p.online} />)}
      <Section>{action(label(p.confirmation.action.confirmation.confirmLabel ?? p.confirmation.action.label), () => p.onSubmit(p.confirmation!, true), !p.online || p.confirmation.id === 'delete' && p.values.confirmName !== p.name, p.confirmation.action.tone === 'destructive')}
        {action(t('devices.common.cancel'), () => p.onConfirm(null))}</Section>
      {p.busy ? <Section><ProgressView /></Section> : null}
    </> : p.page === 'home' ? home : p.loading ? <Section><ProgressView /></Section> : p.page === 'editor' ? p.panel ? <>{panel(p.panel)}{p.editor?.panels.filter(item => item.id === 'remove' && item.action).map(item => <Section key={item.id}>{action(label(item.action!.label), () => p.onConfirm(item), !p.online, true)}</Section>)}</> : <Section>{p.editor?.panels.flatMap(item => item.entries?.length ? item.entries.map(entry => <Fragment key={`${item.id}:${entry.resourceId}`}>{action(label(entry.title), () => p.onEditor(entry.resourceId))}</Fragment>) : [item.action ? <Fragment key={item.id}>{action(label(item.title ?? item.action.label), () => p.onEditorPanel(item))}</Fragment> : <Text key={item.id}>{item.text || tr('emptyEditor')}</Text>])}</Section>
      : p.page === 'models' ? <>{p.panel?.action ? <Section><CompanionNativeContent>{p.models}</CompanionNativeContent></Section> : null}{p.panel?.action ? <Section>{action(tr('save'), () => p.onSubmit(p.panel!), !p.dirty || !p.online || p.conflict)}</Section> : note(p.panel?.text || tr('hostUpgrade'))}</>
      : p.page === 'settings' ? <Section>{row('permissions', 'hand.raised')}</Section>
      : p.page === 'skills' ? <>{p.data?.panels.find(item => item.id === 'skills')?.entries?.length ? <Section>{row('personalSkills', 'sparkles')}</Section> : note(p.data?.panels.find(item => item.id === 'skills')?.text || tr('skillsEmpty'))}{p.data?.panels.find(item => item.id === 'connections')?.entries?.length ? <Section>{row('connections', 'link')}</Section> : note(p.data?.panels.find(item => item.id === 'connections')?.text || tr('emptyEditor'))}</>
      : p.page === 'artifacts' ? <Section><CompanionNativeContent>{p.artifacts}</CompanionNativeContent></Section> : p.page === 'memoryEntries' ? p.memoryPage
      : <>{p.page === 'profile' && p.data?.panels.find(item => item.id === 'avatar')?.entries?.length ? <Section>{row('avatar', 'person.crop.circle')}</Section> : null}{panel(p.panel)}
        {(p.page === 'profile' || p.page === 'memory') && p.panel && !p.panel.action ? note(tr('largeProfileRecovery')) : null}
        {p.page === 'memory' && p.data ? p.hasMemoryEntries ? <Section>{row('memoryEntries', 'brain')}</Section> : p.panel?.action ? note(tr('hostUpgrade')) : null : null}</>}
  </ComposerSheet>;
}
