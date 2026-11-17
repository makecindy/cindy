import { useAttachments } from '../../../src/renderer/hooks/useAttachments';
import { ChatInput } from '../../../src/renderer/components/new-chat/ChatInput';
import { ctx, mountPage, subscription } from '../../ui-page/harness';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';
if (!crypto.randomUUID) {
  let n = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}
void mountPage({
  route: "/chat/fixture-permission",
  host: {
    maker: {
      onDesktopCommandTriggered: subscription('command'),
      onSessionCredentialSwitchApplied: subscription('applied'),
      onSessionCredentialSwitchFailed: subscription('failed'),
      onPiPackagesChanged: subscription('packages'),
      listAgentSkills: async () => ({ success: true, skills: [] }),
      getSessionAgentSwitchIntent: async () => null,
      getPluginWriteAccessRecovery: async () => ({ available: false }),
    },
    voiceInput: {
      getDataSnapshot: () => ({ settings: { ...getDefaultVoiceInputSettings('darwin'), playInteractionSound: false } }),
      onDataChanged: subscription('voice'),
      getMicrophonePermissionCached: () => ({ ok: true, status: 'granted' }),
      onGlobalShortcutTrigger: subscription('shortcut'),
    },
    deviceLink: { onRemotePush: subscription('push') },
    ghosts: { listSync: () => ({ ghosts: [] }) },
  },
  render: () => <Fixture />,
});

function Fixture() {
  const attachments = useAttachments("fixture-permission");
  return <main className="flex h-screen flex-col justify-end bg-[var(--surface-base)] p-6 text-[var(--text-primary)]">
    <ChatInput attachmentState={attachments} sessionId={ctx.case === 'new-task' ? undefined : 'fixture-permission'}
      initialWorkingDir="/fixture" runtimeAgentKind="claude-code" vendorKey="cc"
      initialPermissionMode="bypassPermissions" showFolderPicker={false}
      disableAutofocus onSend={async () => true} />
  </main>;
}
