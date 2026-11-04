import { useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { BotGroupChatScreen } from '@/session/BotGroupChatScreen';
import { BotGroupPaneLayout } from '@/session/BotGroupPaneLayout';

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

/**
 * A group chat on one computer (docs/product-rules/bot-group-chat.md §8). Opened from the
 * teammates page or a 分工 notification (`/companions/groups/<groupId>?deviceId=<id>`),
 * which carries no computer name; the screen then shows the id until the group loads.
 */
export default function BotGroupChatRoute() {
  const params = useLocalSearchParams<{ groupId?: string | string[]; deviceId?: string | string[]; deviceName?: string | string[]; messageId?: string | string[]; threadRootId?: string | string[]; notificationResponse?: string | string[] }>();
  const { accountGeneration } = useAuth();
  const groupId = firstParam(params.groupId);
  const deviceId = firstParam(params.deviceId);
  return <BotGroupPaneLayout><BotGroupChatScreen key={`${accountGeneration}:${deviceId}:${groupId}:${firstParam(params.threadRootId)}`} groupId={groupId} deviceId={deviceId}
    threadRootId={firstParam(params.threadRootId) || undefined} deviceName={firstParam(params.deviceName)} messageId={firstParam(params.messageId)} notificationResponse={firstParam(params.notificationResponse)} /></BotGroupPaneLayout>;
}
