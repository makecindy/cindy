import { mountPage } from '../../ui-page/harness';
import { ComposerSendShortcutSection } from '../../../src/renderer/components/settings/ComposerSendShortcutSection';

mountPage({
  host: (ctx) => {
    // Seed the local preferences exactly as the product stores them.
    if (ctx.data.followUp === 'steer') localStorage.setItem('chat.followUpBehavior', 'steer');
    else localStorage.removeItem('chat.followUpBehavior');
    if (ctx.data.sendKey === 'modifier-enter') localStorage.setItem('chat.sendShortcutPreference', 'modifier-enter');
    else localStorage.removeItem('chat.sendShortcutPreference');
    return { platform: 'darwin', voiceInput: { getDataSnapshot: () => ({ settings: { shortcut: null } }) } };
  },
  render: (ctx) => (
    <div className="mx-auto p-6" style={{ maxWidth: ctx.data.narrow ? 360 : 720 }}>
      <ComposerSendShortcutSection />
    </div>
  ),
});
