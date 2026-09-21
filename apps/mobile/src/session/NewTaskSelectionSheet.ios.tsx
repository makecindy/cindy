import { Button, Image, ProgressView, Text, Toggle } from '@expo/ui/swift-ui';
import { disabled, font, foregroundStyle, frame } from '@expo/ui/swift-ui/modifiers';
import { useTranslation } from 'react-i18next';
import { iconSize, useTheme } from '@/theme';
import { ComposerSheet } from './ComposerSheet';
import { ComposerNativeRow } from './ComposerNativeRow';
import { ComposerNativeSection as Section } from './ComposerNativeSection';
import { newSessionText } from './newSessionMessages';
import { useNativeGlassButtonStyle } from "@/platform/chrome/nativeGlassButtonStyle.ios";
import type { NewTaskSelectionSheetProps } from './NewTaskSelectionSheet';

/** One full-width native presentation, including navigation into remote folders. */
export function NewTaskSelectionSheet(p: NewTaskSelectionSheetProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const glassStyle = useNativeGlassButtonStyle({ prominent: true });
  const browsing = p.page === 'directory';
  const unavailable = p.busy || p.loading;
  const icon = (name: 'laptopcomputer' | 'folder' | 'bubble.left' | 'folder.badge.plus' | 'chevron.right' | 'arrow.up') =>
    <Image systemName={name} size={iconSize.lg} />;
  return (
    <ComposerSheet
      visible={p.page !== null}
      onClose={p.onClose}
      onBack={browsing ? p.onBack : undefined}
      backLabel={t('shared.back')}
      title={t(p.page === 'device' ? 'session.new.selectControlledDevice' : browsing ? 'session.new.chooseOtherFolder' : 'session.new.selectWorkspace')}
      testID="newSession.selectionSheet"
      nativeContent
      footer={browsing ? (
        <Button
          onPress={() => { if (p.path && !unavailable && !p.error) p.onChoose(p.path); }}
          modifiers={[...glassStyle, disabled(unavailable || !p.path || !!p.error)]}
          testID="newSession.remoteBrowseSelectCurrent"
        >
          <Text modifiers={[frame({ maxWidth: Infinity, minHeight: 44 })]}>{t('session.new.useCurrent')}</Text>
        </Button>
      ) : undefined}
    >
      {p.page === 'device' ? <Section>
        {p.devices.map(device => <ComposerNativeRow key={device.deviceId}
          title={device.name || device.deviceId} leading={icon('laptopcomputer')}
          selected={device.deviceId === p.selectedDeviceId} disabled={p.busy}
          onPress={() => p.onDevice(device.deviceId)} testID="newSession.deviceOption" />)}
      </Section> : p.page === 'workspace' ? <>
        <Section>
          <ComposerNativeRow title={t('session.new.workspaceDialogue')} leading={icon('bubble.left')}
            selected={p.workspaceKind === 'dialogue'} disabled={p.busy}
            onPress={p.onDialogue} testID="newSession.workspaceDialogueOption" />
        </Section>
        {p.workspaces.length ? <Section>
          {p.workspaces.map(workspace => <ComposerNativeRow key={workspace.workingDir}
            title={workspace.title} subtitle={workspace.workingDir} leading={icon('folder')}
            selected={p.workspaceKind === 'project' && p.workingDir.trim() === workspace.workingDir}
            disabled={p.busy} onPress={() => p.onProject(workspace.workingDir)} testID="newSession.workspaceProjectOption" />)}
        </Section> : null}
        <Section>
          <ComposerNativeRow title={t('session.new.chooseOtherFolder')} leading={icon('folder.badge.plus')}
            accessory={icon('chevron.right')} disabled={p.busy} onPress={p.onBrowse} testID="newSession.workspaceBrowseOption" />
        </Section>
      </> : browsing ? <>
        <Section>
          <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.textSecondary)]}
            testID="newSession.remoteBrowseCurrentPath">{p.path || t('session.new.readingRemoteDir')}</Text>
          <ComposerNativeRow title={t('session.new.parentDir')} leading={icon('arrow.up')}
            disabled={!p.parent || unavailable} onPress={() => { if (p.parent) p.onEnter(p.parent); }}
            testID="newSession.remoteBrowseParentButton" />
          <Toggle label={newSessionText('showHiddenDirectories')} isOn={p.showHidden}
            onIsOnChange={p.onShowHidden} modifiers={[disabled(p.busy)]} testID="newSession.remoteBrowseShowHidden" />
        </Section>
        {p.loading ? <Section><ProgressView /></Section> : null}
        {p.error ? <Section><Text modifiers={[foregroundStyle(colors.errorText)]}>{p.error}</Text></Section> : null}
        <Section>
          {!p.loading && !p.error && p.entries.length === 0 ? <Text>{newSessionText('emptyDirectory')}</Text> : null}
          {p.entries.map(entry => <ComposerNativeRow key={entry.path} title={entry.name}
            leading={icon('folder')} accessory={icon('chevron.right')} disabled={unavailable}
            onPress={() => p.onEnter(entry.path)} testID="newSession.remoteBrowseEnterEntry" />)}
        </Section>
      </> : null}
    </ComposerSheet>
  );
}
