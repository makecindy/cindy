import { Button, HStack, Spacer, ProgressView, Text, TextField, useNativeState } from '@expo/ui/swift-ui';
import { accessibilityLabel, buttonStyle, contentShape, shapes, disabled, font, foregroundStyle, frame } from '@expo/ui/swift-ui/modifiers';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import { ComposerSheet } from './ComposerSheet';
import { ComposerNativeSection as Section } from './ComposerNativeSection';
import { CompanionPortraitPicker } from './CompanionPortraitPicker';
import { CompanionNativeContent } from './CompanionNativeContent.ios';
import type { CompanionCreateNativeViewProps } from './CompanionCreateNativeView';

export function CompanionCreateNativeView(p: CompanionCreateNativeViewProps) {
  const { t } = useTranslation(); const { colors } = useTheme();
  const name = typeof p.values.name === 'string' ? p.values.name : '';
  const state = useNativeState(name);
  useEffect(() => { if (state.get() !== name) state.set(name); }, [name, state]);
  const tr = (key: string) => t(`devices.companionProfile.${key}`, { deviceName: p.deviceName });
  return <ComposerSheet visible={p.visible} onClose={p.onClose} onClosed={p.onClosed} title={tr('create')} nativeContent preventDismiss={p.dirty || p.busy}>
    {!p.online || p.error ? <Section><Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.textSecondary)]}>{tr(!p.online ? 'offline' : p.nameTaken ? 'nameTaken' : 'createFailed')}</Text></Section> : null}
    {p.loading ? <Section><ProgressView /></Section> : null}
    {p.panel ? <>
      <Section title={tr('name')}><TextField text={state} onTextChange={name => p.onChange({ ...p.values, name })} maxLength={200} testID="companionCreate.name" modifiers={[accessibilityLabel(tr('name')), disabled(p.busy || !p.online)]} /></Section>
      <Section title={tr('avatar')}><CompanionNativeContent><CompanionPortraitPicker value={String(p.values.avatarImageBase64 ?? '')} onChange={avatarImageBase64 => p.onChange({ ...p.values, avatarImageBase64 })} disabled={p.busy || !p.online} /></CompanionNativeContent></Section>
    </> : null}
    <Section>{!p.panel && !p.loading && p.online ? <Button onPress={p.onRetry} modifiers={[buttonStyle('plain'), disabled(p.busy), frame({ minHeight: 44 })]}><HStack modifiers={[frame({ maxWidth: Infinity, minHeight: 44 }), contentShape(shapes.rectangle())]}><Text>{t('devices.resources.retry')}</Text><Spacer /></HStack></Button> : null}
      <Button onPress={p.onSubmit} testID="companionCreate.submit" modifiers={[buttonStyle('plain'), frame({ minHeight: 44 }), disabled(p.busy || !p.online || !p.panel?.action || p.panel.action.disabled || !name.trim() || !p.values.avatarImageBase64)]}><HStack modifiers={[frame({ maxWidth: Infinity, minHeight: 44 }), contentShape(shapes.rectangle())]}><Text>{tr('create')}</Text><Spacer /></HStack></Button>
      <Button onPress={p.onClose} modifiers={[buttonStyle('plain'), frame({ minHeight: 44 }), disabled(p.busy)]}><HStack modifiers={[frame({ maxWidth: Infinity, minHeight: 44 }), contentShape(shapes.rectangle())]}><Text>{t('devices.common.cancel')}</Text><Spacer /></HStack></Button>
    </Section>
  </ComposerSheet>;
}
