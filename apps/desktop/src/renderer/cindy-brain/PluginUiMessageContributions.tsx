import { useSessionFileOrigin } from '@/components/chat/ChatSessionFileContext';
import { originDeviceId } from '@/lib/sessionFileOrigin';
import { PluginUiContributionControls } from './PluginUiControls';
import { PluginUiCommandShortcuts } from './PluginUiCommandShortcuts';

export function PluginUiMessageContributions({ sessionId, messageClientId, turnAnchor }: {
  sessionId: string; messageClientId: string; turnAnchor?: string;
}) {
  const deviceId = originDeviceId(useSessionFileOrigin());
  return <>
    <PluginUiContributionControls sessionId={sessionId} deviceId={deviceId} point="message.actions" target={{ kind: 'message', id: messageClientId }} />
    {turnAnchor ? <PluginUiContributionControls sessionId={sessionId} deviceId={deviceId} point="turn.footer" target={{ kind: 'message', id: turnAnchor }} /> : null}
    <PluginUiCommandShortcuts sessionId={sessionId} deviceId={deviceId} entry="message" targetId={messageClientId} focusMessageId={messageClientId} />
    {turnAnchor ? <PluginUiCommandShortcuts sessionId={sessionId} deviceId={deviceId} entry="turn" targetId={turnAnchor} focusMessageId={messageClientId} /> : null}
  </>;
}
