import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Host } from '@expo/ui';
import { BottomSheet, Button, Group, HStack, Image, RNHostView, ScrollView, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import { accessibilityLabel, background, buttonStyle, containerRelativeFrame, contentShape, disabled, fixedSize, font, foregroundStyle,
  frame, interactiveDismissDisabled, lineSpacing, multilineTextAlignment, onGeometryChange, opacity, padding,
  presentationDetents, presentationDragIndicator, scrollDismissesKeyboard, shapes, useScrollGeometryChange } from '@expo/ui/swift-ui/modifiers';
import { ActivityIndicator, Keyboard, View, useWindowDimensions } from 'react-native';
import { TextInput } from '@/components/AppText';
import { useNativeGlassButtonStyle } from '@/platform/chrome/nativeGlassButtonStyle.ios';
import { useTheme } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, typeScale } from '@/theme/tokens';
import { ChatInviteAvatar } from './ChatInviteAvatar';
import type { ChatInviteViewProps } from './ChatInviteView';

export function ChatInviteView({ visible, title, model, input, validity, message, otherInvitationMessage, primary }: ChatInviteViewProps) {
  const { colors, mode } = useTheme();
  const { t } = useTranslation();
  const { width, height, fontScale } = useWindowDimensions();
  const [scrollSize, setScrollSize] = useState({ width: 0, height: 0 });
  const [bodyHeight, setBodyHeight] = useState(0);
  const [footerSize, setFooterSize] = useState({ width: 0, height: 0 });
  const closeStyle = useNativeGlassButtonStyle({ shape: 'circle', size: 44 });
  const joining = model.phase === 'joining';
  const loading = model.phase === 'reading';
  const identity = !!model.preview && !input && !loading && (!model.error || model.error === 'uncertain');
  const edit = model.manual && !input && !loading;
  const hasFooter = !loading && !input;
  // iOS 26 floats the sheet with a presentation transform. Detents need local
  // layout sizes, not the scaled global CGRect exposed by onGeometryChange.
  const scrollGeometry = useScrollGeometryChange(size => {
    setScrollSize(previous => previous.width === size.containerWidth && previous.height === size.contentHeight
      ? previous : { width: size.containerWidth, height: size.contentHeight });
  });
  const footerHeight = footerSize.height * (scrollSize.width && footerSize.width ? scrollSize.width / footerSize.width : 1);
  const compactHeight = Math.max(loading ? 80 : 140, Math.ceil((scrollSize.height || bodyHeight) + (hasFooter ? footerHeight : 0)));
  const close = () => { if (!joining) { Keyboard.dismiss(); model.close(); } };
  const invokePrimary = () => { if (primary && !primary.busy && !primary.disabled) { Keyboard.dismiss(); primary.onPress(); } };
  const copy = (size: number, line: number, weight: 'regular' | 'medium' | 'semibold' = 'regular', secondary = true) => [
    font({ size: size * fontScale, weight }), lineSpacing(Math.max(0, line - size * 1.2) * fontScale),
    foregroundStyle(secondary ? colors.textSecondary : colors.textPrimary), fixedSize({ horizontal: false, vertical: true }),
  ];
  const note = copy(typeScale.footnote, lineHeight.caption);
  const action = primary ? (primary.busy ?
    // Keep joining progress at full contrast.
    <HStack spacing={8} testID="chatInvite.primary" modifiers={[frame({ maxWidth: Infinity, minHeight: 50 }), background(colors.cta, shapes.capsule()), accessibilityLabel(primary.label)]}>
      <RNHostView matchContents><View style={{ width: 20, height: 20 }} accessibilityElementsHidden><ActivityIndicator color={colors.ctaText} /></View></RNHostView>
      <Text modifiers={[font({ size: typeScale.body * fontScale, weight: 'medium' }), foregroundStyle(colors.ctaText)]}>{primary.label}</Text>
    </HStack> :
    <Button onPress={invokePrimary} testID="chatInvite.primary" modifiers={[buttonStyle('plain'), disabled(primary.disabled), opacity(primary.disabled ? 0.45 : 1)]}>
      <Text modifiers={[font({ size: typeScale.body * fontScale, weight: 'medium' }), foregroundStyle(colors.ctaText), multilineTextAlignment('center'),
        frame({ maxWidth: Infinity, minHeight: 50 }), background(colors.cta, shapes.capsule()), contentShape(shapes.capsule())]}>{primary.label}</Text>
    </Button>) : null;
  return <Host colorScheme={mode} seedColor={colors.textPrimary} pointerEvents="none" style={{ position: 'absolute' }}>
    <BottomSheet isPresented={visible} onIsPresentedChange={open => { if (!open && visible) close(); }} onDismiss={model.closed}>
      <Group modifiers={[presentationDetents(width > height || fontScale >= 1.35 ? ['large']
        : input ? [{ height: compactHeight }] : [{ height: compactHeight }, 'large']),
        presentationDragIndicator('visible'), interactiveDismissDisabled(joining)]}>
        <ZStack alignment="topTrailing" testID="chatInvite.sheet" modifiers={[containerRelativeFrame({ axes: 'horizontal' })]}>
          <VStack spacing={0} modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity })]}>
            <ScrollView showsIndicators={false} modifiers={[scrollDismissesKeyboard('interactively'), ...(scrollGeometry ? [scrollGeometry] : [])]}>
              <VStack alignment="leading" spacing={0} modifiers={[frame({ maxWidth: Infinity }),
                padding({ leading: 24, trailing: 24, top: identity ? 32 : input ? 16 : 20, bottom: input ? 8 : 16 }),
                onGeometryChange(size => setBodyHeight(size.height))]}>
                {identity && model.preview ? <>
                  <VStack spacing={0} modifiers={[frame({ maxWidth: Infinity }), padding({ leading: 28, trailing: 28 })]}>
                    <VStack spacing={0} modifiers={[padding({ bottom: 12 })]}><RNHostView matchContents><View style={{ width: 88, height: 88 }}><ChatInviteAvatar avatar={model.preview.avatar} members={model.preview.memberAvatars} /></View></RNHostView></VStack>
                    <Text modifiers={[...copy(typeScale.inviteTitle, lineHeight.listTitle, 'semibold', false), multilineTextAlignment('center')]}>{model.preview.name}</Text>
                    <Text modifiers={[...note, multilineTextAlignment('center'), padding({ top: 4 })]}>{model.preview.memberCount === undefined ? t('groupChat.invitation.countUnknown') : t('groupChat.memberCount', { count: model.preview.memberCount })}</Text>
                  </VStack>
                  <VStack spacing={4} modifiers={[frame({ maxWidth: Infinity }), padding({ top: 20 }), multilineTextAlignment('center')]}>
                    <Text modifiers={note}>{t('groupChat.invitation.invitedBy', { name: model.preview.inviterName })}</Text>
                    {validity ? <Text modifiers={note}>{validity}</Text> : null}
                  </VStack>
                </> : <HStack spacing={12} modifiers={[frame({ maxWidth: Infinity, minHeight: 44, alignment: 'leading' })]}>
                  {loading ? <RNHostView matchContents><View style={{ width: 20, height: 20 }}><ActivityIndicator color={colors.textSecondary} /></View></RNHostView> : null}
                  <Text modifiers={copy(input ? typeScale.body : typeScale.title, input ? lineHeight.body : lineHeight.title, 'semibold', false)}>{title}</Text>
                  <Spacer minLength={44} />
                </HStack>}
                {input ? <VStack spacing={0} modifiers={[padding({ top: 12 }), frame({ height: 62 })]}><RNHostView>
                  <View style={{ width: '100%', height: 50, paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: colors.surfaceElevated, borderWidth: 0.5, borderColor: colors.border }}>
                    <TextInput value={model.input} onChangeText={model.setInput} placeholder={t('groupChat.invitation.pasteLink')}
                      accessibilityLabel={t('groupChat.invitation.inviteLink')} placeholderTextColor={colors.textPlaceholder}
                      keyboardType="url" autoCapitalize="none" autoCorrect={false} spellCheck={false} clearButtonMode="while-editing"
                      returnKeyType="go" enablesReturnKeyAutomatically maxLength={8192}
                      onSubmitEditing={() => { if (model.input.trim()) invokePrimary(); }} testID="chatInvite.input"
                      style={{ flex: 1, padding: 0, fontSize: typeScale.bodyLarge, fontWeight: fontWeight.regular, color: colors.textPrimary }} />
                  </View>
                </RNHostView></VStack> : null}
                {message ? <Text testID="chatInvite.message" modifiers={[...note, frame({ maxWidth: Infinity, alignment: identity ? 'center' : 'leading' }),
                  multilineTextAlignment(identity ? 'center' : 'leading'), padding({ top: identity ? 12 : 8 })]}>{message}</Text> : null}
                {otherInvitationMessage ? <Text modifiers={[...note, frame({ maxWidth: Infinity }), multilineTextAlignment('center'), padding({ top: 12 })]}>{otherInvitationMessage}</Text> : null}
                {input ? <VStack spacing={0} modifiers={[padding({ top: 24 }), frame({ maxWidth: Infinity })]}>{action}</VStack> : null}
              </VStack>
            </ScrollView>
            {hasFooter ? <VStack spacing={4} modifiers={[padding({ leading: 24, trailing: 24, top: 8, bottom: 8 }),
              onGeometryChange(size => setFooterSize({ width: size.width, height: size.height }))]}>
              {action}
              {edit ? <Button onPress={model.edit} testID="chatInvite.edit" modifiers={[buttonStyle('plain'), disabled(joining)]}>
                <Text modifiers={[...copy(typeScale.bodySmall, lineHeight.bodySmall, 'medium', false), frame({ maxWidth: Infinity, minHeight: 44 }), contentShape(shapes.rectangle())]}>{t('groupChat.invitation.editLink')}</Text>
              </Button> : null}
            </VStack> : null}
          </VStack>
          <Button onPress={close} testID="chatInvite.close" modifiers={[...closeStyle, disabled(joining),
            foregroundStyle(colors.textPrimary), accessibilityLabel(t('devices.common.cancel')), padding({ top: 16, trailing: 16 })]}>
            <Image systemName="xmark" size={iconSize.md} />
          </Button>
        </ZStack>
      </Group>
    </BottomSheet>
  </Host>;
}
