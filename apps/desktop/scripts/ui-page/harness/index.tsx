// Browser side of `pnpm ui:check`. A page fixture calls `mountPage()` once; the harness
// applies the product's own appearance bootstrap (main-entry.tsx), mounts the product
// providers and reports readiness. It never imports auth, stores, agent runtimes or IPC.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'harmonyos-sans-sc-webfont-splitted';
import '../../../src/renderer/themes/colors';
import '../../../src/renderer/styles/sortable.css';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../../../src/renderer/i18n';
import { themeService } from '../../../src/renderer/themes/theme-service';
import { getInitialThemeVariant, ThemeProvider } from '../../../src/renderer/hooks/useTheme';
import {
  applyFontSettings,
  FontSettingsProvider,
  getInitialFontSettings,
} from '../../../src/renderer/hooks/useFontSettings';
import { LocaleProvider } from '../../../src/renderer/hooks/useLocale';
import { ConfirmDialogProvider } from '../../../src/renderer/components/ui/confirm-dialog-provider';
import { Tooltip } from '../../../src/renderer/components/ui/tooltip';
import { FeatureSidebarSlotProvider } from '../../../src/renderer/features/feature-context';
import { ContentHeaderSlot } from '../../../src/renderer/components/layout/ContentHeader';
import { registerHost } from './host';
import type { UiPageContext, UiPageRuntime } from './types';

export { forbid, registerHost, subscription } from './host';
export type { UiPageContext } from './types';

const runtime = (window as unknown as { __uiPage: UiPageRuntime }).__uiPage;
export const ctx: UiPageContext = runtime.ctx;

export interface PageDefinition {
  /** Host APIs for this scenario. Missing paths resolve to undefined and are reported. */
  host?: Record<string, unknown> | ((ctx: UiPageContext) => Record<string, unknown>);
  /** Extra JSON-safe cases for ad-hoc entries (`--entry`); registered pages declare cases in ui-page.mjs. */
  cases?: string[];
  /** Initial MemoryRouter entries; omit for components that do not use routing. */
  route?: string;
  render: (ctx: UiPageContext) => ReactNode;
}

const requestedKeys = new Set<string>();

/** Report keys that only resolve through the fallback language for the active locale. */
function trackMissingTranslations(): void {
  const translator = (i18n as unknown as { translator?: { translate: Function } }).translator;
  if (!translator) return;
  const original = translator.translate.bind(translator);
  translator.translate = (
    keys: string | string[],
    options?: Record<string, unknown>,
    ...rest: unknown[]
  ) => {
    const list = (Array.isArray(keys) ? keys : [keys]).filter((key) => typeof key === 'string');
    for (const key of list) requestedKeys.add(key);
    const lng = (options?.lng as string | undefined) ?? i18n.language;
    if (
      list.length &&
      !list.some((key) => i18n.exists(key, { ...options, lng, fallbackLng: false }))
    ) {
      const entry = `${lng}:${list[0]}`;
      if (!runtime.missingTranslations.includes(entry)) runtime.missingTranslations.push(entry);
    }
    return original(keys, options, ...rest);
  };
}

export async function mountPage(definition: PageDefinition): Promise<void> {
  if (definition.cases?.length && !definition.cases.includes(ctx.case)) {
    // Ad-hoc entries: the runner's `default` case means the first declared case.
    if (ctx.case !== 'default')
      throw new Error(`Unknown case "${ctx.case}"; declared: ${definition.cases.join(', ')}`);
    ctx.case = definition.cases[0];
  }
  runtime.cases = definition.cases;
  if (definition.host)
    registerHost(typeof definition.host === 'function' ? definition.host(ctx) : definition.host);
  // Same order as main-entry.tsx: theme and fonts before the first React render.
  themeService.applyTheme(getInitialThemeVariant().theme);
  applyFontSettings(getInitialFontSettings());
  await i18n.changeLanguage(ctx.locale);
  trackMissingTranslations();
  runtime.t = (key, options) => i18n.t(key, options) as string;
  // Lets the audit tell a rendered translation key from ordinary dotted text.
  runtime.isTranslationKey = (text) => requestedKeys.has(text) || i18n.exists(text);
  const content = definition.render(ctx);
  createRoot(document.getElementById('root')!).render(
    <ThemeProvider syncWindowVibrancy={false}>
      <FontSettingsProvider>
        <LocaleProvider>
          <ConfirmDialogProvider>
            <Tooltip.Provider>
              {definition.route ? (
                <MemoryRouter initialEntries={[definition.route]}>{content}</MemoryRouter>
              ) : (
                content
              )}
            </Tooltip.Provider>
          </ConfirmDialogProvider>
        </LocaleProvider>
      </FontSettingsProvider>
    </ThemeProvider>,
  );
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  runtime.ready = true;
  document.documentElement.dataset.uiPageReady = '1';
}

interface AppFrameProps {
  /** Sidebar content; omit to render the collapsed-sidebar layout. */
  sidebar?: ReactNode;
  sidebarWidth?: number;
  /** Render the product ContentHeader shell (feature header content is injected by the page). */
  header?: boolean;
  children?: ReactNode;
}

/**
 * Window layout mirror. Classes are copied from MainLayout (root row and chat main) and
 * Sidebar (expanded aside); 260px is useSidebarResize's default width. Only the page
 * subject inside is under test — keep these in sync when those files change.
 */
export function AppFrame({ sidebar, sidebarWidth = 260, header = true, children }: AppFrameProps) {
  return (
    <FeatureSidebarSlotProvider isCollapsed={!sidebar}>
      <div
        data-ui-frame="window"
        className="relative flex h-screen bg-content-area text-foreground"
      >
        {sidebar ? (
          <aside
            data-ui-frame="sidebar"
            style={{ width: sidebarWidth }}
            className="relative flex shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar"
          >
            {sidebar}
          </aside>
        ) : null}
        <main
          data-ui-frame="content"
          className="relative flex min-w-[400px] flex-1 flex-col overflow-hidden bg-content-area"
        >
          {header ? (
            <ContentHeaderSlot
              sidebarVisible={Boolean(sidebar)}
              showCollapsedActions={!sidebar}
              isSidebarRail={false}
              rightSidebarAvailable={false}
            >
              {children}
            </ContentHeaderSlot>
          ) : (
            children
          )}
        </main>
      </div>
    </FeatureSidebarSlotProvider>
  );
}
