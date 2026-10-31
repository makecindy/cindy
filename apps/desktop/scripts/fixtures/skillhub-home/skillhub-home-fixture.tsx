import { AppFrame, mountPage, subscription } from '../../ui-page/harness';
import { SkillhubHomeContent } from '../../../src/renderer/features/skillhub/SkillhubHomeView';

mountPage({
  route: '/skillhub/local',
  host: () => ({
    authHasPersistedSessionHintSync: () => false,
    appearanceSettings: null,
    getFullscreenState: async () => false,
    onFullscreenChange: subscription('fullscreen'),
    setApplicationMenuLocale: async () => {},
    setUpdateRelaunchTheme: async () => {},
  }),
  render: () => (
    <AppFrame sidebar={<div className="p-4">Cindy</div>}>
      <SkillhubHomeContent />
    </AppFrame>
  ),
});
