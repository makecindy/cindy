import { lazy, Suspense, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@/components/ui/spinner';
import { useDelayedPluginLoading } from './lib/useDelayedPluginLoading';

type PluginPageLoader = () => Promise<{ default: ComponentType }>;

function PluginRouteLoading() {
  const { t } = useTranslation();
  const showLoading = useDelayedPluginLoading(true);
  if (!showLoading) return null;
  return (
    <div role="status" className="flex flex-1 items-center justify-center gap-3 text-12 text-[var(--text-tertiary)]">
      <Spinner />
      <span>{t('ccAgent.common.loading')}</span>
    </div>
  );
}

export function createGhostPluginRoute(importPage: PluginPageLoader) {
  let pageRequest: ReturnType<PluginPageLoader> | undefined;
  const loadPage = () => (pageRequest ??= importPage());
  const PluginPage = lazy(loadPage);

  function preloadPluginPage() {
    // An intent alone must not show an error. Navigation observes the same
    // rejected promise and lets the existing section error boundary render it.
    if (!pageRequest) void loadPage().catch(() => {});
  }

  function GhostPluginRoute() {
    // The route can commit the location and retire the old outlet before the
    // plugin chunk resolves. The page and its dependencies stay split.
    return <Suspense fallback={<PluginRouteLoading />}><PluginPage /></Suspense>;
  }

  return { GhostPluginRoute, preloadPluginPage };
}

export const { GhostPluginRoute, preloadPluginPage } = createGhostPluginRoute(() =>
  import('./GhostPluginPage').then(({ GhostPluginPage }) => ({ default: GhostPluginPage })),
);
