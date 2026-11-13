import { Redirect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MOBILE_VISUAL_MOCK_ENABLED } from '@/config/env';
import { PluginCardActions } from '@/plugins/PluginCardActions';
import { PREVIEW_FIXTURE_PLUGIN } from '@/debug/pluginPreviewFixture';
import { useTheme } from '@/theme';

/** Development-only card-to-native-preview smoke test. No account or installed plugin. */
export default function PluginPreviewRegression() {
  const { colors } = useTheme();
  if (!MOBILE_VISUAL_MOCK_ENABLED) return <Redirect href="/" />;
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }}>
    <PluginCardActions deviceId="cindy-visual-mock-mac" sessionId="qa-preview" callId="qa-preview-card"
      text="Preview QA · Synthetic Host" data={{ pluginId: PREVIEW_FIXTURE_PLUGIN, revision: '1', items: [
        { id: 'editor', label: 'Local editor', disabled: false },
        { id: 'canvas', label: 'Local canvas', disabled: false },
      ] }} />
  </SafeAreaView>;
}
