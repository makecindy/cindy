import { useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { BotGroupChatScreen } from '@/session/BotGroupChatScreen';

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

/**
 * A group chat on one computer (docs/product-rules/bot-group-chat.md §8). Opened from the
 * teammates page or a 分工 notification (`/companions/groups/<groupId>?deviceId=<id>`),
 * which carries no computer name; the screen then shows the id until the group loads.
 */
export default function BotGroupChatRoute() {
  const params = useLocalSearchParams<{ groupId?: string | string[]; deviceId?: string | string[]; deviceName?: string | string[] }>();
  const { accountGeneration } = useAuth();
  const groupId = firstParam(params.groupId);
  const deviceId = firstParam(params.deviceId);
  return <BotGroupChatScreen key={`${accountGeneration}:${deviceId}:${groupId}`} groupId={groupId} deviceId={deviceId}
    deviceName={firstParam(params.deviceName)} />;
}
