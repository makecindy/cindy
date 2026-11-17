import { mountPage, subscription } from '../../ui-page/harness';
import { DockIconPicker } from '../../../src/renderer/components/settings/DockIconPicker';
import { DEFAULT_APPEARANCE_SETTINGS } from '../../../src/shared/appearanceSettings';

// PR #9139: render the production controls/styles/Tip in Chromium. Host writes
// are isolated fixture data; native Dock updates and App root listeners are not
// exercised here. No existing UI fixture covers this new picker.
// Regression basis: DESIGN §14.2 / §14.6. The focus ring was already fixed;
// this round's baseline fails because keyboard/hover option names are absent.
// Minimal inputs: Tab into the
// selected option (focus shadow must differ), or hover an option (visible name).
// Tier: UI integration/e2e; real Chromium is needed for focus-visible, computed
// Tailwind shadows and Radix hover/focus behavior. Four Light/Dark variants ran
// in 8.7s via pnpm ui:check --page dock-icon-picker --case all --theme all.
void mountPage({
  host: (ctx) => ({
    appearanceSettings: {
      getSync: () => DEFAULT_APPEARANCE_SETTINGS,
      onChanged: subscription('appearanceChanged'),
      setPatch: async (patch: { appIcon: string }) => {
        ctx.data.savedIcon = patch.appIcon;
        return { ...DEFAULT_APPEARANCE_SETTINGS, ...patch };
      },
    },
  }),
  render: () => (
    <main className="p-8">
      <button type="button" data-ui-page-control data-testid="before-picker">
        Before
      </button>
      <DockIconPicker />
      <button type="button" data-ui-page-control data-testid="after-picker">
        After
      </button>
    </main>
  ),
});
