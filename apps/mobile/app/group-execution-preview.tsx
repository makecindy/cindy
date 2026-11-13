/** Development-only viewport fixture; mounts the production group screen unchanged.
 * cindy://group-execution-preview?width=320&groupId=execution-qa-work */
import { Redirect, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { GeometryContext, PaneViewportProvider, useAdaptiveWindow } from '@/platform/AdaptiveWindowContext';
import { BotGroupChatScreen } from '@/session/BotGroupChatScreen';
import { useTheme } from '@/theme';
import { MOBILE_VISUAL_MOCK_ENABLED } from '@/config/env';

export default function GroupExecutionPreview() {
  const params = useLocalSearchParams<{ width?: string; groupId?: string }>();
  const geometry = useAdaptiveWindow();
  const { colors } = useTheme();
  if (!MOBILE_VISUAL_MOCK_ENABLED) return <Redirect href="/" />;
  const width = Math.min(geometry.width, params.width === '393' ? 393 : 320);
  const groupId = ['execution-qa', 'execution-qa-work', 'execution-qa-talk'].includes(params.groupId ?? '') ? params.groupId! : 'execution-qa';
  return <View style={{ flex: 1, alignItems: 'center', backgroundColor: colors.surface }}>
    <View style={{ flex: 1, width }}>
      <GeometryContext.Provider value={{ ...geometry, width, regularWidth: false }}>
        <PaneViewportProvider value={{ x: (geometry.width - width) / 2, y: 0, width, height: geometry.height }}>
          <BotGroupChatScreen key={`${width}:${groupId}`} groupId={groupId} deviceId="cindy-visual-mock-mac" deviceName="" />
        </PaneViewportProvider>
      </GeometryContext.Provider>
    </View>
  </View>;
}
