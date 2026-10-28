import { useTranslation } from 'react-i18next';
import { mountPage, subscription } from '../../ui-page/harness';
import { HudChrome } from '../../../src/renderer/features/hud/HudChrome';
import { HudSection } from '../../../src/renderer/components/settings/HudSection';
import { useHudScreenAttachment } from '../../../src/renderer/features/hud/useHudScreenAttachment';
import { DEFAULT_HUD_SETTINGS } from '../../../src/shared/hud';
function ScreenControls({ missingQuota = false }: { missingQuota?: boolean }) {
  const { t } = useTranslation();
  const summary = missingQuota
    ? t('hud.weeklyUnavailable')
    : t('todaySpend.codex.windowSegment', { label: t('todaySpend.codex.daysWindow', { days: 7 }), remaining: '61%' });
  const { control } = useHudScreenAttachment(
    'fixture', '/work/examples/a-long-project-path/current-task',
    <span className="text-12 tabular-nums">{summary}</span>,
  );
  return <div className="pt-12">{control}</div>;
}
void mountPage({
  route: '/cc-agent/hud-fixture',
  host: (ctx) => ({
    platform: ctx.platform,
    appShortcuts: {
      getState: () => ({
        platform: ctx.platform,
        overrides:
          ctx.case.startsWith('chrome')
            ? {
                'hud-toggle-pass-through': {
                  code: 'F12',
                  meta: true,
                  ctrl: true,
                  alt: true,
                  shift: true,
                },
              }
            : {},
      }),
      onChanged: subscription('shortcuts'),
    },
    hud: {
      get: async () => ({
        active: ctx.case !== 'entry',
        capturing: false,
        moving: false,
        layer: 1,
        passThrough: false,
        settings: DEFAULT_HUD_SETTINGS,
      }),
      onChanged: subscription('hud'),
      setPointerRegion: async () => {},
    },
  }),
  render: (ctx) => (
    <main className="relative h-full overflow-auto bg-background p-4">
      <HudChrome />
      {ctx.case.startsWith('chrome') && <ScreenControls missingQuota={ctx.case === 'chrome-no-quota'} />}
      {ctx.case === 'settings' || ctx.case === 'default' ? (
        <div className="pt-10">
          <HudSection />
        </div>
      ) : ctx.case === 'nested-panes' ? (
        <div className="hud-mode flex h-full flex-row" data-testid="hud-layout">
          <div
            data-layout-root-child-id="column"
            className="flex h-full flex-col"
            style={{ width: '60%' }}
          >
            <div data-layout-node-id="top" style={{ flexBasis: '40%' }}>
              <div data-panel-drag-root="tab-group:top">Top tool pane</div>
            </div>
            <div data-layout-node-id="chat" style={{ flexBasis: '60%' }}>
              <div data-panel-drag-root="chat-main" className="h-full" data-testid="hud-chat">
                Chat
              </div>
            </div>
          </div>
          <div data-panel-drag-root="tab-group:left">Left tool pane</div>
        </div>
      ) : null}
    </main>
  ),
});
